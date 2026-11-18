// The TownwiseAI turn runner (openspec change resumable-chat-turns, design decisions 1 and 2): one per replica. It runs
// a claimed turn detached from the request that sent it, under its own AbortController, which only the time limit, a
// stop request, a lost lease or shutdown abort; a listener going away aborts nothing. The turn's events go through a
// recorder: adjacent text deltas, and adjacent thinking deltas, join into one numbered event per batch (200 ms or 4 KB),
// every other event closes the batch and goes at once. Each event is handed to every listener as it closes, with the
// number the record stores, and appended to the turn's record (stores/chat-turns.ts) by a compare-and-set that renews
// the lease. A 10-second heartbeat renews it while nothing is written, the stop flag is read every second, and the
// terminal event is written with the record's ended state in one update. Only ids reach a log from here.
import { AppError, type Logger } from '@ckeith26/server-core';

import type { OrgScope } from '../access/policy.ts';
import type { ChatConversationStore } from '../stores/chat-conversations.ts';
import type { ChatLiveTurnStore } from '../stores/chat-live-turns.ts';
import type { ChatTurnStore, EndedTurnState, NewChatTurn, TurnRecordEvent } from '../stores/chat-turns.ts';

/** Why a running turn was aborted. A closed connection is never one. */
export type TurnAbortReason = 'timeout' | 'stop' | 'lease_lost' | 'shutdown';

/** One event of the turn's stream, before it is numbered: `type` is the SSE event name. */
export interface StreamEvent {
  readonly type: string;
  readonly data: unknown;
}

/** How a turn's run ended: the record's ended state and the stream's last event. */
export interface TurnEnding {
  readonly state: EndedTurnState;
  readonly event: StreamEvent;
}

export type TurnListener = (event: TurnRecordEvent) => void;

export interface RunningTurn {
  readonly turnId: string;
  /**
   * Hands the listener every event so far, then each new one as it closes, the terminal one last. Resolves nothing;
   * returns the call that stops listening, which never stops the turn.
   */
  subscribe(listener: TurnListener): () => void;
  /** Resolves once the turn has ended and its record's last write was made (or given up). Never rejects. */
  readonly ended: Promise<void>;
}

export interface StartTurn {
  readonly scope: OrgScope;
  readonly turn: Omit<NewChatTurn, 'startedAt' | 'leaseUntil'>;
  /** When the time limit aborts the turn, in Date.now() milliseconds: it runs from the claims. */
  readonly deadline: number;
  /**
   * The turn itself. `signal` aborts with a TurnAbortReason; `emit` hands an event to the recorder. Its ending is the
   * stream's last event; a rejection ends the turn as failed with error `internal`.
   */
  run(turn: { signal: AbortSignal; emit: (event: StreamEvent) => void }): Promise<TurnEnding>;
}

export interface TurnRunner {
  readonly name: string;
  /** True once close() was called: no turn starts any more. */
  readonly closing: boolean;
  /**
   * Inserts the turn's record and starts its run. Rejects when the record cannot be inserted (the caller still holds
   * the claims), or with 503 `chat_restarting` once the runner is closing.
   */
  start(input: StartTurn): Promise<RunningTurn>;
  /** Shutdown (main.ts onShutdown): no new turn, the running ones aborted with `shutdown` and settled as interrupted. */
  close(): Promise<void>;
}

/** What settling an interrupted turn needs: its claims, then its record. */
export interface SettleStores {
  readonly chatTurns: Pick<ChatTurnStore, 'progress' | 'end'>;
  readonly chatConversations: Pick<ChatConversationStore, 'release'>;
  readonly chatLiveTurns: Pick<ChatLiveTurnStore, 'release'>;
}

export interface TurnRunnerDeps {
  readonly stores: SettleStores & { readonly chatTurns: Pick<ChatTurnStore, 'insert' | 'append' | 'renew' | 'end' | 'progress' | 'stopRequested'> };
  readonly logger: Logger;
  readonly now: () => Date;
  /** How far ahead each write sets the lease. */
  readonly leaseMs?: number;
  /** How often the lease is renewed while nothing is written. */
  readonly heartbeatMs?: number;
  /** How often the stop flag is read. */
  readonly stopPollMs?: number;
  /** A batch of deltas closes this long after its first delta, or at `batchBytes`. */
  readonly batchMs?: number;
  readonly batchBytes?: number;
  /** On close, how long the aborted turns get to end themselves before they are settled directly. */
  readonly settleMs?: number;
}

export const TURN_LEASE_MS = 30_000;
export const TURN_HEARTBEAT_MS = 10_000;
export const TURN_STOP_POLL_MS = 1_000;
const BATCH_MS = 200;
const BATCH_BYTES = 4_096;
/** Within the shutdown hook's 2 seconds, with time left to settle what has not ended. */
const SETTLE_MS = 1_200;

const INTERRUPTED: StreamEvent = { type: 'error', data: { code: 'interrupted' } };

const isDelta = (type: string): boolean => type === 'text' || type === 'thinking';

