// The TownwiseAI turn runner (src/chat/turn-runner.ts, openspec change resumable-chat-turns, design decisions 1 and 2)
// over an in-memory record store: deltas batched and numbered, every listener handed the same numbers the record
// stores, a write that applied but reported an error never doubled, and a turn aborted only by its time limit, a stop
// request, a lost lease or shutdown, never by a listener going away.
import { createLogger } from '@ckeith26/server-core';
import { describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import {
  createTurnRunner, type RunningTurn, type StreamEvent, type TurnEnding, type TurnRunner, type TurnRunnerDeps,
} from '../src/chat/turn-runner.ts';
import type { ChatTurnStore, NewChatTurn, TurnRecordEvent, TurnState } from '../src/stores/chat-turns.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const SCOPE: OrgScope = scopeForNewOrg(STAFF, 'a'.repeat(24));

interface FakeRecord { turn: NewChatTurn; state: TurnState; stopRequested: boolean; events: TurnRecordEvent[]; leaseUntil: Date }

/** tw_chat_turns in memory, with the same compare-and-set rules as the store, and hooks to fail a write. */
function memoryTurns() {
  const records = new Map<string, FakeRecord>();
  const hooks = {
    /** Applies the next append, then throws as a write with no retryable writes can. */
    applyThenThrow: 0,
    /** Throws the next appends without applying them. */
    throwAppends: 0,
    appends: 0,
    renewals: 0,
  };
  const running = (turnId: string): FakeRecord | undefined => {
    const record = records.get(turnId);
    return record?.state === 'running' ? record : undefined;
  };
  const store: Pick<ChatTurnStore, 'insert' | 'append' | 'renew' | 'end' | 'progress' | 'stopRequested'> = {
    insert: (_scope, turn) => {
      records.set(turn.turnId, { turn, state: 'running', stopRequested: false, events: [], leaseUntil: turn.leaseUntil });
      return Promise.resolve();
    },
    append: (_scope, turnId, input) => {
      hooks.appends += 1;
      if (hooks.throwAppends > 0) {
        hooks.throwAppends -= 1;
        return Promise.reject(new Error('network'));
      }
      const record = running(turnId);
      if (record?.events.length !== input.from) return Promise.resolve(false);
      record.events.push(...input.events);
      record.leaseUntil = input.leaseUntil;
      if (hooks.applyThenThrow > 0) {
        hooks.applyThenThrow -= 1;
        return Promise.reject(new Error('no answer'));
      }
      return Promise.resolve(true);
    },
    renew: (_scope, turnId, leaseUntil) => {
      hooks.renewals += 1;
      const record = running(turnId);
      if (record === undefined) return Promise.resolve(false);
      record.leaseUntil = leaseUntil;
      return Promise.resolve(true);
    },
    end: (_scope, turnId, input) => {
      const record = running(turnId);
      if (record?.events.length !== input.from) return Promise.resolve(false);
      record.events.push(...input.events);
      record.state = input.state;
      return Promise.resolve(true);
    },
    progress: (_scope, turnId) => {
      const record = records.get(turnId);
      return Promise.resolve(record === undefined ? null : { state: record.state, eventCount: record.events.length });
    },
    stopRequested: (_scope, turnId) => Promise.resolve(running(turnId)?.stopRequested === true),
  };
  return { store, records, hooks };
}

function released() {
  const calls: string[] = [];
  return {
    calls,
    conversations: { release: (_scope: OrgScope, conversationId: string, turnId: string) => { calls.push(`conversation ${conversationId} ${turnId}`); return Promise.resolve(); } },
    liveTurns: { release: (_scope: OrgScope, userId: string, turnId: string) => { calls.push(`person ${userId} ${turnId}`); return Promise.resolve(); } },
  };
}

function setup(over: Partial<TurnRunnerDeps> = {}) {
  const memory = memoryTurns();
  const claims = released();
  const logs: string[] = [];
  const logger = createLogger({ LOG_LEVEL: 'trace' }, { destination: { write: (line: string) => { logs.push(line); } } });
  let clock = Date.parse('2026-06-01T12:00:00.000Z');
  const runner = createTurnRunner({
    stores: { chatTurns: memory.store, chatConversations: claims.conversations, chatLiveTurns: claims.liveTurns },
    logger, now: () => new Date(clock),
    batchMs: 40, heartbeatMs: 30, stopPollMs: 20, leaseMs: 30_000, settleMs: 100,
    ...over,
  });
  return { runner, memory, claims, logs, advance: (ms: number) => { clock += ms; } };
}

let turnCount = 0;
function newTurn(): Omit<NewChatTurn, 'startedAt' | 'leaseUntil'> {
  turnCount += 1;
  return {
    locationId: 'b'.repeat(24), conversationId: 'c'.repeat(24), userId: 'user-1', turnId: `turn-${String(turnCount)}`,
    userNodeId: 'u1', replyNodeId: 'r1', parentId: null, message: { text: 'Sentinel question', attachments: [] },
  };
}

type Run = (turn: { signal: AbortSignal; emit: (event: StreamEvent) => void }) => Promise<TurnEnding>;

const DONE: TurnEnding = { state: 'done', event: { type: 'done', data: { stopReason: 'end_turn' } } };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Resolves when `signal` aborts, with its reason. */
function abortedWith(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(signal.reason);
    signal.addEventListener('abort', () => { resolve(signal.reason); }, { once: true });
  });
}

