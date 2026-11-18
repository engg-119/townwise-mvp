// The environment the local API runs with on the production copy (`npm run dev:prod-copy -w @townwise/api`, after
// infra/scripts/db-pull-prod.sh restores one): api/.env.local with the database switched to townwise_prod on the same
// local server, and everything that acts outside this laptop for the copy's real people turned off:
// - stored files: the boot sweeper deletes every Azurite blob over a day old with no tw_files row in ITS database, so
//   on the copy it would delete the local files (it did once, 2026-11-17);
// - email: the copy holds real people's addresses;
// - Google and linked calendars: the copy holds real people's sealed calendar links and Google tokens.
// Pure, so the rules are one test (api/test/prod-copy-env.test.ts).

export const PROD_COPY_DB = 'townwise_prod';

/** Turned off on the copy: unset, each reads as absent (files, email and calendars off). */
export const PROD_COPY_OFF = [
  'FILES_BLOB_ACCOUNT_URL', 'FILES_AZURITE_CONNECTION_STRING',
  'EMAIL_ENDPOINT', 'EMAIL_SENDER', 'TOWNWISE_EMAIL_REPLY_TO',
  'TOWNWISE_CALENDAR_KEY', 'TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID', 'TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET',
] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function prodCopyEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const uri = env.MONGODB_URI;
  if (uri === undefined || uri === '') throw new Error('MONGODB_URI is not set in api/.env.local');
  const url = new URL(uri);
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error('The production copy runs only on a local MongoDB (MONGODB_URI must be localhost)');
  url.pathname = `/${PROD_COPY_DB}`;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !(PROD_COPY_OFF as readonly string[]).includes(name)) out[name] = value;
  }
  out.MONGODB_URI = url.toString();
  return out;
}
