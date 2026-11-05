export { createAuth, authOf } from './create-auth.ts';
export type { Auth, AuthDeps, AuthContext, MagicLinkMessage, SignInResult, PublicUser } from './create-auth.ts';
export { configSchema } from './config.ts';
export type { AuthConfig } from './config.ts';
export { createMongoAuthStores } from './stores/mongo/index.ts';
export { DuplicateError } from './stores/types.ts';
export type {
  AuthStores, UserStore, SessionStore, MagicLinkStore, TotpStore,
  User, SessionRecord, LiveWindow, Platform, RevokeReason, TotpFactorRecord,
} from './stores/types.ts';
