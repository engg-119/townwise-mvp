export type Platform = 'web' | 'native';
export type RevokeReason =
  | 'logout' | 'logout_all' | 'refresh_reuse' | 'totp_enabled' | 'user_missing' | 'app_revoked';

export interface User {
  readonly id: string;                 // 24-hex ObjectId
  readonly email: string;              // normalized
  readonly googleSubject: string | null;
  readonly createdAt: Date;
}

export interface UserStore {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByGoogleSubject(subject: string): Promise<User | null>;
  /** Throws DuplicateError('email' | 'googleSubject'). */
  create(input: { email: string; googleSubject?: string; now: Date }): Promise<User>;
  /** CAS: sets googleSubject only if unset; null if the user already has one. DuplicateError('googleSubject') if taken. */
  linkGoogleSubject(input: { id: string; subject: string }): Promise<User | null>;
  /** CAS on the current email; null if it changed meanwhile. DuplicateError('email') if another user has `to`. */
  updateEmail(input: { id: string; from: string; to: string }): Promise<User | null>;
}

export interface SessionRecord {
  readonly id: string;                 // uuid
  readonly userId: string;
  readonly platform: Platform;
  readonly refreshHash: string;
  readonly previousRefreshHash: string | null;
  readonly createdAt: Date;            // first-factor time; never moves
  readonly lastUsedAt: Date;           // set by normal rotations only: idle clock and grace clock
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokeReason: RevokeReason | null;
}

/** live = revokedAt null AND absoluteExpiresAt > now AND lastUsedAt > idleCutoff */
export interface LiveWindow { readonly now: Date; readonly idleCutoff: Date }

export interface SessionStore {
  create(input: { id: string; userId: string; platform: Platform; refreshHash: string;
                  now: Date; absoluteExpiresAt: Date }): Promise<SessionRecord>;
  findLive(id: string, w: LiveWindow): Promise<SessionRecord | null>;
  /** CAS on refreshHash = currentHash, platform, live. Sets refreshHash = newHash, previousRefreshHash = currentHash,
   *  lastUsedAt = now; records currentHash in the retired ledger before resolving. */
  rotate(input: { currentHash: string; newHash: string; platform: Platform } & LiveWindow): Promise<SessionRecord | null>;
  /** The session whose previousRefreshHash is `hash` on this platform, live or not. */
  findByPreviousHash(hash: string, platform: Platform): Promise<SessionRecord | null>;
  /** CAS on id, previousRefreshHash = previousHash, refreshHash = expectedCurrentHash, live. Sets refreshHash = newHash,
   *  previousRefreshHash = expectedCurrentHash; lastUsedAt unchanged; records expectedCurrentHash as retired. */
  rotateFromPrevious(input: { id: string; previousHash: string; expectedCurrentHash: string; newHash: string }
                     & LiveWindow): Promise<SessionRecord | null>;
  /** The session that once held `hash` (retired ledger) on this platform, live or not. */
  findByRetiredHash(hash: string, platform: Platform): Promise<SessionRecord | null>;
  /** Idempotent; true if this call revoked it. */
  revoke(input: { id: string; reason: RevokeReason; now: Date }): Promise<boolean>;
  /** One conditional update: revokes the live session whose current hash is `hash`. */
  revokeByRefreshHash(input: { hash: string; platform: Platform; reason: RevokeReason; now: Date }): Promise<boolean>;
  revokeAllForUser(input: { userId: string; reason: RevokeReason; now: Date; exceptId?: string }): Promise<number>;
}

export interface MagicLinkStore {
  create(input: { tokenHash: string; email: string; platform: Platform; createdAt: Date; expiresAt: Date }): Promise<void>;
  /** Atomic: marks consumed if hash, email and platform match and it is unconsumed and unexpired. */
  consume(input: { tokenHash: string; email: string; platform: Platform; now: Date }): Promise<boolean>;
  deleteForEmail(email: string): Promise<number>;
}

export interface TotpFactorRecord {
  readonly userId: string;
  readonly status: 'pending' | 'enabled';
  readonly secretEnc: string;          // createTokenCrypto output (2.9)
  readonly pendingExpiresAt: Date | null;
  readonly enabledAt: Date | null;
  readonly lastUsedStep: number;       // -1 before first use
  readonly recoveryCodeHashes: readonly string[];
  /** A reset in progress on an enabled factor: the new secret, until `pendingExpiresAt`, for one session. Null otherwise. */
  readonly pendingSecretEnc: string | null;
  readonly pendingSessionId: string | null;
}

export interface TotpStore {
  get(userId: string): Promise<TotpFactorRecord | null>;
  /** Replaces a pending factor; false (no write) if an enabled factor exists. */
  startEnrollment(input: { userId: string; secretEnc: string; pendingExpiresAt: Date }): Promise<boolean>;
  /** CAS pending AND pendingExpiresAt > now: enabled, lastUsedStep = step, recovery hashes set. */
  confirmEnrollment(input: { userId: string; step: number; recoveryCodeHashes: readonly string[]; now: Date }): Promise<boolean>;
  /**
   * CAS enabled AND secretEnc is `verifiedSecretEnc` AND lastUsedStep < step; also replaces secretEnc when given
   * (lazy re-encryption). `verifiedSecretEnc` is the ciphertext the code was checked against, so a code checked
   * against a secret a reset has since replaced claims nothing and writes nothing.
   */
  claimStep(input: { userId: string; step: number; verifiedSecretEnc: string; secretEnc?: string }): Promise<boolean>;
  /** Atomic $pull; true if the hash was present. */
  consumeRecoveryCode(input: { userId: string; codeHash: string }): Promise<boolean>;
  /** CAS enabled: sets the pending secret, its expiry and its session, replacing any earlier one. The live secret is untouched. */
  startReset(input: { userId: string; pendingSecretEnc: string; pendingExpiresAt: Date; sessionId: string }): Promise<boolean>;
  /**
   * CAS enabled AND this pending secret AND this session AND pendingExpiresAt > now: the pending secret becomes the
   * secret, lastUsedStep = step, the recovery hashes are replaced and the pending fields cleared.
   */
  confirmReset(input: {
    userId: string; pendingSecretEnc: string; sessionId: string; step: number; recoveryCodeHashes: readonly string[]; now: Date;
  }): Promise<boolean>;
  remove(userId: string): Promise<void>;
}

export interface AuthStores {
  readonly users: UserStore; readonly sessions: SessionStore;
  readonly magicLinks: MagicLinkStore; readonly totp: TotpStore;
}

export class DuplicateError extends Error {
  readonly field: 'email' | 'googleSubject';
  constructor(field: 'email' | 'googleSubject') {
    super(`duplicate ${field}`);
    this.name = 'DuplicateError';
    this.field = field;
  }
}
