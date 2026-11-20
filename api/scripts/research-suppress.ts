// Staff suppression of a shared town row (D66, openspec change town-research-agent, design decision 9): a researched
// town event wrong for everyone in the town (a wrong date, a defamatory or injection-bearing title) is taken down for
// every organization at once. It sets the row's `suppressed { at, code }`, so every read and every prompt leaves it out
// and a merge never clears it, and writes the audit event `research.town_event_suppressed { townKey, eventId, code }`
// with the staff actor. A member's hide changes only their own location; this is the only way to take a town row down
// for every tenant. It logs ids only, never a title.
//
//   MONGODB_URI=... TOWNWISE_SUPERADMIN_EMAILS=... node scripts/research-suppress.ts <townKey> <t-eventId> <code> <staffUserId> <staffEmail>
//
// It refuses without a staff user id and an email listed in TOWNWISE_SUPERADMIN_EMAILS, and refuses a code that is not
// a short lowercase word (`wrong_date`, `not_an_event`, `harmful`): the code is stored and audited, so it never holds
// free text.
import { fileURLToPath } from 'node:url';

import { connectMongo } from '@ckeith26/mongo';
import { createLogger } from '@ckeith26/server-core';

import { parseResearchedId } from '../src/research/read.ts';
import { isTownId } from '../src/research/plan.ts';
import { createTownwiseStores, type TownwiseStores } from '../src/stores/index.ts';
import type { TownId } from '../src/towns.ts';

export interface SuppressInput {
  readonly townKey: TownId;
  /** The row's hex id (its view id without `t-`). */
  readonly eventHex: string;
  readonly code: string;
  readonly staffUserId: string;
  readonly staffEmail: string;
}

const CODE = /^[a-z][a-z_]{0,39}$/;

/** The arguments as a suppression, or why they do not parse. `staffEmails` is TOWNWISE_SUPERADMIN_EMAILS's list. */
export function parseSuppressArgs(argv: readonly string[], staffEmails: readonly string[]): SuppressInput | string {
  const [townKey = '', eventId = '', code = '', staffUserId = '', staffEmail = ''] = argv;
  if (!isTownId(townKey)) return 'The first argument is a town key of the twelve, such as hanover-nh.';
  const parsed = parseResearchedId(eventId.startsWith('t-') ? eventId : `t-${eventId}`);
  if (parsed?.kind !== 'town') return 'The second argument is a town event id: t- and 24 hex characters.';
  if (!CODE.test(code)) return 'The third argument is a code: a short lowercase word such as wrong_date (letters and _ only).';
  if (staffUserId.trim() === '') return 'The fourth argument is your staff user id.';
  const email = staffEmail.trim().toLowerCase();
  if (!staffEmails.map((each) => each.trim().toLowerCase()).includes(email)) {
    return 'The fifth argument is your staff email, as TOWNWISE_SUPERADMIN_EMAILS lists it.';
  }
  return { townKey, eventHex: parsed.hex, code, staffUserId: staffUserId.trim(), staffEmail: email };
}

/** Suppresses the row and records the audit event; false (and no audit) when the town holds no such row. */
export async function suppressTownEvent(deps: { readonly stores: TownwiseStores; readonly now: () => Date }, input: SuppressInput): Promise<boolean> {
  const at = deps.now();
  if (!await deps.stores.researchTowns.suppress(input.townKey, input.eventHex, { at, code: input.code })) return false;
  const eventId = `t-${input.eventHex}`;
  await deps.stores.audit.insert({
    at, actorUserId: input.staffUserId, actorEmail: input.staffEmail, actorRole: 'superadmin', viewAsGrantId: null, orgId: null,
    action: 'research.town_event_suppressed', target: { type: 'research_event', id: eventId },
    details: { townKey: input.townKey, eventId, code: input.code },
  });
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = parseSuppressArgs(process.argv.slice(2), (process.env.TOWNWISE_SUPERADMIN_EMAILS ?? '').split(','));
  if (typeof input === 'string') {
    console.error(input);
    process.exitCode = 1;
  } else {
    const logger = createLogger({ LOG_LEVEL: 'info' });
    const mongo = await connectMongo({
      config: { MONGODB_URI: process.env.MONGODB_URI ?? '', NODE_ENV: process.env.NODE_ENV === 'production' ? 'production' : 'development' },
      logger,
    });
    try {
      const done = await suppressTownEvent({ stores: createTownwiseStores(mongo.connection), now: () => new Date() }, input);
      logger.info({ townKey: input.townKey, eventId: `t-${input.eventHex}`, code: input.code, suppressed: done }, 'townwise.research_town_event_suppressed');
      if (!done) {
        console.error('No such event in that town.');
        process.exitCode = 1;
      }
    } finally {
      await mongo.connection.close();
    }
  }
}
