#!/usr/bin/env bash
# Runs infra/smoke/db-smoke.js once against the real cluster: one execution of caj-townwise-db-smoke, with its
# image replaced by the API image that is live now (so the kit code that is deployed). The job runs in the
# virtual network; its identity reads only mongodb-uri and is not available inside the container.
# Usage: infra/scripts/db-smoke.sh   (needs townwise-admins)
set -euo pipefail

rg="rg-townwise-prod"
here="$(cd "$(dirname "$0")/.." && pwd)"
image="$(az containerapp show --name ca-townwise-api --resource-group "$rg" \
  --query "properties.template.containers[?name=='api'].image | [0]" --output tsv)"
: "${image:?could not read the API image}"
if ! [[ "$image" =~ ^[a-z0-9.-]+/townwise-api@sha256:[0-9a-f]{64}$ ]]; then
  echo "unexpected API image" >&2
  exit 1
fi

template="$(mktemp)"
trap 'rm -f "$template"' EXIT
# JSON is valid YAML, so the script goes in as one JSON string.
python3 -I - "$image" "$here/smoke/db-smoke.js" > "$template" <<'PY'
import json, sys
image, script = sys.argv[1], open(sys.argv[2]).read()
print(json.dumps({"containers": [{
    "name": "db-smoke", "image": image, "resources": {"cpu": 0.5, "memory": "1Gi"},
    "command": ["node", "--input-type=module", "--eval", script],
    "env": [{"name": "MONGODB_URI", "secretRef": "mongodb-uri"}],
}]}))
PY

az containerapp job start --name caj-townwise-db-smoke --resource-group "$rg" --yaml "$template" \
  --query name --output tsv
echo "then: az containerapp job execution list -n caj-townwise-db-smoke -g $rg --query '[0].properties.status' -o tsv"
