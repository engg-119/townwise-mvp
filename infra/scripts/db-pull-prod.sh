#!/usr/bin/env bash
# Restores production's newest nightly dump into the local MongoDB as townwise_prod, for
# `npm run dev:prod-copy -w @townwise/api` (owner, 2026-11-18: "so i can build new features and not have to transfer
# data each time"). With --fresh it first runs the backup job, so the copy is minutes old rather than from 07:17 UTC.
# Your own townwise database is never touched; townwise_prod is dropped and restored whole each time.
#
# Needs: az signed in as a member of townwise-admins (bootstrap team.tf admins_backup_reader), and docker compose's
# mongo running (docker compose up -d). The backup account admits only the apps subnet, so the script adds this
# machine's public IP to its firewall for the download alone and removes it as soon as the download ends, or on any
# exit; reads still need Entra (the account has no shared keys). The dump file is deleted when done.
# Left out of the copy: sign-in sessions, retired refresh tokens, magic links and two-step secrets.
# Usage: infra/scripts/db-pull-prod.sh [--fresh]
set -euo pipefail

rg="rg-townwise-prod"
job="caj-townwise-backup"
container="mongodump"
target="townwise_prod"
die() { echo "db-pull-prod: $*" >&2; exit 1; }

fresh=false
case "${1:-}" in
  "") ;;
  --fresh) fresh=true ;;
  *) die "usage: $0 [--fresh]" ;;
esac

cd "$(dirname "$0")/../.."
sub="$(az account show --query id --output tsv)" || die "sign in first: az login"
account="sttwbackup$(printf '%s' "$sub" | tr -d - | cut -c1-8)"
mongo="$(docker compose ps --quiet mongo)"
[ -n "$mongo" ] || die "local mongo isn't running: docker compose up -d"

if $fresh; then
  execution="$(az containerapp job start --name "$job" --resource-group "$rg" --query name --output tsv)"
  echo "backup job started ($execution); waiting for it to finish"
  for _ in $(seq 1 80); do
    status="$(az containerapp job execution show --name "$job" --resource-group "$rg" --job-execution-name "$execution" --query properties.status --output tsv)"
    case "$status" in
      Succeeded) break ;;
      Failed | Stopped | Degraded) die "backup job $execution ended $status" ;;
    esac
    sleep 15
  done
  [ "$status" = "Succeeded" ] || die "backup job $execution still $status after 20 minutes"
fi

work="$(mktemp -d)"
chmod 700 "$work"
ip=""
close() {
  if [ -n "$ip" ]; then
    az storage account network-rule remove --resource-group "$rg" --account-name "$account" --ip-address "$ip" --output none \
      || echo "db-pull-prod: REMOVE BY HAND: the $account firewall rule for $ip" >&2
    ip=""
  fi
}
trap 'close; rm -rf "$work"' EXIT

ip="$(curl -fsS https://api.ipify.org)" || die "couldn't read this machine's public IP"
echo "allowing $ip on $account for the download"
az storage account network-rule add --resource-group "$rg" --account-name "$account" --ip-address "$ip" --output none

# The token goes to curl in a file, never on its command line.
token="$(az account get-access-token --resource https://storage.azure.com --query accessToken --output tsv)"
printf 'Authorization: Bearer %s\nx-ms-version: 2023-11-03\n' "$token" > "$work/headers"
unset token
blobs="https://$account.blob.core.windows.net/$container"
# Azure's error code from a refused call's body (a code and a request id; no data).
code_of() { grep -aoE '<Code>[^<]*</Code>' "$1" 2>/dev/null | sed -E 's#</?Code>##g' | head -n 1; }
listing=""
for _ in $(seq 1 30); do # a new firewall rule can take a minute to apply
  if curl -sS --fail-with-body -H @"$work/headers" -o "$work/list" "$blobs?restype=container&comp=list" 2> /dev/null; then
    listing="$(cat "$work/list")"
    break
  fi
  sleep 5
done
[ -n "$listing" ] || die "couldn't list $container: $(code_of "$work/list") (AuthorizationFailure is the firewall; AuthorizationPermissionMismatch is the role: is your account in townwise-admins, with admins_backup_reader applied?)"
dump="$(printf '%s' "$listing" | grep -oE 'townwise-[0-9]{8}T[0-9]{6}Z\.archive\.gz' | sort -u | tail -n 1)"
[ -n "$dump" ] || die "no dump in $container yet"
echo "downloading $dump"
# A new role assignment can take minutes to reach every storage server, so a refused download is tried again.
got=false
for _ in $(seq 1 20); do
  if curl -sS --fail-with-body -H @"$work/headers" -o "$work/dump.archive.gz" "$blobs/$dump" 2> /dev/null; then
    got=true
    break
  fi
  echo "download refused ($(code_of "$work/dump.archive.gz")); trying again in 15 seconds"
  sleep 15
done
$got || die "the download was refused for 5 minutes: $(code_of "$work/dump.archive.gz")"
close

echo "restoring into $target (local)"
docker exec "$mongo" mongosh --quiet "$target" --eval 'db.dropDatabase()' > /dev/null || die "couldn't drop the local $target"
# A failed restore keeps the dump for diagnosis, readable by you alone; delete it once the pull works.
kept() {
  local keep="$HOME/.townwise-ci/prod-pull"
  mkdir -p "$keep"
  chmod 700 "$keep"
  mv "$work/dump.archive.gz" "$keep/$dump"
  chmod 600 "$keep/$dump"
  die "$1; the dump is kept at $keep/$dump"
}
# DocumentDB stamps each collection with options MongoDB refuses (statsEnabled), so they stay behind; the API builds
# its indexes at boot. The dump's version warning (7.0.0 to 8.x) is expected.
docker exec -i "$mongo" mongorestore --noOptionsRestore --archive --gzip --nsFrom 'townwise.*' --nsTo "$target.*" \
  --nsExclude 'townwise.auth_sessions' --nsExclude 'townwise.auth_refresh_retired' \
  --nsExclude 'townwise.auth_magic_links' --nsExclude 'townwise.auth_totp' < "$work/dump.archive.gz" > "$work/restore.log" 2>&1 \
  || { grep -v 'reading metadata' "$work/restore.log" >&2; kept "mongorestore failed (above)"; }
collections="$(docker exec "$mongo" mongosh --quiet "$target" --eval 'db.getCollectionNames().length')"
[ "$collections" -gt 0 ] || { grep -v 'reading metadata' "$work/restore.log" >&2; kept "mongorestore restored nothing into $target"; }
echo "done: $target holds $dump ($collections collections). Stop your usual API, then: npm run dev:prod-copy -w @townwise/api"
