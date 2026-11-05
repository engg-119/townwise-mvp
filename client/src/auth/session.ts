import type { Session } from '../api/client';
import { createSecureTokenStore } from './tokens';

export function createSession(): Session {
  return { kind: 'bearer', tokens: createSecureTokenStore() };
}
