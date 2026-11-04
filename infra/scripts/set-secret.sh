#!/usr/bin/env bash
# Seed or change one Key Vault secret value without it reaching argv, shell history, the terminal or a log.
# Usage: infra/scripts/set-secret.sh <vault name> <secret name>
#   Interactive: the value is read from a hidden prompt.
#   Piped: exactly one line is read from stdin, for example
#     printf 'k1:%s' "$(openssl rand -base64 32)" | infra/scripts/set-secret.sh <vault> auth-jwt-keys
# The value reaches az on stdin (--file /dev/stdin). Requires Key Vault Secrets Officer (townwise-secrets-admins).
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <vault name> <secret name>" >&2
  exit 2
fi
vault="$1"
name="$2"
if ! [[ "$vault" =~ ^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$ ]]; then
  echo "invalid vault name" >&2
  exit 2
fi
if ! [[ "$name" =~ ^[A-Za-z0-9-]{1,127}$ ]]; then
  echo "invalid secret name (letters, digits and hyphens)" >&2
  exit 2
fi
case "$-" in *x*) echo "refusing to run with xtrace on" >&2; exit 2 ;; esac

value=""
if [ -t 0 ]; then
  IFS= read -r -s -p "Value for $name (hidden): " value
  echo >&2
else
  IFS= read -r value || true
  if IFS= read -r _extra; then
    echo "piped input has more than one line; nothing written" >&2
    exit 1
  fi
fi
if [ -z "$value" ]; then
  echo "empty value; nothing written" >&2
  exit 1
fi

# printf is a shell builtin, so the value never appears in a process's argv. --output none keeps az from
# echoing the secret (it prints the stored value by default).
printf '%s' "$value" | az keyvault secret set --vault-name "$vault" --name "$name" \
  --file /dev/stdin --encoding utf-8 --output none
unset value
echo "set $name in $vault (new version)"
