# Laptop CI runner

Runs the checks in `ci.yml`, `security.yml` and `gitleaks.yml` on the owner's Mac while GitHub-hosted runners are unavailable. Never `deploy.yml`. Why, how to start, stop and switch back, and the security notes: `infra/README.md`, "CI on the laptop runner".

- `Dockerfile`: Ubuntu 24.04 for arm64 with the GitHub Actions runner, the Docker CLI and buildx, and what the jobs call. Each pin names its source.
- `entrypoint.sh`: copies the runner into the job folder (mounted at the same path as on the Mac) and runs exactly one job.
- `run-runners.sh`: builds the image, keeps N slots of one-job runners, and cleans up on Ctrl-C. One session at a time; each start removes what earlier sessions left.

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

## Pins and how to bump them

Everything the image installs is pinned. Bump on a branch, rebuild with `docker build --no-cache -t townwise-ci-runner:local infra/ci-runner`, and run the checks on it before merging. As elsewhere in the repository, take only releases at least 7 days old.

- **Ubuntu packages.** apt reads the archive as it was at one moment, from `snapshot.ubuntu.com` (`URIs: https://snapshot.ubuntu.com/ubuntu/<timestamp>/`, which serves arm64), and every package is pinned to its version there. The snapshot is HTTPS, so `ca-certificates` and `openssl` come first from the noble release pocket on `ports.ubuntu.com`, which has not changed since the release. `apt-get update --snapshot` is not used: on arm64 it does not rewrite `ports.ubuntu.com`, so it silently reads the live archive. To bump: choose a new timestamp, then list the versions there and copy them into the `apt-get install` line:

  ```sh
  docker run --rm --user 0 --entrypoint bash townwise-ci-runner:local -c '
    sed -i "s|/ubuntu/[0-9TZ]*/|/ubuntu/<new timestamp>/|" /etc/apt/sources.list.d/ubuntu.sources && apt-get update -qq &&
    apt-cache policy ca-certificates openssl curl git gzip jq python3 python3-venv tar unzip xz-utils \
      libicu74 libkrb5-3 liblttng-ust1t64 libssl3t64 zlib1g | grep -E "^[a-z]|Candidate"'
  ```

- **The GitHub Actions runner.** A just-in-time runner cannot be started with `--disableupdate` (`run` accepts only `--once`, `--jitconfig` and `--startuptype`). So when GitHub releases a newer runner, each job's runner downloads it into its job folder and updates itself before taking the job: it still works, it only costs the download, and that download is not covered by a pin here. GitHub stops assigning jobs to a runner more than 63 days behind. To bump: take the new version's `actions-runner-linux-arm64-<version>.tar.gz` SHA-256 from its release notes ("SHA-256 Checksums", `https://github.com/actions/runner/releases/tag/v<version>`), change the version and the SHA-256 in the Dockerfile, and rebuild. If the new runner needs other libraries, its `installdependencies.sh` fails in the build: add them to the pinned `apt-get install` line.
- **The Docker CLI and buildx.** From Docker's apt repository: take each `.deb`'s SHA-256 from `https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-arm64/Packages` (signed by `InRelease`, key fingerprint `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`).
- **The base image.** A dated `ubuntu:noble-*` tag by its multi-arch index digest (`docker buildx imagetools inspect ubuntu:<tag>`).
