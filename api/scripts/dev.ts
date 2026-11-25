// `npm run dev`: start the API under node --watch. api/.env.local supplies the keys it already has. Key Vault fills
// only the developer secrets that file left empty, and a missing az login stops the start only then.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { parseEnv } from 'node:util';

import { DevSecretsError, developmentEnv, loadDeveloperSecrets } from '../src/dev-secrets.ts';

const api = new URL('..', import.meta.url);

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`Node 24 is required (this is ${process.version}): run nvm use first.`);
  process.exit(1);
}

let file: Record<string, string>;
try {
  file = parseEnv(readFileSync(new URL('.env.local', api), 'utf8'));
} catch {
  console.error('api/.env.local is missing. Copy api/.env.example and generate the two local keys (README.md, Run it locally).');
  process.exit(1);
}

let secrets: Record<string, string>;
try {
  secrets = await loadDeveloperSecrets({ target: 'server', local: [file, process.env] });
} catch (err) {
  console.error(err instanceof DevSecretsError ? err.message : 'Could not load developer secrets from Azure.');
  process.exit(1);
}

// .env.local, then the shell, then Key Vault. Node's --env-file would not override variables already set here.
const env = developmentEnv(file, process.env, secrets);
const port = Number(env.PORT ?? '8080');

function inUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: 'localhost' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { resolve(false); });
  });
}

if (await inUse()) {
  console.error(`Port ${String(port)} is in use. Stop the other API first, then run this again.`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--env-file=.env.local', '--watch', 'src/main.ts'], { cwd: api, stdio: 'inherit', env });
child.on('exit', (code) => { process.exit(code ?? 0); });
