set -eu
# Main container of caj-townwise-db-restore (the pinned mongo image; no managed identity token here). Restores
# the downloaded dump into RESTORE_DB as the temporary restore user (townwise-restore, infra/README.md):
# townwise_restore (default, beside live data) or townwise (replaces each collection in the dump; stop the API
# first). The URI reaches mongorestore in a config file, and its errors are printed without credentials.
: "${MONGODB_RESTORE_URI:?}" "${RESTORE_DB:?}"
case "$RESTORE_DB" in
  townwise | townwise_restore) ;;
  *) echo "RESTORE_DB must be townwise or townwise_restore" >&2; exit 2 ;;
esac
if [ "$MONGODB_RESTORE_URI" = none ]; then
  echo "no restore user: set mongodb-restore-uri and run the db-users job first (infra/README.md)" >&2
  exit 2
fi
umask 077
name="$(cat /restore/name)"
printf 'uri: "%s"\n' "$MONGODB_RESTORE_URI" > /tmp/restore.yaml
if ! mongorestore --config /tmp/restore.yaml --gzip --archive="/restore/$name" \
    --nsInclude 'townwise.*' --nsFrom 'townwise.*' --nsTo "$RESTORE_DB.*" --drop 2> /tmp/restore.err; then
  sed -E 's#(mongodb(\+srv)?://)[^@/[:space:]]*@#\1<credentials>@#g' /tmp/restore.err >&2
  exit 1
fi
rm -f /tmp/restore.yaml /tmp/restore.err
echo "restored $name into $RESTORE_DB"
