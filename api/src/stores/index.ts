import type { Connection } from 'mongoose';

import { createAccessRequestStore, type AccessRequestStore } from './access-requests.ts';
import { createAuditEventStore, type AuditEventStore } from './audit-events.ts';
import { createChatConversationStore, type ChatConversationStore } from './chat-conversations.ts';
import { createChatLiveTurnStore, type ChatLiveTurnStore } from './chat-live-turns.ts';
import { createChatUsageStore, type ChatUsageStore } from './chat-usage.ts';
import { createLocationStore, type LocationStore } from './locations.ts';
import { createMemberStore, type MemberStore } from './members.ts';
import { createNoteStore, type NoteStore } from './notes.ts';
import { createOrgStore, type OrgStore } from './orgs.ts';
import { createSalesDayStore, type SalesDayStore } from './sales-days.ts';
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
  /** U11, statement moments. */
  readonly welcomes: WelcomeStore;
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
    // U11, statement moments.
    welcomes: createWelcomeStore(connection),
  };
}