/**
 * Settles a turn that will not end on its own (a replica that shut down or died), in an order a retry completes: the
 * conversation's claim (which deletes a conversation that never finished a turn), the person's claim, then the record
 * from running to interrupted with a last `error { code: "interrupted" }` event. True when the record ended here or had
 * already ended; false when it is still running (another write got in first) or is gone.
 */
export async function settleInterrupted(
  stores: SettleStores, scope: OrgScope, turn: { conversationId: string; userId: string; turnId: string }, endedAt: Date,
): Promise<boolean> {
  await stores.chatConversations.release(scope, turn.conversationId, turn.turnId);
  await stores.chatLiveTurns.release(scope, turn.userId, turn.turnId);
  const progress = await stores.chatTurns.progress(scope, turn.turnId);
  if (progress === null) return false;
  if (progress.state !== 'running') return true;
  const from = progress.eventCount;
  return stores.chatTurns.end(scope, turn.turnId, { from, events: [{ seq: from + 1, ...INTERRUPTED }], state: 'interrupted', endedAt });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  const { stores, logger, now } = deps;
  const turns = stores.chatTurns;
  const leaseMs = deps.leaseMs ?? TURN_LEASE_MS;
  const heartbeatMs = deps.heartbeatMs ?? TURN_HEARTBEAT_MS;
  const stopPollMs = deps.stopPollMs ?? TURN_STOP_POLL_MS;
  const batchMs = deps.batchMs ?? BATCH_MS;
  const batchBytes = deps.batchBytes ?? BATCH_BYTES;
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const active = new Map<string, { abort: (reason: TurnAbortReason) => void; ended: Promise<void>; input: StartTurn }>();
  let closing = false;

  async function start(input: StartTurn): Promise<RunningTurn> {
    if (closing) throw new AppError(503, 'chat_restarting', 'TownwiseAI is restarting. Try again in a moment.');
    const { scope } = input;
    const { turnId } = input.turn;
    const ids = { orgId: scope.orgId, locationId: input.turn.locationId, conversationId: input.turn.conversationId };
    const startedAt = now();
    await turns.insert(scope, { ...input.turn, startedAt, leaseUntil: new Date(startedAt.getTime() + leaseMs) });

    const controller = new AbortController();
    const abort = (reason: TurnAbortReason): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    /** Every event handed to listeners, numbered from 1; the terminal one joins it as it is handed out. */
    const delivered: TurnRecordEvent[] = [];
    const listeners = new Set<TurnListener>();
    /** Events numbered but not yet known to be stored, in order; the record holds exactly `written` events. */
    const unwritten: TurnRecordEvent[] = [];
    let written = 0;
    let confirmedLease = startedAt.getTime() + leaseMs;
    let lastWriteAt = Date.now();
    let writing: Promise<void> | null = null;
    let finished = false;
    /** Set once the terminal event was handed out: a later listener gets everything from `delivered` alone. */
    let handedOut = false;
    let pending: { type: string; delta: string; bytes: number; timer: NodeJS.Timeout } | null = null;

    const hand = (event: TurnRecordEvent): void => {
      delivered.push(event);
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // A listener's own failure (a response already gone) never stops the turn or another listener.
        }
      }
    };

    /** After a write that matched nothing or threw: what the record holds now. */
    const reconcile = async (): Promise<'applied' | 'retry' | 'lost'> => {
      let progress;
      try {
        progress = await turns.progress(scope, turnId);
      } catch {
        return 'retry';
      }
      if (progress?.state !== 'running') return 'lost';
      if (progress.eventCount <= written) return 'retry';
      // The write applied but its answer was lost: only this turn writes its record, so the extra events are ours.
      unwritten.splice(0, progress.eventCount - written);
      written = progress.eventCount;
      return 'applied';
    };

    /** Writes what is unwritten until nothing is left; stops at a write to retry later, or a lost lease. */
    const writeAll = async (): Promise<'drained' | 'retry' | 'lost'> => {
      while (unwritten.length > 0) {
        const batch = unwritten.slice();
        const leaseUntil = new Date(now().getTime() + leaseMs);
        let applied: boolean;
        try {
          applied = await turns.append(scope, turnId, { from: written, events: batch, leaseUntil });
        } catch {
          applied = false;
        }
        if (applied) {
          unwritten.splice(0, batch.length);
          written += batch.length;
          confirmedLease = leaseUntil.getTime();
          lastWriteAt = Date.now();
          continue;
        }
        const verdict = await reconcile();
        if (verdict !== 'applied') return verdict;
      }
      return 'drained';
    };

    const scheduleWrite = (): void => {
      if (writing !== null || finished || unwritten.length === 0) return;
      const run = writeAll().then((verdict) => {
        writing = null;
        if (verdict === 'lost') abort('lease_lost');
        // A failed write waits for the next batch or the heartbeat; anything that closed meanwhile goes now.
        else if (verdict === 'drained') scheduleWrite();
      });
      writing = run;
    };

    const close = (event: StreamEvent): void => {
      const numbered = { seq: delivered.length + 1, type: event.type, data: event.data };
      unwritten.push(numbered);
      hand(numbered);
      scheduleWrite();
    };

    const closeBatch = (): void => {
      if (pending === null) return;
      clearTimeout(pending.timer);
      const { type, delta } = pending;
      pending = null;
      close({ type, data: { delta } });
    };

    const emit = (event: StreamEvent): void => {
      if (finished) return;
      if (!isDelta(event.type)) {
        closeBatch();
        close(event);
        return;
      }
      const delta = (event.data as { delta?: unknown } | null)?.delta;
      if (typeof delta !== 'string') return;
      if (pending !== null && pending.type !== event.type) closeBatch();
      pending ??= { type: event.type, delta: '', bytes: 0, timer: setTimeout(closeBatch, batchMs) };
      pending.delta += delta;
      pending.bytes += Buffer.byteLength(delta, 'utf8');
      if (pending.bytes >= batchBytes) closeBatch();
    };

    // A turn whose time ran out before it started (reading its files took it all) starts aborted, so it makes no call.
    if (Date.now() >= input.deadline) abort('timeout');
    const deadline = setTimeout(() => { abort('timeout'); }, Math.max(0, input.deadline - Date.now()));
    const heartbeat = setInterval(() => {
      if (finished) return;
      if (now().getTime() >= confirmedLease) {
        // Readers already treat the record as interrupted, and the sweep settles it.
        abort('lease_lost');
        return;
      }
      if (writing !== null) return;
      if (unwritten.length > 0) {
        scheduleWrite();
        return;
      }
      if (Date.now() - lastWriteAt < heartbeatMs) return;
      const leaseUntil = new Date(now().getTime() + leaseMs);
      turns.renew(scope, turnId, leaseUntil).then((renewed) => {
        if (!renewed) {
          abort('lease_lost');
          return;
        }
        confirmedLease = leaseUntil.getTime();
        lastWriteAt = Date.now();
      }, () => undefined);
    }, heartbeatMs);
    const stopPoll = setInterval(() => {
      if (finished || controller.signal.aborted) return;
      turns.stopRequested(scope, turnId).then((stop) => { if (stop) abort('stop'); }, () => undefined);
    }, stopPollMs);

    /** Writes the last events and the ended state in one update, retrying once; false when it could not. */
    const endRecord = async (terminal: TurnRecordEvent, state: EndedTurnState): Promise<boolean> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          if (await turns.end(scope, turnId, { from: written, events: [...unwritten, terminal], state, endedAt: now() })) return true;
        } catch {
          // Read below whether it applied.
        }
        try {
          const progress = await turns.progress(scope, turnId);
          if (progress === null) return false;
          if (progress.state !== 'running') return progress.state === state && progress.eventCount === terminal.seq;
          if (progress.eventCount > written) {
            unwritten.splice(0, progress.eventCount - written);
            written = progress.eventCount;
          }
        } catch {
          // Try once more.
        }
      }
      return false;
    };

    const finish = async (ending: TurnEnding): Promise<void> => {
      closeBatch();
      finished = true;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      clearInterval(stopPoll);
      while (writing !== null) await writing;
      const terminal = { seq: delivered.length + 1, type: ending.event.type, data: ending.event.data };
      if (!(await endRecord(terminal, ending.state))) {
        // Lost (settled or deleted), or still running: then its lease lapses and the sweep settles it as interrupted.
        logger.warn({ ...ids, state: ending.state }, 'townwise.chat_turn_record_not_ended');
      }
      hand(terminal);
      handedOut = true;
      listeners.clear();
    };

    const ended = (async () => {
      let ending: TurnEnding;
      try {
        ending = await input.run({ signal: controller.signal, emit });
      } catch (err) {
        logger.error({ ...ids, errType: err instanceof Error ? err.constructor.name : typeof err }, 'townwise.chat_turn_runner_failed');
        ending = { state: 'failed', event: { type: 'error', data: { code: 'internal' } } };
      }
      await finish(ending);
    })().finally(() => { active.delete(turnId); });
    active.set(turnId, { abort, ended, input });

    return {
      turnId,
      subscribe(listener) {
        for (const event of delivered) listener(event);
        if (handedOut) return () => undefined;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      ended,
    };
  }

  return {
    name: 'chat-turns',
    get closing() { return closing; },
    start,
    async close() {
      closing = true;
      const running = [...active.values()];
      for (const turn of running) turn.abort('shutdown');
      // Each aborted run ends itself (its claims released, its record interrupted) unless something holds it, such as
      // a tool call in flight; those are settled here, and the sweep settles any this hook runs out of time for.
      await Promise.race([Promise.all(running.map((turn) => turn.ended)), sleep(settleMs)]);
      const left = running.filter((turn) => active.has(turn.input.turn.turnId));
      await Promise.all(left.map(async ({ input }) => {
        const { scope, turn } = input;
        try {
          await settleInterrupted(stores, scope, turn, now());
        } catch (err) {
          logger.warn({
            orgId: scope.orgId, locationId: turn.locationId, conversationId: turn.conversationId,
            errType: err instanceof Error ? err.constructor.name : typeof err,
          }, 'townwise.chat_turn_not_settled');
        }
      }));
      logger.info({ turns: running.length, settled: left.length }, 'townwise.chat_turns_closed');
    },
  };
}
