#!/usr/bin/env bash
# Starts one execution of caj-townwise-db-restore for a named dump. There is no default dump: restore never
# picks "the newest blob". The restore user must exist first (infra/README.md, step 14).
# Usage: infra/scripts/db-restore.sh townwise-<YYYYMMDD>T<HHMMSS>Z.archive.gz [townwise_restore|townwise]
set -euo pipefail

rg="rg-townwise-prod"
job="caj-townwise-db-restore"
dump="${1:?usage: $0 <dump name> [townwise_restore|townwise]}"
target="${2:-townwise_restore}"
if ! [[ "$dump" =~ ^townwise-[0-9]{8}T[0-9]{6}Z\.archive\.gz$ ]]; then
  echo "not a dump name: $dump" >&2
  exit 2
fi
case "$target" in
  townwise_restore | townwise) ;;
  *) echo "target must be townwise_restore or townwise" >&2; exit 2 ;;
esac

current="$(mktemp)"
template="$(mktemp)"
trap 'rm -f "$current" "$template"' EXIT
az containerapp job show --name "$job" --resource-group "$rg" --query properties.template --output json > "$current"
# Same containers, plus BACKUP_BLOB on the download container and RESTORE_DB on mongorestore. JSON is YAML.
python3 -I - "$current" "$dump" "$target" > "$template" <<'PY'
import json, sys
template, dump, target = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
def set_env(container, name, value):
    container["env"] = [e for e in container.get("env") or [] if e["name"] != name] + [{"name": name, "value": value}]
for container in template.get("initContainers") or []:
    if container["name"] == "download":
        set_env(container, "BACKUP_BLOB", dump)
for container in template.get("containers") or []:
    if container["name"] == "mongorestore":
        set_env(container, "RESTORE_DB", target)
print(json.dumps(template))
PY

az containerapp job start --name "$job" --resource-group "$rg" --yaml "$template" --query name --output tsv
echo "then: az containerapp job execution list -n $job -g $rg --query '[0].properties.status' -o tsv"
