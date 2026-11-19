#!/usr/bin/env bash
# Runs the repository's CI checks on camo while camo has compute to spare (infra/README.md, "CI on camo"). Up to N
# slots (default 4), each pinned to its own 4 CPUs. A slot starts a one-job runner (a just-in-time registration at the
# engg-119 organization with the labels self-hosted, townwise-ci and townwise-camo, in a fresh container) only while
# camo is free (owner, 2026-11-19):
#   start     when the load from everything but these jobs is under 6 and at least 16 GiB of memory is available;
#   withdraw  a runner still waiting for a job when that load reaches 8 or available memory drops under 12 GiB.
# A runner that has taken a job always finishes it. The load from everything but these jobs is estimated as the
# 1-minute load average minus 4 (a slot's CPUs) for each runner running a job.
#
# Started by the user systemd unit townwise-ci-runners.service. TERM (systemctl --user stop) removes every container,
# job folder and registration of the session. One session at a time (a lock in ~/.townwise-ci); each start removes
# what earlier sessions left behind.
#
# Usage: camo-runners.sh [-n slots] [-i image]
#   -n  slots (default 4)
#   -i  run this image (tag or ID) instead of building the Dockerfile next to this script
# Needs Docker (this user in the socket's group), curl and jq, and in ~/.config/townwise-ci/token (mode 600) a
# fine-grained token whose only permission is the engg-119 organization's "Self-hosted runners: Read and write". The
# token and each runner config stay in shell variables and the container's environment: this script never prints
# them, writes them to a file or puts them on a command line. Never run it under bash -x.
set +x
set -euo pipefail

org=engg-119
runners_url="https://api.github.com/orgs/$org/actions/runners"
here="$(cd "$(dirname "$0")" && pwd)"
root="$HOME/.townwise-ci"
jobs="$root/jobs"
lock="$root/camo-session.lock"
token_file="$HOME/.config/townwise-ci/token"

# What counts as free compute (owner, 2026-11-19).
start_load=6
withdraw_load=8
start_mem_gib=16
withdraw_mem_gib=12
cpus_per_slot=4

slots=4
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

for tool in docker curl jq awk; do
  command -v "$tool" > /dev/null || { echo "$tool is required" >&2; exit 1; }
done
if ! docker info > /dev/null 2>&1; then echo "cannot reach Docker as $(id -un)" >&2; exit 1; fi
if [ ! -f "$token_file" ] || [ "$(stat -c %a "$token_file")" != 600 ]; then
  echo "$token_file must exist with mode 600 (infra/README.md, \"CI on camo\")" >&2
  exit 1
fi
token="$(tr -d ' \r\n' < "$token_file")"
if [ -z "$token" ]; then echo "$token_file is empty" >&2; exit 1; fi
sock_gid="$(stat -c %g /var/run/docker.sock)"

cpu_sets=$(($(nproc) / cpus_per_slot))
if [ "$cpu_sets" -lt 1 ]; then echo "camo needs at least $cpus_per_slot CPUs" >&2; exit 1; fi

session="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
prefix="townwise-camo-$session"
count=0
image_id=''
for s in $(seq 1 "$slots"); do
  name[s]=''; rid[s]=''; dir[s]=''; started[s]=0; not_before[s]=0
done

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

# api METHOD URL [JSON body]: the GitHub REST API with the token in a curl config read from standard input, never on
# a command line. Prints the response body; fails on any HTTP error.
api() {
  local method="$1" url="$2" body="${3:-}"
  local args=(--silent --show-error --fail-with-body --max-time 30 -X "$method"
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "$body"); fi
  curl --config - "${args[@]}" "$url" <<< "header = \"Authorization: Bearer $token\""
}

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
  if ps -p "$other" -o args= 2> /dev/null | grep -q camo-runners.sh; then
    echo "another camo-runners.sh session is running (pid $other); stop it first" >&2
    return 1
  fi
  rm -rf -- "$lock"
  mkdir "$lock" && echo "$$" > "$lock/pid"
}

# A job's sibling containers (semgrep, checkov) can leave root-owned files in its folder, which this user cannot
# delete, so a root container removes what is left.
remove_dir() {
  rm -rf -- "$1" 2> /dev/null && return 0
  if [ -n "$image_id" ]; then
    docker run --rm --pull never --network none --user 0 --entrypoint rm --volume "$jobs:$jobs" "$image_id" -rf -- "$1" \
      > /dev/null 2>&1 || true
  fi
}