async function started(runner: TurnRunner, run: Run, deadlineMs = 60_000): Promise<{ turn: RunningTurn; heard: TurnRecordEvent[]; turnId: string }> {
  const input = newTurn();
  const turn = await runner.start({ scope: SCOPE, turn: input, deadline: Date.now() + deadlineMs, run });
  const heard: TurnRecordEvent[] = [];
  turn.subscribe((event) => { heard.push(event); });
  return { turn, heard, turnId: input.turnId };
}

const kinds = (events: readonly TurnRecordEvent[]): [number, string][] => events.map((event) => [event.seq, event.type]);
const textOf = (events: readonly TurnRecordEvent[]): string => events.filter((event) => event.type === 'text')
  .map((event) => (event.data as { delta: string }).delta).join('');

describe('the turn runner', () => {
  it('joins adjacent deltas into numbered batches, writes any other event at once, and hands listeners the stored numbers', async () => {
    const { runner, memory } = setup();
    const { turn, heard, turnId } = await started(runner, async ({ emit }) => {
      emit({ type: 'conversation', data: { id: 'c'.repeat(24), turnId: 'x' } });
      for (let index = 0; index < 300; index += 1) emit({ type: 'text', data: { delta: 'a' } });
      emit({ type: 'tool', data: { id: 't1', state: 'running' } });
      emit({ type: 'thinking', data: { delta: 'Hmm, ' } });
      emit({ type: 'thinking', data: { delta: 'let me see.' } });
      emit({ type: 'text', data: { delta: 'More ' } });
      await sleep(120);
      emit({ type: 'text', data: { delta: 'after a pause.' } });
      return DONE;
    });
    await turn.ended;
    const stored = memory.records.get(turnId);
    expect(stored?.state).toBe('done');
    expect(kinds(stored?.events ?? [])).toEqual([
      [1, 'conversation'], [2, 'text'], [3, 'tool'], [4, 'thinking'], [5, 'text'], [6, 'text'], [7, 'done'],
    ]);
    expect(stored?.events[1]?.data).toEqual({ delta: 'a'.repeat(300) });
    expect(stored?.events[3]?.data).toEqual({ delta: 'Hmm, let me see.' });
    expect(textOf(stored?.events ?? [])).toBe(`${'a'.repeat(300)}More after a pause.`);
    expect(heard).toEqual(stored?.events);
  });

  it('closes a batch at 4 KB of deltas', async () => {
    const { runner, memory } = setup({ batchMs: 10_000 });
    const { turn, turnId } = await started(runner, ({ emit }) => {
      for (let index = 0; index < 10; index += 1) emit({ type: 'text', data: { delta: 'x'.repeat(1024) } });
      return Promise.resolve(DONE);
    });
    await turn.ended;
    const sizes = (memory.records.get(turnId)?.events ?? []).filter((event) => event.type === 'text')
      .map((event) => (event.data as { delta: string }).delta.length);
    expect(sizes).toEqual([4096, 4096, 2048]);
  });

  it('a listener that subscribes late is handed every event so far first, and unsubscribing never stops the turn', async () => {
    const { runner, memory } = setup();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { turn, heard, turnId } = await started(runner, async ({ emit, signal }) => {
      emit({ type: 'conversation', data: {} });
      emit({ type: 'tool', data: { id: 't1' } });
      await gate;
      expect(signal.aborted).toBe(false);
      emit({ type: 'text', data: { delta: 'Finished anyway.' } });
      return DONE;
    });
    const late: TurnRecordEvent[] = [];
    const unsubscribe = turn.subscribe((event) => { late.push(event); });
    expect(kinds(late)).toEqual([[1, 'conversation'], [2, 'tool']]);
    unsubscribe();
    release();
    await turn.ended;
    expect(kinds(late)).toEqual([[1, 'conversation'], [2, 'tool']]);
    expect(kinds(heard)).toEqual([[1, 'conversation'], [2, 'tool'], [3, 'text'], [4, 'done']]);
    expect(kinds(memory.records.get(turnId)?.events ?? [])).toEqual(kinds(heard));
  });

  it('a write that applied but reported an error is not doubled, and a write that failed is retried with the next batch', async () => {
    const { runner, memory } = setup();
    memory.hooks.applyThenThrow = 1;
    const { turn, heard, turnId } = await started(runner, async ({ emit }) => {
      emit({ type: 'conversation', data: {} });
      await sleep(20);
      memory.hooks.throwAppends = 1;
      emit({ type: 'tool', data: { id: 't1', state: 'running' } });
      await sleep(20);
      emit({ type: 'tool', data: { id: 't1', state: 'done' } });
      await sleep(20);
      return DONE;
    });
    await turn.ended;
    const stored = memory.records.get(turnId)?.events ?? [];
    expect(kinds(stored)).toEqual([[1, 'conversation'], [2, 'tool'], [3, 'tool'], [4, 'done']]);
    expect(stored).toEqual(heard);
  });

  it('a stop request aborts the turn with reason stop within a poll, and the turn ends as its run says', async () => {
    const { runner, memory } = setup();
    let reason: unknown = null;
    const { turn, heard, turnId } = await started(runner, async ({ emit, signal }) => {
      emit({ type: 'conversation', data: {} });
      reason = await abortedWith(signal);
      return { state: 'stopped', event: { type: 'stopped', data: {} } };
    });
    await sleep(30);
    const record = memory.records.get(turnId);
    if (record === undefined) throw new Error('no record');
    record.stopRequested = true;
    await turn.ended;
    expect(reason).toBe('stop');
    expect(record.state).toBe('stopped');
    expect(kinds(record.events)).toEqual([[1, 'conversation'], [2, 'stopped']]);
    expect(heard.at(-1)).toEqual({ seq: 2, type: 'stopped', data: {} });
  });

  it('aborts with reason timeout at the deadline', async () => {
    const { runner } = setup();
    let reason: unknown = null;
    const { turn } = await started(runner, async ({ signal }) => {
      reason = await abortedWith(signal);
      return { state: 'failed', event: { type: 'error', data: { code: 'timeout' } } };
    }, 50);
    await turn.ended;
    expect(reason).toBe('timeout');
  });

  it('a turn whose deadline passed before it started starts aborted with reason timeout', async () => {
    const { runner } = setup();
    let seen: unknown = null;
    const { turn } = await started(runner, ({ signal }) => {
      seen = signal.aborted ? signal.reason : 'not aborted';
      return Promise.resolve({ state: 'failed', event: { type: 'error', data: { code: 'timeout' } } });
    }, -1);
    await turn.ended;
    expect(seen).toBe('timeout');
  });

  it('a write that matches a settled or deleted record aborts the turn with reason lease_lost; its listeners still hear an ending', async () => {
    const { runner, memory } = setup();
    let reason: unknown = null;
    const { turn, heard, turnId } = await started(runner, async ({ emit, signal }) => {
      emit({ type: 'conversation', data: {} });
      await sleep(10);
      memory.records.delete(turnId);
      emit({ type: 'tool', data: { id: 't1' } });
      reason = await abortedWith(signal);
      return { state: 'interrupted', event: { type: 'error', data: { code: 'interrupted' } } };
    });
    await turn.ended;
    expect(reason).toBe('lease_lost');
    expect(memory.records.has(turnId)).toBe(false);
    expect(heard.at(-1)).toMatchObject({ type: 'error', data: { code: 'interrupted' } });
  });

  it('the heartbeat renews the lease while nothing is written, and finds a lost lease', async () => {
    const { runner, memory } = setup();
    let reason: unknown = null;
    const { turn, turnId } = await started(runner, async ({ signal }) => {
      await sleep(100);
      expect(memory.hooks.renewals).toBeGreaterThan(0);
      const record = memory.records.get(turnId);
      if (record !== undefined) record.state = 'interrupted';
      reason = await abortedWith(signal);
      return { state: 'interrupted', event: { type: 'error', data: { code: 'interrupted' } } };
    });
    await turn.ended;
    expect(reason).toBe('lease_lost');
  });

  it('a lease that lapses while writes fail aborts the turn with reason lease_lost', async () => {
    const { runner, memory, advance } = setup();
    let reason: unknown = null;
    const { turn } = await started(runner, async ({ emit, signal }) => {
      memory.hooks.throwAppends = 1_000;
      emit({ type: 'conversation', data: {} });
      advance(31_000);
      reason = await abortedWith(signal);
      return { state: 'interrupted', event: { type: 'error', data: { code: 'interrupted' } } };
    });
    await turn.ended;
    expect(reason).toBe('lease_lost');
  });

  it('a run that throws ends the turn as failed with error internal', async () => {
    const { runner, memory } = setup();
    const { turn, heard, turnId } = await started(runner, () => Promise.reject(new Error('Sentinel failure')));
    await turn.ended;
    expect(memory.records.get(turnId)?.state).toBe('failed');
    expect(heard.at(-1)).toMatchObject({ type: 'error', data: { code: 'internal' } });
  });

  it('on close, takes no new turn, aborts the running ones with reason shutdown, and settles one that does not end in time', async () => {
    const { runner, memory, claims, logs } = setup();
    let reason: unknown = null;
    const quick = await started(runner, async ({ emit, signal }) => {
      emit({ type: 'conversation', data: {} });
      reason = await abortedWith(signal);
      return { state: 'interrupted', event: { type: 'error', data: { code: 'interrupted' } } };
    });
    const stuck = await started(runner, async ({ emit }) => {
      emit({ type: 'conversation', data: {} });
      emit({ type: 'text', data: { delta: 'Sentinel reply' } });
      await sleep(1_000);
      return DONE;
    });
    await sleep(60);
    await runner.close();
    expect(reason).toBe('shutdown');
    expect(memory.records.get(quick.turnId)?.state).toBe('interrupted');
    const settled = memory.records.get(stuck.turnId);
    expect(settled?.state).toBe('interrupted');
    expect(kinds(settled?.events ?? [])).toEqual([[1, 'conversation'], [2, 'text'], [3, 'error']]);
    expect(settled?.events.at(-1)?.data).toEqual({ code: 'interrupted' });
    // The settled turn's claims, the conversation's first, then the person's.
    expect(claims.calls).toEqual([`conversation ${'c'.repeat(24)} ${stuck.turnId}`, `person user-1 ${stuck.turnId}`]);
    await expect(runner.start({ scope: SCOPE, turn: newTurn(), deadline: Date.now() + 60_000, run: () => Promise.resolve(DONE) }))
      .rejects.toMatchObject({ status: 503, code: 'chat_restarting' });
    const joined = logs.join('\n');
    expect(joined).not.toContain('Sentinel');
    await stuck.turn.ended;
  });
});
