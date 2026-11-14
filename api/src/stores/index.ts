import type { Connection } from 'mongoose';

import { createAccessRequestStore, type AccessRequestStore } from './access-requests.ts';
import { createAgentAnswerStore, type AgentAnswerStore } from './agent-answers.ts';
import { createAuditEventStore, type AuditEventStore } from './audit-events.ts';
import { createBusinessRuleStore, type BusinessRuleStore } from './business-rules.ts';
import { createCalibrationStore, type CalibrationStore } from './calibrations.ts';
import { createChatConversationStore, type ChatConversationStore } from './chat-conversations.ts';
import { createChatLiveTurnStore, type ChatLiveTurnStore } from './chat-live-turns.ts';
import { createChatProposalStore, type ChatProposalStore } from './chat-proposals.ts';
import { createChatUsageStore, type ChatUsageStore } from './chat-usage.ts';
import { createFileEntryStore, type FileEntryStore } from './file-entries.ts';
import { fileSweepModel } from './file-sweeps.ts';
import { createFileStore, type FileStore } from './files.ts';
import { createFilesUsageStore, type FilesUsageStore } from './files-usage.ts';
import { createForecastStore, type ForecastStore } from './forecasts.ts';
import { createImportStore, type ImportStore } from './imports.ts';
import { createItemSalesStore, type ItemSalesStore } from './item-sales.ts';
import { createLocationStore, type LocationStore } from './locations.ts';
import { createMemberStore, type MemberStore } from './members.ts';
import { createNoteStore, type NoteStore } from './notes.ts';
import { createOrderCountStore, type OrderCountStore } from './order-counts.ts';
import { createOrderSetupStore, type OrderSetupStore } from './order-setups.ts';
import { createOrderStore, type OrderStore } from './orders.ts';
import { createOrgStore, type OrgStore } from './orgs.ts';
import { createProfileStore, type ProfileStore } from './profiles.ts';
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
  readonly orders: OrderStore;
  /** Orders: a location's setup, item sales by day and counts by day. */
  readonly orderSetups: OrderSetupStore;
  readonly itemSales: ItemSalesStore;
  readonly orderCounts: OrderCountStore;
  /** Business rules TownwiseAI reads with every message (spec 6.24). */
  readonly businessRules: BusinessRuleStore;
  readonly chatConversations: ChatConversationStore;
  readonly chatLiveTurns: ChatLiveTurnStore;
  readonly chatUsage: ChatUsageStore;
  readonly chatProposals: ChatProposalStore;
  /** U9, TownwiseAI's questions. */
  readonly agentAnswers: AgentAnswerStore;
  /** U11, statement moments. */
  readonly welcomes: WelcomeStore;
  /** The display name for TownwiseAI's greeting (account-level, spec 6.22). */
  readonly profiles: ProfileStore;
  /** Stored files (spec 11A). */
  readonly files: FileStore;
  readonly imports: ImportStore;
  readonly uploadDays: UploadDayStore;
  readonly fileEntries: FileEntryStore;
  readonly filesUsage: FilesUsageStore;
  /** U13B, forecast runs (spec 14.4). */
  readonly forecasts: ForecastStore;
  /** The forecast lab's calibrations. */
  readonly calibrations: CalibrationStore;
}

/** Registers every Townwise model on `connection`; call it before ensureIndexes. */
export function createTownwiseStores(connection: Connection): TownwiseStores {
  // The file sweep's lease (cross-tenant, read only through stores/cross-tenant.ts) registers with the rest.
  fileSweepModel(connection);
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
    orders: createOrderStore(connection),
    orderSetups: createOrderSetupStore(connection),
    itemSales: createItemSalesStore(connection),
    orderCounts: createOrderCountStore(connection),
    businessRules: createBusinessRuleStore(connection),
    chatConversations: createChatConversationStore(connection),
    chatLiveTurns: createChatLiveTurnStore(connection),
    chatUsage: createChatUsageStore(connection),
    chatProposals: createChatProposalStore(connection),
    // U9, TownwiseAI's questions.
    agentAnswers: createAgentAnswerStore(connection),
    // U11, statement moments.
    welcomes: createWelcomeStore(connection),
    profiles: createProfileStore(connection),
    files: createFileStore(connection),
    imports: createImportStore(connection),
    uploadDays: createUploadDayStore(connection),
    fileEntries: createFileEntryStore(connection),
    filesUsage: createFilesUsageStore(connection),
    // U13B, forecast runs.
    forecasts: createForecastStore(connection),
    // The forecast lab.
    calibrations: createCalibrationStore(connection),
  };
}
