import type { Session } from '../api/client';

export function createSession(): Session {
  return { kind: 'cookie' };
}
