// `npm run dev:prod-copy -w @townwise/api`: the local API, watching edits as `npm run dev` does, on the production copy
// that infra/scripts/db-pull-prod.sh restores into townwise_prod (prod-copy-env.ts says what changes). Stop the usual
// API first: this one takes the same port, so the local web app and Google sign-in work unchanged.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { PROD_COPY_DB, prodCopyEnv } from './prod-copy-env.ts';

const api = new URL('..', import.meta.url);
const file = parseEnv(readFileSync(new URL('.env.local', api), 'utf8'));
// As with --env-file, a variable already in the environment wins over the file.
const env = prodCopyEnv({ ...file, ...process.env });
console.log(`API on the production copy (${PROD_COPY_DB}); stored files, email and calendars are off`);
const child = spawn(process.execPath, ['--watch', 'src/main.ts'], { cwd: api, stdio: 'inherit', env });
child.on('exit', (code) => { process.exitCode = code ?? 0; });
