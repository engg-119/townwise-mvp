# The self-hosted CI runner (infra/README.md, "CI on the laptop runner" and "CI on camo"): a GitHub Actions runner
# for Linux, run as one container per job and discarded afterwards, by run-runners.sh on the owner's Mac (arm64) and
# camo-runners.sh on camo (amd64). Build context is infra/ci-runner/. It builds for the engine's own architecture
# (BuildKit's TARGETARCH): arm64 or amd64, each with its own pins below. On Docker Desktop the runner user reaches
# the Docker socket through group 0; on camo, camo-runners.sh adds the socket's group with --group-add.
#checkov:skip=CKV_DOCKER_2:the container runs one job and exits; run-runners.sh waits on its exit, so there is nothing for a health check to restart

# Ubuntu 24.04, the noble-20261024.1 tag (Docker Hub, 2026-10-29), pinned by its multi-arch index digest.
FROM ubuntu:noble-20261024.1@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Set by BuildKit to the engine's architecture; anything but arm64 or amd64 stops the build at the first case below.
ARG TARGETARCH
# The runner user's uid. On Docker Desktop any uid works (it maps file ownership); on camo it must be the uid that
# owns the job folders on the host (camo-runners.sh passes its own).
ARG RUNNER_UID=1001

# apt reads fixed states of the Ubuntu archive, and every package is pinned to its version there (bump procedure:
# infra/ci-runner/README.md). `apt-get update --snapshot` does not help on arm64: it rewrites only archive.ubuntu.com
# and security.ubuntu.com, so it silently reads the live ports.ubuntu.com. The sources are written out instead.
#
# First, ca-certificates (to reach the snapshot service over HTTPS) from the noble release pocket only, which has
# not changed since the release (its InRelease is dated 2024-04-25): ports.ubuntu.com serves arm64, archive.ubuntu.com
# amd64.
RUN case "$TARGETARCH" in \
      arm64) release_uri=http://ports.ubuntu.com/ubuntu-ports/ ;; \
      amd64) release_uri=http://archive.ubuntu.com/ubuntu/ ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && printf '%s\n' 'Types: deb' "URIs: $release_uri" 'Suites: noble' 'Components: main' \
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' > /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates=20240203 openssl=3.0.13-0ubuntu3 \
 && rm -rf /var/lib/apt/lists/*

# Then the archive as it was at 2026-11-04 00:00 UTC (snapshot.ubuntu.com serves both under /ubuntu/), signed with
# the same Ubuntu archive key. What the jobs call on the runner itself (infra/ci-runner/README.md lists them per
# job): git for actions/checkout and gitleaks, curl, unzip, tar and gzip for the tool downloads and the setup
# actions, xz-utils for Node archives, jq for the gitleaks canary, python3 with venv for id-token-guard. Then what
# the runner's installdependencies.sh installs (ICU, Kerberos, LTTng, OpenSSL, zlib), so the script finds them
# present. coreutils (sha256sum) is in the base image.
RUN printf '%s\n' 'Types: deb' 'URIs: https://snapshot.ubuntu.com/ubuntu/20261104T000000Z/' \
      'Suites: noble noble-updates noble-security' 'Components: main universe' \
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' > /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates=20260816ubuntu0.24.04.1 openssl=3.0.13-0ubuntu3.16 \
      curl=8.5.0-2ubuntu10.16 git=1:2.43.0-1ubuntu7.4 gzip=1.12-1ubuntu3.2 jq=1.7.1-3ubuntu0.24.04.2 \
      python3=3.12.3-0ubuntu2.1 python3-venv=3.12.3-0ubuntu2.1 tar=1.35+dfsg-3ubuntu0.4 unzip=6.0-28ubuntu4.1 \
      xz-utils=5.6.1+really5.4.5-1ubuntu0.4 \
      libicu74=74.2-1ubuntu3.1 libkrb5-3=1.20.1-6ubuntu2.10 liblttng-ust1t64=2.13.7-1.1ubuntu2 \
      libssl3t64=3.0.13-0ubuntu3.16 zlib1g=1:1.3.dfsg-3.1ubuntu2.3 \
 && rm -rf /var/lib/apt/lists/*

