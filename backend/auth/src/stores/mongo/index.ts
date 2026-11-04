import type { Connection } from 'mongoose';

import type { AuthStores } from '../types.ts';
import { createMagicLinkStore } from './magic-links.ts';
import { createSessionStore } from './sessions.ts';
import { createTotpStore } from './totp.ts';
import { createUserStore } from './users.ts';

/** Registers AuthUser, AuthSession, AuthRefreshRetired, AuthMagicLink and AuthTotp on `connection`. */
export function createMongoAuthStores(connection: Connection): AuthStores {
  return {
    users: createUserStore(connection),
    sessions: createSessionStore(connection),
    magicLinks: createMagicLinkStore(connection),
    totp: createTotpStore(connection),
  };
}
