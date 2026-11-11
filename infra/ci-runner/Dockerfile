# The laptop CI runner (infra/README.md, "CI on the laptop runner"): a GitHub Actions runner for Linux arm64,
# run by run-runners.sh as one container per job and discarded afterwards. Build context is infra/ci-runner/.
# Docker Desktop on Apple Silicon only: the runner user reaches the Docker socket through group 0, which is how
# Docker Desktop exposes it inside containers.
#checkov:skip=CKV_DOCKER_2:the container runs one job and exits; run-runners.sh waits on its exit, so there is nothing for a health check to restart

# Ubuntu 24.04, the noble-20261024.1 tag (Docker Hub, 2026-10-29), pinned by its multi-arch index digest.
FROM ubuntu:noble-20261024.1@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# What the jobs call on the runner itself (infra/ci-runner/README.md lists them per job): git for
# actions/checkout and gitleaks, curl, unzip, tar and gzip for the tool downloads and the setup actions, xz-utils
# for Node archives, jq for the gitleaks canary, python3 with venv for id-token-guard. coreutils (sha256sum) is
# in the base image.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git gzip jq python3 python3-venv tar unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# The Docker CLI 29.9.3 and buildx 0.38.1 (docker build in the lab job; docker run for semgrep and checkov), from
# Docker's apt repository. Each SHA-256 is the one its Packages index publishes
# (https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-arm64/Packages), which InRelease signs with
# Docker's release key, fingerprint 9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88.
RUN curl -fsSL -o /tmp/docker-ce-cli.deb \
      https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/arm64/docker-ce-cli_29.9.3-1~ubuntu.24.04~noble_arm64.deb \
 && curl -fsSL -o /tmp/docker-buildx-plugin.deb \
      https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/arm64/docker-buildx-plugin_0.38.1-1~ubuntu.24.04~noble_arm64.deb \
 && printf '%s  %s\n' \
      50682d7b5f8beab16f69de1ed638691863fef622661e533132031af32cc7b1ee /tmp/docker-ce-cli.deb \
      784d31ae2129fda200fd0effe6a3004cd87af3fa1834734d32dc7b55efda2bf4 /tmp/docker-buildx-plugin.deb \
    | sha256sum -c - \
 && dpkg -i /tmp/docker-ce-cli.deb /tmp/docker-buildx-plugin.deb \
 && rm /tmp/docker-ce-cli.deb /tmp/docker-buildx-plugin.deb

# The GitHub Actions runner 2.338.2 for linux-arm64, SHA-256 from the release notes' "SHA-256 Checksums"
# (https://github.com/actions/runner/releases/tag/v2.338.2), then its own dependency installer (ICU, OpenSSL,
# Kerberos, LTTng, zlib from the Ubuntu archive). The entrypoint copies this folder into each job's folder.
RUN curl -fsSL -o /tmp/actions-runner.tar.gz \
      https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-arm64-2.338.2.tar.gz \
 && echo "670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945  /tmp/actions-runner.tar.gz" | sha256sum -c - \
 && mkdir /opt/actions-runner \
 && tar -xzf /tmp/actions-runner.tar.gz -C /opt/actions-runner --no-same-owner \
 && rm /tmp/actions-runner.tar.gz \
 && /opt/actions-runner/bin/installdependencies.sh \
 && rm -rf /var/lib/apt/lists/*

# Docker Desktop's socket is root:root 0660 inside containers, so the runner user joins group 0 to use it.
RUN useradd --uid 1001 --create-home --shell /bin/bash --groups 0 runner
COPY --chmod=0755 entrypoint.sh /usr/local/bin/townwise-ci-entrypoint

# Tools the setup actions download (Node, Terraform, uv) stay in the container instead of the shared job folder.
ENV RUNNER_TOOL_CACHE=/home/runner/_tool
USER runner
WORKDIR /home/runner
ENTRYPOINT ["/usr/local/bin/townwise-ci-entrypoint"]
