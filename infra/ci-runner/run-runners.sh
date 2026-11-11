#!/usr/bin/env bash
# Runs the repository's CI checks on this Mac (infra/README.md, "CI on the laptop runner"). Each slot keeps one
# ephemeral runner waiting for a job: a just-in-time registration with the labels self-hosted and townwise-laptop,
# and a fresh container that takes one job and is removed with its job folder; then the slot starts another.
# Ctrl-C stops every slot: it removes the containers and job folders, and asks GitHub to remove each registration
# of this session that is still there (one that never took a job).
#
# Usage: infra/ci-runner/run-runners.sh [-n slots] [-i image]
#   -n  jobs at a time (default 2)
#   -i  run this image tag instead of building infra/ci-runner/Dockerfile
# Needs Docker Desktop on Apple Silicon, jq, and gh signed in as an admin of the repository (generate-jitconfig
# requires admin). The runner config stays in shell variables and the container's environment: it is never
# printed, written to a file or put on a command line.
set -euo pipefail

repo=engg-119/engg-119-mvp
here="$(cd "$(dirname "$0")" && pwd)"
# Under /Users, which Docker Desktop shares with the VM, so a job folder has the same path on the Mac, in the
# runner container and in any container a job starts with docker run -v.
jobs="$HOME/.townwise-ci/jobs"

slots=2
image=''
while getopts 'n:i:' opt; do
  case "$opt" in
    n) slots="$OPTARG" ;;
    i) image="$OPTARG" ;;
    *) echo "usage: $0 [-n slots] [-i image]" >&2; exit 2 ;;
  esac
done
case "$slots" in
  '' | *[!0-9]* | 0) echo "slots must be a whole number above 0" >&2; exit 2 ;;
esac

for tool in docker gh jq; do
  command -v "$tool" > /dev/null || { echo "$tool is required" >&2; exit 1; }
done
if [ "$(docker info --format '{{.Architecture}}' 2> /dev/null)" != aarch64 ]; then
  echo "needs Docker Desktop running on Apple Silicon (docker info reports no aarch64 engine)" >&2
  exit 1
fi
if ! gh auth status --hostname github.com > /dev/null 2>&1; then
  echo "gh is not signed in: run gh auth login" >&2
  exit 1
fi

if [ -z "$image" ]; then
  image=townwise-ci-runner:local
  docker build -t "$image" "$here"
fi

mkdir -p "$jobs"
session="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
prefix="townwise-laptop-$session"
count=0
for s in $(seq 1 "$slots"); do
  name[s]=''; rid[s]=''; dir[s]=''; started[s]=0; not_before[s]=0
done

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

# Removes a slot's container, its registration if GitHub still has it, and its job folder.
clear_slot() {
  local s="$1"
  if [ -n "${name[s]}" ]; then docker rm -f "${name[s]}" > /dev/null 2>&1 || true; fi
  # After a job GitHub has already removed the ephemeral runner (404); otherwise this removes a registration
  # that never took a job.
  if [ -n "${rid[s]}" ]; then gh api -X DELETE "repos/$repo/actions/runners/${rid[s]}" > /dev/null 2>&1 || true; fi
  case "${dir[s]}" in
    "$jobs/$prefix-"*) rm -rf -- "${dir[s]}" ;;
  esac
  name[s]=''; rid[s]=''; dir[s]=''
}

start_slot() {
  local s="$1" n resp cfg id
  count=$((count + 1))
  n="$prefix-$s-$count"
  if ! resp="$(gh api -X POST "repos/$repo/actions/runners/generate-jitconfig" \
      -f name="$n" -F runner_group_id=1 -f 'labels[]=self-hosted' -f 'labels[]=townwise-laptop' \
      -f work_folder=_work 2> "$state/gh-error")"; then
    log "slot $s: GitHub refused a runner config ($(tr '\n' ' ' < "$state/gh-error" | cut -c 1-200)); retrying in 60s"
    not_before[s]=$(($(date +%s) + 60))
    return
  fi
  id="$(printf '%s' "$resp" | jq -r '.runner.id // empty')"
  cfg="$(printf '%s' "$resp" | jq -r '.encoded_jit_config // empty')"
  resp=''
  # Recorded before docker run, so a Ctrl-C at any point still finds the registration and folder to remove.
  name[s]="$n"; rid[s]="$id"; dir[s]="$jobs/$n"
  if [ -z "$id" ] || [ -z "$cfg" ]; then
    log "slot $s: GitHub's answer had no runner id or config; retrying in 60s"
    clear_slot "$s"
    not_before[s]=$(($(date +%s) + 60))
    return
  fi
  mkdir "${dir[s]}"
  started[s]=$(date +%s)
  # --pull never: the image is the one built above (or named with -i), never one fetched from a registry.
  if ! TOWNWISE_JIT_CONFIG="$cfg" docker run --detach --init --pull never --name "$n" --label "townwise-ci-session=$session" \
      --env TOWNWISE_JIT_CONFIG --env "TOWNWISE_JOB_DIR=${dir[s]}" \
      --env TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal \
      --volume /var/run/docker.sock:/var/run/docker.sock --volume "${dir[s]}:${dir[s]}" \
      "$image" > /dev/null; then
    cfg=''
    log "slot $s: the runner container did not start; retrying in 60s"
    clear_slot "$s"
    not_before[s]=$(($(date +%s) + 60))
    return
  fi
  cfg=''
  log "slot $s: runner $n is waiting for a job"
  # The runner's own console (connected, job name, result); job logs stay on GitHub.
  docker logs --follow "$n" 2>&1 | while IFS= read -r line; do printf '[slot %s] %s\n' "$s" "$line"; done &
}

# On Ctrl-C (status 0), or on an unexpected error (its status), so nothing is left running either way.
stop() {
  local code="$1"
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  log "stopping: removing the runner containers, job folders and waiting registrations"
  for s in $(seq 1 "$slots"); do clear_slot "$s"; done
  # Anything of this session the slots no longer track: a container or registration created while Ctrl-C arrived.
  docker ps --all --quiet --filter "label=townwise-ci-session=$session" | while read -r c; do
    docker rm -f "$c" > /dev/null 2>&1 || true
  done
  gh api --paginate "repos/$repo/actions/runners" --jq ".runners[] | select(.name | startswith(\"$prefix-\")) | .id" \
      2> /dev/null | while read -r id; do
    gh api -X DELETE "repos/$repo/actions/runners/$id" > /dev/null 2>&1 \
      || log "could not remove runner $id; remove it under Settings, Actions, Runners"
  done
  rm -rf -- "$state"
  wait
  log "stopped"
  exit "$code"
}
state="$(mktemp -d)"
trap 'stop 0' INT TERM HUP
trap 'stop $?' EXIT

log "image $image; $slots slots; runners named $prefix-*; job folders under $jobs; Ctrl-C stops"
while :; do
  for s in $(seq 1 "$slots"); do
    if [ -n "${name[s]}" ]; then
      status="$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "${name[s]}" 2> /dev/null || echo 'missing -')"
      case "$status" in
        running* | created*) continue ;;
      esac
      lived=$(($(date +%s) - started[s]))
      log "slot $s: runner ${name[s]} finished ($status, ${lived}s)"
      clear_slot "$s"
      # A runner that exits within seconds never took a job (bad config, no network): do not spin.
      if [ "$lived" -lt 30 ]; then
        log "slot $s: that was too quick to be a job; retrying in 60s"
        not_before[s]=$(($(date +%s) + 60))
      fi
    fi
    if [ "$(date +%s)" -ge "${not_before[s]}" ]; then start_slot "$s"; fi
  done
  sleep 3
done
