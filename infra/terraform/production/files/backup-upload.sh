set -eu
# Main container of caj-townwise-backup (the pinned Azure CLI image). Uploads the dump with the job's identity,
# whose only right is creating a new blob: one Put Blob, If-None-Match: * (never an overwrite), at most
# 5,000 MiB. The container is write-once for 30 days besides. The token goes to curl in a private header file.
: "${AZURE_CLIENT_ID:?}" "${BACKUP_ACCOUNT:?}" "${BACKUP_CONTAINER:?}"
umask 077
name="$(cat /backup/name)"
case "$name" in
  townwise-*.archive.gz) ;;
  *) echo "unexpected dump name" >&2; exit 1 ;;
esac
az login --identity --client-id "$AZURE_CLIENT_ID" --output none
printf 'Authorization: Bearer %s\n' \
  "$(az account get-access-token --resource https://storage.azure.com/ --query accessToken --output tsv)" > /tmp/auth
curl --fail-with-body --silent --show-error --output /dev/null -X PUT --upload-file "/backup/$name" \
  -H @/tmp/auth -H 'x-ms-version: 2023-11-03' -H 'x-ms-blob-type: BlockBlob' -H 'If-None-Match: *' \
  -H 'Content-Type: application/gzip' "https://$BACKUP_ACCOUNT.blob.core.windows.net/$BACKUP_CONTAINER/$name"
rm -f /tmp/auth
# The backup-missing alert (monitoring.tf) looks for this line.
echo "uploaded $name to $BACKUP_ACCOUNT/$BACKUP_CONTAINER ($(wc -c < "/backup/$name") bytes)"
