#!/usr/bin/env bash
# Runs the repository's CI checks on this Mac (infra/README.md, "CI on the laptop runner"). Each slot keeps one
# ephemeral runner waiting for a job: a just-in-time registration with the labels self-hosted, townwise-laptop and
# townwise-ci (which camo's runners carry too, infra/README.md, "CI on camo"),
# and a fresh container that takes one job and is removed with its job folder; then the slot starts another.
# One session runs at a time (a lock in ~/.townwise-ci). At start it removes what earlier sessions left behind: job
# folders, runner containers, and offline townwise-laptop-* registrations. Ctrl-C stops every slot: it removes the
# containers and job folders, asks GitHub to remove each registration of this session that is still there, and
# exits 130. A second Ctrl-C exits at once, and the next start removes what is left.
#
# Usage: infra/ci-runner/run-runners.sh [-n slots] [-i image]
#   -n  jobs at a time (default 2)
#   -i  run this image (tag or ID) instead of building infra/ci-runner/Dockerfile
# Needs Docker Desktop on Apple Silicon sharing only ~/.townwise-ci (Settings, Resources, File sharing; it refuses
# to start otherwise), jq, and gh signed in as an admin of the repository (generate-jitconfig requires admin). The
# runner config stays in shell variables and the container's environment: this script never prints it, writes it to
# a file or puts it on a command line. (The runner writes its credentials into the job folder, which is removed with
# the job.) Never run it under bash -x: a trace prints the config. For the same reason it turns tracing off and
# clears GH_DEBUG and DEBUG, with which gh logs response bodies.
set +x
set -euo pipefail
unset GH_DEBUG DEBUG

repo=engg-119/engg-119-mvp
here="$(cd "$(dirname "$0")" && pwd)"
# Under /Users, which Docker Desktop shares with the VM, so a job folder has the same path on the Mac, in the
# runner container and in any container a job starts with docker run -v.
root="$HOME/.townwise-ci"
jobs="$root/jobs"
lock="$root/session.lock"

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
  '' | *[!0-9]*) echo "slots must be a whole number above 0" >&2; exit 2 ;;
