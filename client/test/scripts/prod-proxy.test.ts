import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

// scripts/prod-proxy.mts against a fake production API: what reaches production, and what read only refuses.

const root = join(__dirname, '../..');
const LOCAL = 'http://localhost:8081';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }
interface Answer { status: number; headers: IncomingHttpHeaders; body: string }

let upstream: Server;
let seen: Seen[] = [];
const proxies: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => { resolve(port); });
    });
  });
}

async function startProxy(...flags: string[]): Promise<number> {
  const port = await freePort();
  const { port: up } = upstream.address() as AddressInfo;
  const child = spawn(process.execPath, ['scripts/prod-proxy.mts', '--no-expo', '--port', String(port), '--upstream', `http://127.0.0.1:${String(up)}`, ...flags], { cwd: root });
  proxies.push(child);
  await new Promise<void>((resolve) => { child.stdout.on('data', () => { resolve(); }); });
  return port;
}

function send(port: number, method: string, path: string, headers: Record<string, string>, body = ''): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, {
        'content-type': 'application/json', 'set-cookie': '__Host-access=new; Path=/; Secure; HttpOnly; SameSite=Lax',
        'access-control-allow-origin': 'https://townwise.tech',
      });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
});

beforeEach(() => { seen = []; });

afterAll(async () => {
  for (const child of proxies) child.kill();
  await new Promise<void>((resolve) => { upstream.close(() => { resolve(); }); });
});

test('a read reaches production as townwise.tech, with only production’s cookies, and answers localhost', async () => {
  const port = await startProxy();
  const answer = await send(port, 'GET', '/api/me?x=1', { origin: LOCAL, cookie: 'access=local; refresh=local; __Host-access=prod; __Host-refresh=r' });
  expect(answer.status).toBe(200);
  expect(answer.headers['access-control-allow-origin']).toBe(LOCAL);
  expect(answer.headers['access-control-allow-credentials']).toBe('true');
  expect(answer.headers['set-cookie']).toEqual(['__Host-access=new; Path=/; Secure; HttpOnly; SameSite=Lax']);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe('/api/me?x=1');
  expect(seen[0]?.headers.origin).toBe('https://townwise.tech');
  expect(seen[0]?.headers.cookie).toBe('__Host-access=prod; __Host-refresh=r');
});

test('read only refuses a write before production sees it, but lets sign-in and refresh through', async () => {
  const port = await startProxy();
  const write = await send(port, 'POST', '/api/locations/l1/notes', { origin: LOCAL, 'content-type': 'application/json' }, '{}');
  expect(write.status).toBe(403);
  expect(JSON.parse(write.body)).toMatchObject({ error: 'read_only' });
  expect(seen).toHaveLength(0);
  expect((await send(port, 'POST', '/auth/refresh', { origin: LOCAL, 'content-type': 'application/json' }, '{"platform":"web"}')).status).toBe(200);
  expect(seen.map((each) => each.url)).toEqual(['/auth/refresh']);
});

test('--write forwards a write with its body', async () => {
  const port = await startProxy('--write');
  const answer = await send(port, 'PATCH', '/api/locations/l1', { origin: LOCAL, 'content-type': 'application/json' }, '{"name":"Hanover"}');
  expect(answer.status).toBe(200);
  expect(seen[0]).toMatchObject({ method: 'PATCH', body: '{"name":"Hanover"}' });
});

test('any other origin, no origin, or a path outside /api and /auth never reaches production', async () => {
  const port = await startProxy('--write');
  expect((await send(port, 'GET', '/api/me', { origin: 'http://localhost:3000' })).status).toBe(403);
  expect((await send(port, 'GET', '/api/me', {})).status).toBe(403);
  expect((await send(port, 'GET', '/lab/calibrations', { origin: LOCAL })).status).toBe(404);
  expect(seen).toHaveLength(0);
});
