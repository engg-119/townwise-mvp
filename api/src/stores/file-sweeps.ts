// tw_file_sweeps (spec 6.14): one document, `{ _id: 'sweeper', owner, leaseUntil, lastRunAt }`, the daily sweep's leader
// lease across replicas. Cross-tenant by nature, so only stores/cross-tenant.ts reads or writes it. Nothing here logs.
import { Schema, type Connection, type Model } from 'mongoose';

export const FILE_SWEEPS_COLLECTION = 'tw_file_sweeps';

interface FileSweepFields {
  _id: string;
  owner: string | null;
  leaseUntil: Date;
  lastRunAt: Date | null;
}

function fileSweepSchema(): Schema<FileSweepFields> {
  return new Schema<FileSweepFields>({
    _id: { type: String, required: true },
    owner: { type: String, default: null },
    leaseUntil: { type: Date, required: true },
    lastRunAt: { type: Date, default: null },
  }, { strict: 'throw', versionKey: false, read: 'primary' });
}

/** Registers TwFileSweep (tw_file_sweeps) on first call. */
export function fileSweepModel(connection: Connection): Model<FileSweepFields> {
  const existing = connection.models.TwFileSweep as Model<FileSweepFields> | undefined;
  return existing ?? connection.model<FileSweepFields>('TwFileSweep', fileSweepSchema(), FILE_SWEEPS_COLLECTION);
}