esac
slots=$((10#$slots))
if [ "$slots" -lt 1 ]; then echo "slots must be a whole number above 0" >&2; exit 2; fi

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

# Every job holds the Docker socket, which is root in Docker Desktop's VM, and by default Docker Desktop shares all
# of /Users (and /Volumes, /private, /tmp, /var/folders) with that VM: any job could read and write the home folder
# (SSH keys, Azure CLI tokens). So the runner starts only when the saved File sharing list is exactly ~/.townwise-ci.
# Unset (null) means the defaults. After the image is ready, a probe checks that the list has been applied.
settings_dir="$HOME/Library/Group Containers/group.com.docker"
shared=null
for file in settings-store.json settings.json; do
  if [ -f "$settings_dir/$file" ]; then
    shared="$(jq -c '(.FilesharingDirectories // .filesharingDirectories)
      | if type == "array" then map(sub("/+$"; "")) else null end' "$settings_dir/$file" 2> /dev/null || echo null)"
    break
  fi
done
if [ "$shared" != "$(jq -cn --arg dir "$root" '[$dir]')" ]; then
  if [ "$shared" = null ]; then shared='the defaults, all of /Users among them'; fi
  echo "Docker Desktop must share only $root with its VM; it shares $shared." >&2
  echo "Set Docker Desktop, Settings, Resources, File sharing to that one folder, Apply & restart, then start again." >&2
  exit 1
fi

# Each slot gets its own four of the VM's CPUs (--cpuset-cpus), like a 4-vCPU hosted runner. Jest and Vitest size
# their worker pools from the CPUs a process may use: with all 16, the verify job's Jest alone peaked near 14 GiB
# and the VM killed a worker. Slots share CPUs only when there are more slots than sets of four.
cpu_sets=$(($(docker info --format '{{.NCPU}}') / 4))
if [ "$cpu_sets" -lt 1 ]; then echo "Docker Desktop needs at least 4 CPUs (Settings, Resources)" >&2; exit 1; fi

session="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
prefix="townwise-laptop-$session"
count=0
for s in $(seq 1 "$slots"); do
  name[s]=''; rid[s]=''; dir[s]=''; started[s]=0; not_before[s]=0
done

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

# One session at a time, because the start-up sweep removes whatever another session would still be using.
take_lock() {
  local other
  if mkdir "$lock" 2> /dev/null; then
    echo "$$" > "$lock/pid"
    return 0
  fi
  other="$(cat "$lock/pid" 2> /dev/null || true)"
  if [ -z "$other" ]; then
    echo "$lock has no pid: another session is starting, or it is broken (remove it if no session runs)" >&2
    return 1
  fi
  if ps -p "$other" -o command= 2> /dev/null | grep -q run-runners.sh; then
    echo "another run-runners.sh session is running (pid $other); stop it first" >&2
    return 1
  fi
  # Its session ended without removing the lock: a second Ctrl-C, a crash or a reboot.
  rm -rf -- "$lock"
  mkdir "$lock" && echo "$$" > "$lock/pid"
}

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

# Gives up on this attempt of a slot: removes what it made, and tries again in 60 s.
retry_later() {
  if [ -z "$stop_requested" ]; then log "slot $1: $2; retrying in 60s"; fi
  clear_slot "$1"
  not_before[$1]=$(($(date +%s) + 60))
}

start_slot() {
  local s="$1" n resp cfg id first_cpu
  count=$((count + 1))
  n="$prefix-$s-$count"
  if ! resp="$(gh api -X POST "repos/$repo/actions/runners/generate-jitconfig" \
      -f name="$n" -F runner_group_id=1 -f 'labels[]=self-hosted' -f 'labels[]=townwise-laptop' -f 'labels[]=townwise-ci' \
      -f work_folder=_work 2> "$state/gh-error")"; then
    retry_later "$s" "GitHub refused a runner config ($(tr '\n' ' ' < "$state/gh-error" | cut -c 1-200))"
    return
  fi
  # Recorded before anything else can fail, so a retry or a Ctrl-C from here on finds what to remove.
  name[s]="$n"; dir[s]="$jobs/$n"
  if ! id="$(printf '%s' "$resp" | jq -er '.runner.id' 2> /dev/null)"; then
    resp=''
    retry_later "$s" "GitHub's answer had no runner id"
    return
  fi
  rid[s]="$id"
  if ! cfg="$(printf '%s' "$resp" | jq -er '.encoded_jit_config' 2> /dev/null)"; then
    resp=''
    retry_later "$s" "GitHub's answer had no runner config"
    return
  fi
  resp=''
  if ! mkdir "${dir[s]}"; then
    cfg=''
    retry_later "$s" "could not create ${dir[s]}"
    return
  fi
  started[s]=$(date +%s)
  first_cpu=$(((s - 1) % cpu_sets * 4))
  # --pull never and the image ID: the image this session resolved at start, never one fetched from a registry, and
  # never what a job retagged townwise-ci-runner:local to meanwhile.
  if ! TOWNWISE_JIT_CONFIG="$cfg" docker run --detach --init --pull never --name "$n" --label "townwise-ci-session=$session" \
      --cpuset-cpus "$first_cpu-$((first_cpu + 3))" --env TOWNWISE_JIT_CONFIG --env "TOWNWISE_JOB_DIR=${dir[s]}" \
      --env TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal \
      --volume /var/run/docker.sock:/var/run/docker.sock --volume "${dir[s]}:${dir[s]}" \
      "$image_id" > /dev/null; then
    cfg=''
    retry_later "$s" "the runner container did not start"
    return
  fi
  cfg=''
  log "slot $s: runner $n is waiting for a job"
  # The runner's own console (connected, job name, result); job logs stay on GitHub.
  docker logs --follow "$n" 2>&1 | while IFS= read -r line; do printf '[slot %s] %s\n' "$s" "$line"; done &
}

# Runs outside any signal trap (bash 3.2 does not run an INT trap while one is running), so that a second Ctrl-C
# during it runs the trap set here. Called with 130 after Ctrl-C, 143 after TERM, 129 after HUP, or an unexpected
# error's status, so nothing is left running either way.
stop() {
  local code="$1"
  trap - EXIT
  trap 'echo; log "second interrupt: exiting now; the next start removes what is left"; rm -rf -- "$state" "$lock"; exit 130' \
    INT TERM HUP
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
  rm -rf -- "$state" "$lock"
  wait
  log "stopped"
  exit "$code"
}

# What earlier sessions left behind, which only a second Ctrl-C, a crash or a reboot does. Safe to remove because
# the lock says no other session is running.
sweep() {
  local c d id ids containers=0 folders=0 runners=0
  for c in $(docker ps --all --quiet --filter label=townwise-ci-session || true); do
    if docker rm -f "$c" > /dev/null 2>&1; then containers=$((containers + 1)); fi
  done
  for d in "$jobs"/townwise-laptop-*; do
    if [ -e "$d" ]; then rm -rf -- "$d"; folders=$((folders + 1)); fi
  done
  if ids="$(gh api --paginate "repos/$repo/actions/runners" \
      --jq '.runners[] | select((.name | startswith("townwise-laptop-")) and .status == "offline") | .id' 2> /dev/null)"; then
    for id in $ids; do
      if gh api -X DELETE "repos/$repo/actions/runners/$id" > /dev/null 2>&1; then
        runners=$((runners + 1))
      else
        log "could not remove runner $id; remove it under Settings, Actions, Runners"
      fi
    done
  else
    log "could not list the repository's runners; remove offline townwise-laptop-* ones under Settings, Actions, Runners"
  fi
  log "start-up sweep: removed $containers runner containers, $folders job folders and $runners offline registrations"
}

# A signal only records the request; the session stops at the next check_stop, or through the EXIT trap when the
# signal also ended the command running at the time.
stop_requested=''
check_stop() {
  if [ -n "$stop_requested" ]; then stop "$stop_requested"; fi
}

mkdir -p "$root"
chmod 700 "$root"
mkdir -p "$jobs"
take_lock || exit 1
state="$(mktemp -d)"
trap 'stop_requested=130' INT
trap 'stop_requested=143' TERM
trap 'stop_requested=129' HUP
trap 'stop "${stop_requested:-$?}"' EXIT

sweep
check_stop

if [ -z "$image" ]; then
  image=townwise-ci-runner:local
  docker build -t "$image" "$here"
fi
if ! image_id="$(docker image inspect --format '{{.Id}}' "$image" 2> /dev/null)"; then
  echo "no image $image" >&2
  exit 1
fi
check_stop

# The saved File sharing list takes effect only after Apply & restart. A container that mounts $root must see the
# job folders (else every job's checkout is refused), and one that mounts the home folder must not see $root in it:
# Docker Desktop refuses a folder it does not share. The first probe is the control that makes the second meaningful.
sees() {
  docker run --rm --pull never --network none --entrypoint test --volume "$1:/probe:ro" "$image_id" -d "/probe/$2" \
    > /dev/null 2>&1
}
if ! sees "$root" jobs; then
  echo "a container cannot mount $root: check Docker Desktop, Settings, Resources, File sharing" >&2
  exit 1
fi
if sees "$HOME" .townwise-ci; then
  echo "a container can still mount $HOME: Docker Desktop has not applied the File sharing list; Apply & restart" >&2
  exit 1
fi
check_stop

# Every job reaches the Mac's loopback through host.docker.internal (testcontainers needs it), so a dev database
# or a local API running now is open to every job.
open=''
for port in 27017 6379 10000 8080; do
  if (exec 3<> "/dev/tcp/127.0.0.1/$port") 2> /dev/null; then open="$open $port"; fi
done
if [ -n "$open" ]; then
  log "warning: 127.0.0.1 answers on port(s)$open (dev Mongo, Valkey, Azurite, the API?). Every job can reach them" \
    "through host.docker.internal: stop the dev stack (docker compose down) and local services while the runner runs."
fi

log "image $image ($image_id); $slots slots; runners named $prefix-*; job folders under $jobs; Ctrl-C stops"
while :; do
  for s in $(seq 1 "$slots"); do
    check_stop
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
    check_stop
    if [ "$(date +%s)" -ge "${not_before[s]}" ]; then start_slot "$s"; fi
  done
  check_stop
  sleep 3
done
