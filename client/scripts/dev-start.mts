// `npm start`: require an Azure CLI sign-in, then start Expo with the public Google web client id
// from Key Vault. The id is public and compiled into the bundle. The client secret is not loaded here.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { googleWebClientId } from './azure-dev.mts';

const clientId = await googleWebClientId();
if (clientId === null) process.exit(1);

const client = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn('expo', ['start', ...process.argv.slice(2)], {
  cwd: client, stdio: 'inherit', env: { ...process.env, EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: clientId },
});
child.on('exit', (code) => { process.exit(code ?? 0); });