# The Docker CLI 29.9.3 and buildx 0.38.1 (docker build in the lab job; docker run for semgrep and checkov), from
# Docker's apt repository. Each SHA-256 is the one its Packages index publishes
# (https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-<arch>/Packages), which InRelease signs with
# Docker's release key, fingerprint 9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88.
RUN case "$TARGETARCH" in \
      arm64) cli_sum=50682d7b5f8beab16f69de1ed638691863fef622661e533132031af32cc7b1ee \
             buildx_sum=784d31ae2129fda200fd0effe6a3004cd87af3fa1834734d32dc7b55efda2bf4 ;; \
      amd64) cli_sum=24f78a893cece8d345c4e90b5163907c047b996b747265f873743e8b0b0546d4 \
             buildx_sum=642e9a8a0d115a8a57ad7045a4c7c2561522331197f0c087a762de1b72591672 ;; \
    esac \
 && curl -fsSL -o /tmp/docker-ce-cli.deb \
      "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/$TARGETARCH/docker-ce-cli_29.9.3-1~ubuntu.24.04~noble_$TARGETARCH.deb" \
 && curl -fsSL -o /tmp/docker-buildx-plugin.deb \
      "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/$TARGETARCH/docker-buildx-plugin_0.38.1-1~ubuntu.24.04~noble_$TARGETARCH.deb" \
 && printf '%s  %s\n' "$cli_sum" /tmp/docker-ce-cli.deb "$buildx_sum" /tmp/docker-buildx-plugin.deb \
    | sha256sum -c - \
 && dpkg -i /tmp/docker-ce-cli.deb /tmp/docker-buildx-plugin.deb \
 && rm /tmp/docker-ce-cli.deb /tmp/docker-buildx-plugin.deb

# The GitHub Actions runner 2.338.2 for linux-arm64 or linux-x64, SHA-256 from the release notes' "SHA-256
# Checksums" (https://github.com/actions/runner/releases/tag/v2.338.2), then its own dependency installer, which
# finds every library already installed above (it reads the same snapshot). The entrypoint copies this folder into
# each job's folder.
RUN case "$TARGETARCH" in \
      arm64) runner_arch=arm64 runner_sum=670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945 ;; \
      amd64) runner_arch=x64 runner_sum=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40 ;; \
    esac \
 && curl -fsSL -o /tmp/actions-runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-$runner_arch-2.338.2.tar.gz" \
 && echo "$runner_sum  /tmp/actions-runner.tar.gz" | sha256sum -c - \
 && mkdir /opt/actions-runner \
 && tar -xzf /tmp/actions-runner.tar.gz -C /opt/actions-runner --no-same-owner \
 && rm /tmp/actions-runner.tar.gz \
 && /opt/actions-runner/bin/installdependencies.sh \
 && rm -rf /var/lib/apt/lists/*

# Docker Desktop's socket is root:root 0660 inside containers, so the runner user joins group 0 to use it. The base
# image's own user (ubuntu, uid 1000) gives way when RUNNER_UID asks for its uid.
RUN existing="$(getent passwd "$RUNNER_UID" | cut -d: -f1 || true)" \
 && if [ -n "$existing" ]; then userdel --remove "$existing"; fi \
 && useradd --uid "$RUNNER_UID" --create-home --shell /bin/bash --groups 0 runner
COPY --chmod=0755 entrypoint.sh /usr/local/bin/townwise-ci-entrypoint

# Tools the setup actions download (Node, Terraform, uv) stay in the container instead of the shared job folder.
ENV RUNNER_TOOL_CACHE=/home/runner/_tool
USER runner
WORKDIR /home/runner
ENTRYPOINT ["/usr/local/bin/townwise-ci-entrypoint"]