# Removes a slot's container, its registration if GitHub still has it, and its job folder.
clear_slot() {
  local s="$1"
  if [ -n "${name[s]}" ]; then
    docker rm -f "${name[s]}" > /dev/null 2>&1 || true
    rm -f -- "$state/busy-${name[s]}"
  fi
  # After a job GitHub has already removed the ephemeral runner (404); otherwise this removes one that took no job.
  if [ -n "${rid[s]}" ]; then api DELETE "$runners_url/${rid[s]}" > /dev/null 2>&1 || true; fi
  case "${dir[s]}" in
    "$jobs/$prefix-"*) remove_dir "${dir[s]}" ;;
  esac
  name[s]=''; rid[s]=''; dir[s]=''
}

retry_later() {
  if [ -z "$stop_requested" ]; then log "slot $1: $2; retrying in 60s"; fi
  clear_slot "$1"
  not_before[$1]=$(($(date +%s) + 60))
}

start_slot() {
  local s="$1" n body resp cfg id first_cpu
  count=$((count + 1))
  n="$prefix-$s-$count"
  body="$(jq -cn --arg name "$n" \
    '{name: $name, runner_group_id: 1, labels: ["self-hosted", "townwise-ci", "townwise-camo"], work_folder: "_work"}')"
  if ! resp="$(api POST "$runners_url/generate-jitconfig" "$body" 2> "$state/api-error")"; then
    retry_later "$s" "GitHub refused a runner config ($(tr '\n' ' ' < "$state/api-error" | cut -c 1-200) $(printf '%s' "$resp" | jq -r '.message? // empty' 2> /dev/null))"
    resp=''
    return
  fi
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
  first_cpu=$(((s - 1) % cpu_sets * cpus_per_slot))
  # --cpu-shares 256: when camo's own work wants the same CPUs, it gets four times the jobs' share.
  # host-gateway: testcontainers reaches the containers it starts through camo's published ports, as on the Mac.
  if ! TOWNWISE_JIT_CONFIG="$cfg" docker run --detach --init --pull never --name "$n" --label "townwise-ci-session=$session" \
      --cpuset-cpus "$first_cpu-$((first_cpu + cpus_per_slot - 1))" --cpu-shares 256 \
      --group-add "$sock_gid" --add-host host.docker.internal:host-gateway \
      --env TOWNWISE_JIT_CONFIG --env "TOWNWISE_JOB_DIR=${dir[s]}" \
      --env TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal \
      --volume /var/run/docker.sock:/var/run/docker.sock --volume "${dir[s]}:${dir[s]}" \
      "$image_id" > /dev/null; then
    cfg=''
    retry_later "$s" "the runner container did not start"
    return
  fi
  cfg=''
  log "slot $s: runner $n is waiting for a job"
  # The runner's own console (connected, job name, result); job logs stay on GitHub. "Running job" marks the
  # runner busy: it is no longer withdrawn, and its CPUs no longer count as camo's own load.
  docker logs --follow "$n" 2>&1 | while IFS= read -r line; do
    case "$line" in *'Running job:'*) : > "$state/busy-$n" ;; esac
    printf '[slot %s] %s\n' "$s" "$line"
  done &
}

# Takes back a runner still waiting for a job. GitHub refuses to remove a runner that is running one, so a job
# that was assigned a moment ago is never cut off.
withdraw_slot() {
  local s="$1"
  if [ -e "$state/busy-${name[s]}" ]; then return; fi
  if api DELETE "$runners_url/${rid[s]}" > /dev/null 2>&1; then
    log "slot $s: withdrew waiting runner ${name[s]}"
    rid[s]=''
    clear_slot "$s"
    not_before[s]=$(($(date +%s) + 60))
  fi
}

# Prints "free", "busy" or "hold" (between the two thresholds), then the load and memory it read.
compute_state() {
  local busy=0 s
  for s in $(seq 1 "$slots"); do
    if [ -n "${name[s]}" ] && [ -e "$state/busy-${name[s]}" ]; then busy=$((busy + 1)); fi
  done
  awk -v busy="$busy" -v per="$cpus_per_slot" -v sl="$start_load" -v wl="$withdraw_load" \
      -v sm="$start_mem_gib" -v wm="$withdraw_mem_gib" '
    FNR == 1 && FILENAME == "/proc/loadavg" { load = $1 - busy * per; if (load < 0) load = 0 }
    FILENAME == "/proc/meminfo" && $1 == "MemAvailable:" { mem = $2 / 1048576 }
    END {
      state = "hold"
      if (load >= wl || mem < wm) state = "busy"
      else if (load < sl && mem >= sm) state = "free"
      printf "%s %.1f %.0f\n", state, load, mem
    }' /proc/loadavg /proc/meminfo
}

