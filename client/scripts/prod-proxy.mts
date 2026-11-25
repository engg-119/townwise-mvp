// Localhost on production's data: `npm run start:prod` (read only) or `npm run start:prod -- --write`, from client/.
//
// The web app keeps its session in httpOnly cookies on a same-site API, and production's API answers only
// https://townwise.tech, so localhost:8081 cannot call api.townwise.tech itself. This proxy listens on 127.0.0.1:8085,
// which is same-site with localhost:8081, and forwards /api and /auth to production as townwise.tech would: Origin
// rewritten to https://townwise.tech, and only production's __Host- cookies sent on (the local API's cookies are named
// access and refresh, so the two sessions never mix). It then starts Expo on :8081 with EXPO_PUBLIC_API_URL pointed here.
// Sign in with Google as usual: production accepts the local web client id.
//
// Read only by default: every request but GET and HEAD gets 403 read_only, except signing in, refreshing and signing
// out. --write forwards everything, so an edit on localhost changes production. Requests from any origin but
// http://localhost:8081 are refused. --no-expo runs the proxy alone; --port <n> and --upstream <url> move it (tests).
import { spawn } from 'node:child_process';
import { googleWebClientId } from './azure-dev.mts';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_WEB = 'http://localhost:8081';
const PROD_WEB = 'https://townwise.tech';
const SIGN_IN = new Set(['/auth/google', '/auth/magic-link', '/auth/magic-link/redeem', '/auth/mfa/verify', '/auth/refresh', '/auth/logout']);

const args = process.argv.slice(2);
const write = args.includes('--write');
const upstreamAt = args.indexOf('--upstream');
const upstream = new URL(upstreamAt === -1 ? 'https://api.townwise.tech' : args[upstreamAt + 1] ?? '');
const portAt = args.indexOf('--port');
const PORT = portAt === -1 ? 8085 : Number(args[portAt + 1]);

function refuse(res: ServerResponse, status: number, error: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': LOCAL_WEB, 'access-control-allow-credentials': 'true', vary: 'Origin' });
  res.end(JSON.stringify({ error, message }));
}

/** Production's own cookies only: the local API's (access, refresh) and anything else on localhost stay here. */
function prodCookies(header: string | undefined): string | null {
  const kept = (header ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith('__Host-'));
  return kept.length === 0 ? null : kept.join('; ');
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = { origin: PROD_WEB, 'user-agent': 'townwise-prod-proxy' };
  for (const name of ['accept', 'content-type', 'content-length', 'last-event-id']) {
    const value = headers[name];
    if (typeof value === 'string') out[name] = value;
  }
  const cookie = prodCookies(headers.cookie);
  if (cookie !== null) out.cookie = cookie;
  return out;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (req.headers.origin !== LOCAL_WEB) { refuse(res, 403, 'origin_not_allowed', `Only ${LOCAL_WEB} may use this proxy`); return; }
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': LOCAL_WEB, 'access-control-allow-credentials': 'true', vary: 'Origin',
      'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? 'content-type', 'access-control-max-age': '600',
    });
    res.end();
    return;
  }
  if (!path.startsWith('/api/') && !path.startsWith('/auth/')) { refuse(res, 404, 'not_found', 'Not found'); return; }
  if (!write && method !== 'GET' && method !== 'HEAD' && !SIGN_IN.has(path)) {
    refuse(res, 403, 'read_only', 'Localhost is on production read only. Restart with --write to make changes.'); return;
  }
  const target = new URL(req.url ?? '/', upstream);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const out = send(target, { method, headers: forwardHeaders(req.headers) }, (answer) => {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(answer.headers)) {
      if (value === undefined || name.startsWith('access-control-') || name === 'strict-transport-security' || name === 'vary') continue;
      headers[name] = value;
    }
    res.writeHead(answer.statusCode ?? 502, { ...headers, 'access-control-allow-origin': LOCAL_WEB, 'access-control-allow-credentials': 'true', vary: 'Origin' });
    answer.pipe(res);
  });
  out.on('error', () => {
    if (res.headersSent) res.destroy();
    else refuse(res, 502, 'upstream_unreachable', `Could not reach ${upstream.origin}`);
  });
  req.pipe(out);
}

function inUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { resolve(false); });
  });
}

const server = createServer(handle);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`prod proxy: http://localhost:${String(PORT)} -> ${upstream.origin}, ${write ? 'READ AND WRITE: changes on localhost change production' : 'read only'}`);
  if (args.includes('--no-expo')) return;
  void inUse(8081).then((busy) => {
    if (busy) {
      console.error('Port 8081 is in use. Stop your local Expo first: Google sign-in only works from localhost:8081.');
      server.close();
      process.exitCode = 1;
      return;
    }
    const client = join(dirname(fileURLToPath(import.meta.url)), '..');
    void googleWebClientId().then((clientId) => {
      if (clientId === null) {
        server.close();
        process.exitCode = 1;
        return;
      }
      const expo = spawn('npx', ['expo', 'start', '--port', '8081', '--clear'], {
        cwd: client, stdio: 'inherit',
        env: { ...process.env, EXPO_PUBLIC_API_URL: `http://localhost:${String(PORT)}`, EXPO_PUBLIC_WEB_URL: LOCAL_WEB, EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: clientId },
      });
      expo.on('exit', (code) => { server.close(); process.exitCode = code ?? 0; });
    });
  });
});
