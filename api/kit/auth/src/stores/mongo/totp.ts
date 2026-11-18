import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Schema, trusted, type Connection, type Model } from 'mongoose';

import type { TotpFactorRecord, TotpStore } from '../types.ts';

interface TotpFields {
  _id: string;
  status: 'pending' | 'enabled';
  secretEnc: string;
  pendingExpiresAt: Date | null;
  enabledAt: Date | null;
  lastUsedStep: number;
  recoveryCodeHashes: string[];
  pendingSecretEnc?: string | null;
  pendingSessionId?: string | null;
}

function totpSchema(): Schema<TotpFields> {
  return new Schema<TotpFields>({
    _id: { type: String, required: true },
    status: { type: String, required: true },
    secretEnc: { type: String, required: true },
    pendingExpiresAt: { type: Date, default: null },
    enabledAt: { type: Date, default: null },
    lastUsedStep: { type: Number, required: true },
    recoveryCodeHashes: { type: [String], required: true },
    pendingSecretEnc: { type: String, default: null },
    pendingSessionId: { type: String, default: null },
  }, { strict: true, versionKey: false, read: 'primary' });
}

function toFactor(doc: TotpFields): TotpFactorRecord {
  return {
    userId: doc._id,
    status: doc.status,
    secretEnc: doc.secretEnc,
    pendingExpiresAt: doc.pendingExpiresAt,
    enabledAt: doc.enabledAt,
    lastUsedStep: doc.lastUsedStep,
    recoveryCodeHashes: doc.recoveryCodeHashes,
    pendingSecretEnc: doc.pendingSecretEnc ?? null,
    pendingSessionId: doc.pendingSessionId ?? null,
  };
}

export function createTotpStore(connection: Connection): TotpStore {
  const existing = connection.models.AuthTotp as Model<TotpFields> | undefined;
  const Totp = existing ?? connection.model<TotpFields>('AuthTotp', totpSchema(), 'auth_totp');

  return {
    async get(userId: string): Promise<TotpFactorRecord | null> {
      const doc = await Totp.findById(userId);
      return doc === null ? null : toFactor(doc);
    },
    async startEnrollment(input): Promise<boolean> {
      const update = {
        $set: {
          status: 'pending' as const,
          secretEnc: input.secretEnc,
          pendingExpiresAt: input.pendingExpiresAt,
          lastUsedStep: -1,
          recoveryCodeHashes: [] as string[],
        },
        $unset: { enabledAt: '' as const, pendingSecretEnc: '' as const, pendingSessionId: '' as const },
      };
      const filter = {
        _id: input.userId,
        status: trusted({ $ne: 'enabled' }),
      } as never;
      try {
        await Totp.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
        return true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const doc = await Totp.findOneAndUpdate(filter, update, { returnDocument: 'after' });
        return doc !== null;
      }
    },
    async confirmEnrollment(input): Promise<boolean> {
      const doc = await Totp.findOneAndUpdate(
        {
          _id: input.userId,
          status: 'pending',
          pendingExpiresAt: trusted({ $gt: input.now }),
        },
        {
          $set: {
            status: 'enabled',
            lastUsedStep: input.step,
            recoveryCodeHashes: [...input.recoveryCodeHashes],
            enabledAt: input.now,
          },
          $unset: { pendingExpiresAt: '' },
        },
        { returnDocument: 'after' },
      );
      return doc !== null;
    },
    async claimStep(input): Promise<boolean> {
      const set: { lastUsedStep: number; secretEnc?: string } = { lastUsedStep: input.step };
      if (input.secretEnc !== undefined) set.secretEnc = input.secretEnc;
      const doc = await Totp.findOneAndUpdate(
        { _id: input.userId, status: 'enabled', secretEnc: input.verifiedSecretEnc, lastUsedStep: trusted({ $lt: input.step }) },
        { $set: set },
        { returnDocument: 'after' },
      );
      return doc !== null;
    },
    async consumeRecoveryCode(input): Promise<boolean> {
      const doc = await Totp.findOneAndUpdate(
        { _id: input.userId, status: 'enabled', recoveryCodeHashes: input.codeHash },
        { $pull: { recoveryCodeHashes: input.codeHash } },
        { returnDocument: 'after' },
      );
      return doc !== null;
    },
    async startReset(input): Promise<boolean> {
      const doc = await Totp.findOneAndUpdate(
        { _id: input.userId, status: 'enabled' },
        {
          $set: {
            pendingSecretEnc: input.pendingSecretEnc,
            pendingExpiresAt: input.pendingExpiresAt,
            pendingSessionId: input.sessionId,
          },
        },
        { returnDocument: 'after' },
      );
      return doc !== null;
    },
    async confirmReset(input): Promise<boolean> {
      const doc = await Totp.findOneAndUpdate(
        {
          _id: input.userId,
          status: 'enabled',
          pendingSecretEnc: input.pendingSecretEnc,
          pendingSessionId: input.sessionId,
          pendingExpiresAt: trusted({ $gt: input.now }),
        },
        {
          $set: {
            secretEnc: input.pendingSecretEnc,
            lastUsedStep: input.step,
            recoveryCodeHashes: [...input.recoveryCodeHashes],
          },
          $unset: { pendingSecretEnc: '', pendingExpiresAt: '', pendingSessionId: '' },
        },
        { returnDocument: 'after' },
      );
      return doc !== null;
    },
    async remove(userId: string): Promise<void> {
      await Totp.deleteOne({ _id: userId });
    },
  };
}
