import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from 'jose';

export const CLIENT_IDS: readonly string[] = [
  '1111-web.apps.googleusercontent.com',
  '1111-ios.apps.googleusercontent.com',
  '1111-android.apps.googleusercontent.com',
];

export interface GoogleFake {
  readonly keys: JWTVerifyGetKey;
  signIdToken(claims: Record<string, unknown>, opts?: { header?: Record<string, unknown> }): Promise<string>;
}

const KID = 'google-test';

export async function createGoogleFake(): Promise<GoogleFake> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });
  return {
    keys,
    async signIdToken(claims, opts) {
      const now = Math.floor(Date.now() / 1000);
      const merged: Record<string, unknown> = {
        iss: 'https://accounts.google.com',
        aud: CLIENT_IDS[0],
        iat: now,
        exp: now + 3600,
        email_verified: true,
        ...claims,
      };
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(merged)) {
        if (key === 'iss' || key === 'sub' || key === 'aud' || key === 'iat' || key === 'exp') continue;
        rest[key] = value;
      }
      let builder = new SignJWT(rest).setProtectedHeader({
        alg: 'RS256',
        kid: KID,
        ...(opts?.header ?? {}),
      });
      if (typeof merged.iss === 'string') builder = builder.setIssuer(merged.iss);
      if (typeof merged.sub === 'string') builder = builder.setSubject(merged.sub);
      if (typeof merged.aud === 'string') builder = builder.setAudience(merged.aud);
      else if (Array.isArray(merged.aud) && merged.aud.every((item) => typeof item === 'string')) {
        builder = builder.setAudience(merged.aud);
      }
      if (typeof merged.iat === 'number') builder = builder.setIssuedAt(merged.iat);
      if (typeof merged.exp === 'number') builder = builder.setExpirationTime(merged.exp);
      return builder.sign(privateKey);
    },
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('jwks test server has no port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err !== undefined) reject(err);
      else resolve();
    });
  });
}

export async function startFailingJwks(
  mode: 'status500' | 'hang' | 'refused',
): Promise<{ keys: JWTVerifyGetKey; close(): Promise<void> }> {
  if (mode === 'refused') {
    const probe = createServer();
    const port = await listen(probe);
    await stop(probe);
    return {
      keys: createRemoteJWKSet(new URL(`http://127.0.0.1:${String(port)}/certs`), { timeoutDuration: 500 }),
      close: () => Promise.resolve(),
    };
  }
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    if (mode === 'status500') {
      res.writeHead(500);
      res.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  const port = await listen(server);
  return {
    keys: createRemoteJWKSet(new URL(`http://127.0.0.1:${String(port)}/certs`), { timeoutDuration: 500 }),
    async close() {
      for (const socket of sockets) socket.destroy();
      await stop(server);
    },
  };
}
