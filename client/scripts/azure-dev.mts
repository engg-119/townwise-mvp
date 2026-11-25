// The public Google web client id for a local Expo start. The API script reads Key Vault and prints JSON
// on stdout; a missing Azure sign-in is already printed on stderr and this resolves null.
// A non-empty EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in client/.env.local replaces the Key Vault value, then the shell.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = join(clientRoot, '..', 'api');

function nonempty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function clientFileId(): string | undefined {
  try {
    return nonempty(parseEnv(readFileSync(join(clientRoot, '.env.local'), 'utf8')).EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID);
  } catch {
    return undefined;
  }
}

export function loadWebClientId(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/load-dev-secrets.ts', 'client'], {
      cwd: apiRoot, stdio: ['ignore', 'pipe', 'inherit'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    const fail = (): void => { resolve(null); };
    child.on('error', fail);
    child.on('exit', (code) => {
      if (code !== 0) { fail(); return; }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const id = typeof parsed === 'object' && parsed !== null && 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID' in parsed
          ? parsed.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID : undefined;
        if (typeof id === 'string' && id !== '') resolve(id);
        else {
          console.error('Could not load the Google web client id from Azure.');
          fail();
        }
      } catch {
        console.error('Could not load the Google web client id from Azure.');
        fail();
      }
    });
  });
}

/** The client id from client/.env.local or the shell. Key Vault is used only when both are empty. */
export async function googleWebClientId(): Promise<string | null> {
  const local = clientFileId() ?? nonempty(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID);
  if (local !== undefined) return local;
  return loadWebClientId();
}
