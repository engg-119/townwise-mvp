set -eu
# Init container of caj-townwise-db-restore (the pinned Azure CLI image). Downloads the dump named in
# BACKUP_BLOB, set for each execution by infra/scripts/db-restore.sh. There is no default: never "the newest
# blob", so a planted blob is not restored by accident. The identity can only read the container.
: "${AZURE_CLIENT_ID:?}" "${BACKUP_ACCOUNT:?}" "${BACKUP_CONTAINER:?}"
: "${BACKUP_BLOB:?BACKUP_BLOB names the dump to restore (infra/scripts/db-restore.sh)}"
if ! printf '%s' "$BACKUP_BLOB" | grep -E -x 'townwise-[0-9]{8}T[0-9]{6}Z\.archive\.gz' > /dev/null; then
  echo "BACKUP_BLOB is not a dump name" >&2
  exit 1
fi
az login --identity --client-id "$AZURE_CLIENT_ID" --output none
az storage blob download --auth-mode login --account-name "$BACKUP_ACCOUNT" --container-name "$BACKUP_CONTAINER" \
  --name "$BACKUP_BLOB" --file "/restore/$BACKUP_BLOB" --no-progress --output none
printf '%s\n' "$BACKUP_BLOB" > /restore/name
echo "downloaded $BACKUP_BLOB"
