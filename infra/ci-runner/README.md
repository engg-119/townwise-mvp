# Laptop CI runner

Runs the checks in `ci.yml`, `security.yml` and `gitleaks.yml` on the owner's Mac while GitHub-hosted runners are unavailable. Never `deploy.yml`. Why, how to start, stop and switch back, and the security notes: `infra/README.md`, "CI on the laptop runner".

- `Dockerfile`: Ubuntu 24.04 for arm64 with the GitHub Actions runner, the Docker CLI and buildx, and what the jobs call. Each pin names its source.
- `entrypoint.sh`: copies the runner into the job folder (mounted at the same path as on the Mac) and runs exactly one job.
- `run-runners.sh`: builds the image, keeps N slots of one-job runners, and cleans up on Ctrl-C.

What each job needs from the runner. When a job changes, keep the image in step:

| Job | Uses on the runner |
|---|---|
| verify | git (checkout); setup-node, which downloads Node 24 for linux-arm64 (curl, tar); npm; the Docker socket for testcontainers (Mongo, Valkey, Azurite, reached at `host.docker.internal`) |
| terraform | setup-terraform (unzip); curl, sha256sum and unzip for tflint; network for the providers and the tflint ruleset; linux_arm64 hashes in each `.terraform.lock.hcl` |
| id-token-guard | python3 with venv and pip; the PyYAML aarch64 wheel hash in `id-token-guard-requirements.txt` |
| lab | setup-uv (tar); Python 3.12 (the image's) for `uv sync`; `docker build` (buildx) |
| osv-scanner | curl, sha256sum |
| semgrep, checkov | `docker run -v "$GITHUB_WORKSPACE:/src"`, which needs the same-path job folder |
| gitleaks | git with full history, curl, sha256sum, tar and gzip, jq |
