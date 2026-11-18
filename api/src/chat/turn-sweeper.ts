// The TownwiseAI turn sweep (openspec change resumable-chat-turns, design decisions 1 and 2): a loop in each API replica,
// shaped like the TownwiseAI reader (files/ai-reader.ts). Every 15 seconds it finds, through stores/cross-tenant.ts, the
// running turns whose lease has passed (their replica died, or shut down without settling them) and settles each as
// interrupted, in an order a retry completes: the conversation's claim (deleting a conversation that never finished a
// turn), the person's claim, then the record, with its last `error { code: "interrupted" }` event. A turn is never
// continued here. It also deletes each record 15 minutes after its turn ended; the saved conversation is then the only
// copy. Both replicas may sweep the same record: every step is keyed to the turn id, and the record's end is a
// compare-and-set. Logs carry ids and counts only, never a message, a reply or anything a tool showed.
import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForStaleChatTurn } from '../access/policy.ts';
import { removeEndedChatTurns, staleChatTurns } from '../stores/cross-tenant.ts';
import { settleInterrupted, type SettleStores } from './turn-runner.ts';

/** How often each replica sweeps. With the 30-second lease, a dead turn is settled within about 45 seconds. */
const POLL_MS = 15_000;
/** How long a record outlives its turn, for a reader that lost its connection near the end. */
export const ENDED_TURN_KEPT_MS = 15 * 60 * 1000;
/** The most stale turns one sweep settles; the next sweep takes the rest. */
const BATCH = 50;

export interface TurnSweeperDeps {
  readonly connection: Connection;
  readonly stores: SettleStores;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Tests sweep by hand with sweep(). */
  readonly pollMs?: number;
}

export interface TurnSweeper {
  readonly name: string;
  start(): void;
  /** One sweep: settles the stale turns it finds and deletes the records past their keep. Never rejects. */
  sweep(): Promise<void>;
  close(): Promise<void>;
}

function errTypeOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

export function createTurnSweeper(deps: TurnSweeperDeps): TurnSweeper {
  const { connection, stores, logger, now } = deps;
  let poll: NodeJS.Timeout | undefined;
  let busy: Promise<void> | null = null;
  let stopped = false;

  async function sweepOnce(): Promise<void> {
    const at = now();
    let settled = 0;
    let failed = 0;
    let removed = 0;
    let found = 0;
    try {
      const stale = await staleChatTurns(connection, at, BATCH);
      found = stale.length;
      for (const turn of stale) {
        if (stopped) break;
        try {
          if (await settleInterrupted(stores, scopeForStaleChatTurn(turn), turn, at)) settled += 1;
        } catch (err) {
          // Left running: the next sweep finds it again and repeats the steps, each keyed to the turn id.
          failed += 1;
          logger.warn({
            orgId: turn.orgId, locationId: turn.locationId, conversationId: turn.conversationId, errType: errTypeOf(err),
          }, 'townwise.chat_turn_not_settled');
        }
      }
      removed = await removeEndedChatTurns(connection, new Date(at.getTime() - ENDED_TURN_KEPT_MS));
    } catch (err) {
      logger.warn({ errType: errTypeOf(err) }, 'townwise.chat_turn_sweep_failed');
    }
    if (found > 0 || removed > 0) logger.info({ found, settled, failed, removed }, 'townwise.chat_turns_swept');
  }

  const sweeper: TurnSweeper = {
    name: 'chat-turn-sweeper',
    start() {
      poll = setInterval(() => { void sweeper.sweep(); }, deps.pollMs ?? POLL_MS);
      void sweeper.sweep();
    },
    async sweep() {
      if (stopped) return;
      // One sweep at a time in this replica: a slow one is not overlapped by the next tick.
      if (busy !== null) {
        await busy;
        return;
      }
      busy = sweepOnce().finally(() => { busy = null; });
      await busy;
    },
    async close() {
      stopped = true;
      clearInterval(poll);
      await busy;
    },
  };
  return sweeper;
}