# Runs outside any signal trap, so a second TERM or Ctrl-C during it runs the trap set here.
stop() {
  local code="$1"
  trap - EXIT
  trap 'log "second stop signal: exiting now; the next start removes what is left"; rm -rf -- "$state" "$lock"; exit 130' \
    INT TERM HUP
  set +e
  log "stopping: removing the runner containers, job folders and waiting registrations"
  for s in $(seq 1 "$slots"); do clear_slot "$s"; done
  docker ps --all --quiet --filter "label=townwise-ci-session=$session" | while read -r c; do
    docker rm -f "$c" > /dev/null 2>&1 || true
  done
  api GET "$runners_url?per_page=100" 2> /dev/null \
    | jq -r --arg p "$prefix-" '.runners[] | select(.name | startswith($p)) | .id' 2> /dev/null \
    | while read -r id; do
      api DELETE "$runners_url/$id" > /dev/null 2>&1 \
        || log "could not remove runner $id; remove it under the organization's Settings, Actions, Runners"
    done
  rm -rf -- "$state" "$lock"
  wait
  log "stopped"
  exit "$code"
}

# What earlier sessions left behind (a crash, a kill, a reboot). Safe because the lock says no other session runs.
sweep() {
  local c d id containers=0 folders=0 runners=0 listed
  for c in $(docker ps --all --quiet --filter label=townwise-ci-session || true); do
    if docker rm -f "$c" > /dev/null 2>&1; then containers=$((containers + 1)); fi
  done
  for d in "$jobs"/townwise-camo-*; do
    if [ -e "$d" ]; then remove_dir "$d"; folders=$((folders + 1)); fi
  done
  if listed="$(api GET "$runners_url?per_page=100" 2> /dev/null)"; then
    for id in $(printf '%s' "$listed" \
        | jq -r '.runners[] | select((.name | startswith("townwise-camo-")) and .status == "offline") | .id'); do
      if api DELETE "$runners_url/$id" > /dev/null 2>&1; then runners=$((runners + 1)); fi
    done
  else
    log "could not list the organization's runners: check the token in $token_file"
  fi
  log "start-up sweep: removed $containers runner containers, $folders job folders and $runners offline registrations"
}

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

if [ -z "$image" ]; then
  image=townwise-ci-runner:local
  # The runner user gets this user's uid, so the job folders (bind-mounted at the same path) are writable to it.
  docker build --quiet --build-arg RUNNER_UID="$(id -u)" -t "$image" "$here" > /dev/null
fi
if ! image_id="$(docker image inspect --format '{{.Id}}' "$image" 2> /dev/null)"; then
  echo "no image $image" >&2
  exit 1
fi
sweep
check_stop

log "image $image ($image_id); $slots slots of $cpus_per_slot CPUs; runners named $prefix-*; job folders under $jobs"
log "free compute: start under load $start_load with ${start_mem_gib} GiB available; withdraw waiting runners at load $withdraw_load or under ${withdraw_mem_gib} GiB"
last=''
while :; do
  read -r gate load mem < <(compute_state)
  if [ "$gate" != "$last" ]; then
    case "$gate" in
      free) log "camo is free (load $load without CI jobs, $mem GiB available): runners may start" ;;
      busy) log "camo is busy (load $load without CI jobs, $mem GiB available): withdrawing waiting runners" ;;
      hold) log "camo is in between (load $load without CI jobs, $mem GiB available): no new runners" ;;
    esac
    last="$gate"
  fi
  for s in $(seq 1 "$slots"); do
    check_stop
    if [ -n "${name[s]}" ]; then
      status="$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "${name[s]}" 2> /dev/null || echo 'missing -')"
      case "$status" in
        running* | created*)
          if [ "$gate" = busy ]; then withdraw_slot "$s"; fi
          continue
          ;;
      esac
      lived=$(($(date +%s) - started[s]))
      log "slot $s: runner ${name[s]} finished ($status, ${lived}s)"
      clear_slot "$s"
      if [ "$lived" -lt 30 ]; then
        log "slot $s: that was too quick to be a job; retrying in 60s"
        not_before[s]=$(($(date +%s) + 60))
      fi
    fi
    check_stop
    if [ "$gate" = free ] && [ "$(date +%s)" -ge "${not_before[s]}" ]; then start_slot "$s"; fi
  done
  check_stop
  sleep 5
done
