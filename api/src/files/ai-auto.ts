// Automatic reads (D59, openspec change auto-apply-agent-reads design decision 1): once Townwise has finished a stored
// file (a reference item kept, pasted text saved (slice 4), or a dropped file read, kept or failed with its original),
// TownwiseAI reads it on its own, as D34's read but queued `auto` with the file's adder as the person it reads for, while
// TOWNWISE_AGENT_AUTO and the organization's own switch are both on and TownwiseAI can read files here. Never a file
// read into sales days (a point-of-sale export, whose meaning is already in Townwise as numbers and which can hold
// diners' names), a calendar export, a summary or item TownwiseAI kept, a file turned off (D28), or a file whose upload
// or paste did not finish with its box checked (`aiAuto: true` on complete or on pasted text's save: a chat attachment,
// an item's edit, text TownwiseAI proposed keeping and an older client never send it). [CONFIRM: a file read into
// sales days is not sent to TownwiseAI automatically] The reader (files/ai-reader.ts) bounds what runs: duplicates, 20 a
// day and the $1 reserve. Logs carry ids only, never a file name.
import type { Logger } from '@ckeith26/server-core';

import type { OrgScope } from '../access/policy.ts';
import type { FileRecord, FileStatus } from '../stores/files.ts';
import type { TownwiseStores } from '../stores/index.ts';
import { isCalendarFileName } from './sniff.ts';

/** The statuses a file the reader is done with ends in. */
const FINISHED: readonly FileStatus[] = ['read', 'kept', 'failed'];

export interface AutoReadDeps {
  readonly stores: Pick<TownwiseStores, 'files' | 'orgs'>;
  readonly logger: Logger;
  readonly now: () => Date;
  /** TOWNWISE_AGENT_AUTO is true and TownwiseAI reads files in this process (ANTHROPIC_API_KEY, stored files, a budget). */
  readonly on: boolean;
}

/**
 * Whether the file is one TownwiseAI reads on its own (the top), by the file alone. Pure. A calendar file (D60: an .ics
 * or .ical, which Your data imports as a calendar and D59 slice 2 sorts) is never read as a document on its own, so its
 * events are not also written as notes; a person may still press Read with TownwiseAI.
 */
export function autoReadable(file: FileRecord): boolean {
  return FINISHED.includes(file.status) && file.rawDeletedAt === null && file.disabledAt === null && file.ai === null && !file.aiAutoOff
    && file.uploadId === null && (file.result?.dayCount ?? 0) === 0 && file.outcome !== 'calendar_export'
    && file.addedVia === null && file.source === null && !file.purgeRaw && !isCalendarFileName(file.name);
}

/**
 * Queues an automatic read of `file` when it qualifies (the top). Never throws: a failure is logged by the file's id and
 * the file stays as Townwise stored it, so a person can still press Read with TownwiseAI. Resolves whether it queued.
 */
export async function queueAutoRead(deps: AutoReadDeps, scope: OrgScope, file: FileRecord): Promise<boolean> {
  if (!deps.on || !autoReadable(file)) return false;
  try {
    const org = await deps.stores.orgs.findById(scope.orgId);
    if (org?.status !== 'active' || !org.agentAuto.on) return false;
    const queued = await deps.stores.files.requestAutoRead(scope, file.locationId, file.id, {
      by: file.uploadedBy, role: file.uploaderRole, byStaff: file.byStaff, grantId: file.openAsAdminGrantId, at: deps.now(),
    });
    if (queued === null) return false;
    deps.logger.info({ orgId: scope.orgId, locationId: file.locationId, fileId: file.id }, 'townwise.ai_read_auto_queued');
    return true;
  } catch (err) {
    deps.logger.warn({ fileId: file.id, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.ai_read_auto_queue_failed');
    return false;
  }
}
