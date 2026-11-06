import type { Connection } from 'mongoose';

import { createAccessRequestStore, type AccessRequestStore } from './access-requests.ts';
import { createAuditEventStore, type AuditEventStore } from './audit-events.ts';
import { createChatConversationStore, type ChatConversationStore } from './chat-conversations.ts';
import { createChatLiveTurnStore, type ChatLiveTurnStore } from './chat-live-turns.ts';
import { createChatProposalStore, type ChatProposalStore } from './chat-proposals.ts';
import { createChatUsageStore, type ChatUsageStore } from './chat-usage.ts';
import { createFileEntryStore, type FileEntryStore } from './file-entries.ts';
import { createFileStore, type FileStore } from './files.ts';
import { createFilesUsageStore, type FilesUsageStore } from './files-usage.ts';
import { createImportStore, type ImportStore } from './imports.ts';
import { createLocationStore, type LocationStore } from './locations.ts';
import { createMemberStore, type MemberStore } from './members.ts';
import { createNoteStore, type NoteStore } from './notes.ts';
import { createOrgStore, type OrgStore } from './orgs.ts';
import { createSalesDayStore, type SalesDayStore } from './sales-days.ts';
import { createUploadDayStore, type UploadDayStore } from './upload-days.ts';
import { createUploadStore, type UploadStore } from './uploads.ts';
import { createViewAsGrantStore, type ViewAsGrantStore } from './view-as-grants.ts';
import { createWelcomeStore, type WelcomeStore } from './welcomes.ts';

export interface TownwiseStores {
  readonly orgs: OrgStore;
  readonly requests: AccessRequestStore;
  readonly grants: ViewAsGrantStore;
  readonly audit: AuditEventStore;
  /** Tenant stores: every function takes an OrgScope first. */
  readonly members: MemberStore;
  readonly locations: LocationStore;
  readonly salesDays: SalesDayStore;
  readonly uploads: UploadStore;
  readonly notes: NoteStore;
  readonly chatConversations: ChatConversationStore;
  readonly chatLiveTurns: ChatLiveTurnStore;
  readonly chatUsage: ChatUsageStore;
  readonly chatProposals: ChatProposalStore;
  /** U11, statement moments. */
  readonly welcomes: WelcomeStore;
  /** Stored files (spec 11A). */
  readonly files: FileStore;
  readonly imports: ImportStore;
  readonly uploadDays: UploadDayStore;
  readonly fileEntries: FileEntryStore;
  readonly filesUsage: FilesUsageStore;
}

/** Registers every Townwise model on `connection`; call it before ensureIndexes. */
export function createTownwiseStores(connection: Connection): TownwiseStores {
  return {
    orgs: createOrgStore(connection),
    requests: createAccessRequestStore(connection),
    grants: createViewAsGrantStore(connection),
    audit: createAuditEventStore(connection),
    members: createMemberStore(connection),
    locations: createLocationStore(connection),
    salesDays: createSalesDayStore(connection),
    uploads: createUploadStore(connection),
    notes: createNoteStore(connection),
    chatConversations: createChatConversationStore(connection),
    chatLiveTurns: createChatLiveTurnStore(connection),
    chatUsage: createChatUsageStore(connection),
    chatProposals: createChatProposalStore(connection),
    // U11, statement moments.
    welcomes: createWelcomeStore(connection),
    files: createFileStore(connection),
    imports: createImportStore(connection),
    uploadDays: createUploadDayStore(connection),
    fileEntries: createFileEntryStore(connection),
    filesUsage: createFilesUsageStore(connection),
  };
}
