// `npm run dev:prod-copy -w @townwise/api`: the local API, watching edits as `npm run dev` does, on the production copy
// that infra/scripts/db-pull-prod.sh restores into townwise_prod (prod-copy-env.ts says what changes). Stop the usual
// API first: this one takes the same port, so the local web app and Google sign-in work unchanged.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { parseEnv } from 'node:util';

import { DevSecretsError, developmentEnv, loadDeveloperSecrets } from '../src/dev-secrets.ts';
import { PROD_COPY_DB, prodCopyEnv } from './prod-copy-env.ts';

const api = new URL('..', import.meta.url);
const file = parseEnv(readFileSync(new URL('.env.local', api), 'utf8'));
let secrets: Record<string, string>;
try {
  secrets = await loadDeveloperSecrets({ target: 'server', local: [file, process.env] });
} catch (err) {
  console.error(err instanceof DevSecretsError ? err.message : 'Could not load developer secrets from Azure.');
  process.exit(1);
}
// .env.local replaces Key Vault for a name it sets. prodCopyEnv then turns calendars, files and email off.
const env = prodCopyEnv(developmentEnv(file, process.env, secrets));
const port = Number(env.PORT ?? '8080');

function inUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: 'localhost' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { resolve(false); });
  });
}

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`Node 24 is required (this is ${process.version}): run nvm use first.`);
  process.exitCode = 1;
} else if (await inUse()) {
  console.error(`Port ${String(port)} is in use, probably by your usual API. Stop it first, then run this again.`);
  process.exitCode = 1;
} else {
  console.log(`API on the production copy (${PROD_COPY_DB}); stored files, email and calendars are off`);
  const child = spawn(process.execPath, ['--watch', 'src/main.ts'], { cwd: api, stdio: 'inherit', env });
  child.on('exit', (code) => { process.exitCode = code ?? 0; });
}
