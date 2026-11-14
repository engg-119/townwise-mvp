#!/usr/bin/env bash
# The runner container's entrypoint: runs exactly one GitHub Actions job, then exits. run-runners.sh starts it with
#   TOWNWISE_JIT_CONFIG  the encoded just-in-time runner config (a credential for one ephemeral runner)
#   TOWNWISE_JOB_DIR     a fresh, empty folder on the Mac, bind-mounted at the same absolute path
# The runner is copied into TOWNWISE_JOB_DIR and run from there, so GITHUB_WORKSPACE is a real Mac path: the
# Docker daemon resolves `docker run -v "$GITHUB_WORKSPACE:/src"` (semgrep, checkov) against the Mac, not this
# container, and finds the checkout there.
set -euo pipefail

if [ -z "${TOWNWISE_JIT_CONFIG:-}" ]; then
  echo "entrypoint: TOWNWISE_JIT_CONFIG is not set" >&2
  exit 64
fi
job_dir="${TOWNWISE_JOB_DIR:-}"
case "$job_dir" in
  /*) ;;
  *) echo "entrypoint: TOWNWISE_JOB_DIR must be an absolute path" >&2; exit 64 ;;
esac
if ! mountpoint -q "$job_dir"; then
  echo "entrypoint: $job_dir is not a mount; start this container with -v \"\$TOWNWISE_JOB_DIR:\$TOWNWISE_JOB_DIR\"" >&2
  exit 64
fi
if [ -n "$(ls -A "$job_dir")" ]; then
  echo "entrypoint: $job_dir is not empty; each job needs a fresh folder" >&2
  exit 64
fi

mkdir "$job_dir/runner"
cp -R /opt/actions-runner/. "$job_dir/runner/"

# The runner reads its arguments from ACTIONS_RUNNER_INPUT_* variables and removes them from its own environment,
# so the config never reaches a command line or a job step's environment. --jitconfig makes the runner ephemeral:
# it takes one job, and GitHub removes its registration afterwards.
ACTIONS_RUNNER_INPUT_JITCONFIG="$TOWNWISE_JIT_CONFIG"
export ACTIONS_RUNNER_INPUT_JITCONFIG
unset TOWNWISE_JIT_CONFIG
exec "$job_dir/runner/run.sh"
