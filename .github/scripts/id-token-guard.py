#!/usr/bin/env python3
"""Fail unless the only GitHub OIDC grant in the workflows is jobs.deploy in deploy.yml, and every job in
deploy.yml runs on a GitHub-hosted runner or on the one self-hosted deploy runner, camo (DEPLOY_SELF_HOSTED).

It parses every workflow with a real YAML parser (PyYAML, hash-pinned in id-token-guard-requirements.txt), so
every spelling counts that YAML resolves to the same thing: complex keys (? id-token / : write), escapes
("id\\x2dtoken"), a value on the next line, tags (!!str write-all), anchors and merge keys. It rejects:
- id-token with any value but none, or permissions: write-all, at workflow level in any file;
- the same at job level in any job except jobs.deploy of deploy.yml;
- jobs.deploy calling a reusable workflow (uses:), which would pass the token on;
- any job in deploy.yml whose runs-on is not exactly one allowed GitHub-hosted label (GITHUB_HOSTED), or exactly
  the list DEPLOY_SELF_HOSTED: no expression (the other workflows read CI_RUNS_ON, which can point at the laptop
  runner), no other self-hosted label (the laptop's included), no other ubuntu-* name a self-hosted runner could
  carry, no other list or group, no reusable workflow. On a shared self-hosted Docker host a build job could reach
  the deploy job's container (infra/README.md, "CI on the laptop runner"); the owner accepted that for camo's
  dedicated deploy runner while GitHub-hosted runners are unavailable (2026-11-18, infra/README.md, "Deploys on
  camo"), and for no other host;
- duplicate keys, more than one document, and anything it cannot parse or does not understand.
The server-side control is the deploy identity's federated credential, which matches job_workflow_ref
(infra/README.md, step 12). Usage: id-token-guard.py [workflows directory]
"""
import sys
from pathlib import Path

import yaml

ALLOWED_FILE = "deploy.yml"
ALLOWED_JOB = "deploy"
# An allowlist, not a pattern: a self-hosted runner could be given any ubuntu-* label. Add a label here only for a
# GitHub-hosted image deploy.yml moves to.
GITHUB_HOSTED = frozenset({"ubuntu-24.04"})
# The deploy runner on camo carries this label alone (infra/README.md, "Deploys on camo"); matched as this exact
# list, in this order, so no label can be added to it.
DEPLOY_SELF_HOSTED = ["self-hosted", "townwise-deploy"]


class Loader(yaml.SafeLoader):
    """SafeLoader that refuses duplicate keys, which parsers resolve differently."""


def _mapping(loader, node, deep=False):
    loader.flatten_mapping(node)
    seen = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=True)
        try:
            duplicate = key in seen
        except TypeError:
            raise yaml.constructor.ConstructorError(None, None, "a key that is not a scalar", key_node.start_mark)
        if duplicate:
            raise yaml.constructor.ConstructorError(None, None, f"duplicate key {key!r}", key_node.start_mark)
        seen.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep=deep)


Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


def _norm(value):
    return value.strip().lower() if isinstance(value, str) else value


def _values(mapping, name):
    """Every value whose key is `name`, ignoring case, so Permissions and permissions both count."""
    return [value for key, value in mapping.items() if _norm(key) == name]


def grants_token(permissions):
    if permissions is None:
        return False
    if isinstance(permissions, str):
        return _norm(permissions) == "write-all"
    if isinstance(permissions, dict):
        for key, value in permissions.items():
            if not isinstance(key, str):
                return True
            if _norm(key) == "id-token" and _norm(value) != "none":
                return True
        return False
    return True  # a list, number or anything else: not understood, so not allowed


def check(path, relative):
    problems = []
    try:
        documents = list(yaml.load_all(path.read_text(encoding="utf-8"), Loader=Loader))
    except (yaml.YAMLError, UnicodeDecodeError) as err:
        return [f"cannot parse ({type(err).__name__})"]
    if len(documents) != 1 or not isinstance(documents[0], dict):
        return ["not a single YAML mapping"]
    workflow = documents[0]
    if any(grants_token(p) for p in _values(workflow, "permissions")):
        problems.append("workflow-level permissions grant id-token")
    for jobs in _values(workflow, "jobs"):
        if not isinstance(jobs, dict):
            problems.append("jobs is not a mapping")
            continue
        for job_id, job in jobs.items():
            if not isinstance(job, dict):
                problems.append(f"job {job_id!r} is not a mapping")
                continue
            if relative == ALLOWED_FILE:
                runs_on = _values(job, "runs-on")
                hosted = len(runs_on) == 1 and isinstance(runs_on[0], str) and runs_on[0] in GITHUB_HOSTED
                camo = len(runs_on) == 1 and runs_on[0] == DEPLOY_SELF_HOSTED
                if not (hosted or camo):
                    problems.append(f"job {job_id!r} in {ALLOWED_FILE} runs on neither {' or '.join(sorted(GITHUB_HOSTED))}"
                                    f" nor {DEPLOY_SELF_HOSTED}")
            if not any(grants_token(p) for p in _values(job, "permissions")):
                continue
            if relative != ALLOWED_FILE or job_id != ALLOWED_JOB:
                problems.append(f"job {job_id!r} requests id-token")
            elif _values(job, "uses"):
                problems.append(f"job {job_id!r} passes its id-token to a reusable workflow (uses:)")
    return problems


def main(argv):
    root = Path(argv[1] if len(argv) > 1 else ".github/workflows")
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in (".yml", ".yaml"))
    if not files:
        print(f"::error::no workflows found under {root}")
        return 1
    failed = False
    for path in files:
        relative = path.relative_to(root).as_posix()
        for problem in check(path, relative):
            print(f"::error file={path}::{problem}; only jobs.{ALLOWED_JOB} in {ALLOWED_FILE} may request id-token,"
                  f" and {ALLOWED_FILE} runs only on GitHub-hosted runners or camo's deploy runner")
            failed = True
    if not failed:
        print(f"id-token-guard: {len(files)} workflows; only jobs.{ALLOWED_JOB} in {ALLOWED_FILE} requests id-token, and"
              f" every job in {ALLOWED_FILE} runs on {' or '.join(sorted(GITHUB_HOSTED))} or {DEPLOY_SELF_HOSTED}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
