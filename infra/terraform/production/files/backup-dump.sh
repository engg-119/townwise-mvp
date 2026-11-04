set -eu
# Init container of caj-townwise-backup (the pinned mongo image; no managed identity token here). Dumps the
# townwise database with the read-only backup user into the job's EmptyDir. The URI reaches mongodump in a
# private config file, not argv, and mongodump's errors (which can echo the URI) are printed with the
# credentials removed.
: "${MONGODB_BACKUP_URI:?MONGODB_BACKUP_URI is not set}"
umask 077
name="townwise-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
printf 'uri: "%s"\n' "$MONGODB_BACKUP_URI" > /tmp/dump.yaml
if ! mongodump --config /tmp/dump.yaml --db townwise --gzip --archive="/backup/$name" 2> /tmp/dump.err; then
  sed -E 's#(mongodb(\+srv)?://)[^@/[:space:]]*@#\1<credentials>@#g' /tmp/dump.err >&2
  exit 1
fi
rm -f /tmp/dump.yaml /tmp/dump.err
printf '%s\n' "$name" > /backup/name
echo "dumped $name ($(wc -c < "/backup/$name") bytes)"
