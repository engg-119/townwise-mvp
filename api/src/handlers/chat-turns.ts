// A running TownwiseAI turn's own routes (openspec change resumable-chat-turns, design decision 3): its events, read back
// from its record in tw_chat_turns by any replica, so a page that lost its stream (a refresh, a dropped network, a
// second tab) picks the turn up where it left it, and its stop, which any replica can ask for: the replica running the
// turn reads the flag every second. Only the conversation's author reads or stops it; staff in view-as of them read it.
// The record's text, tool views and visuals never reach a log from here: only ids and an error's type do.
import { objectId } from '@ckeith26/mongo';
import { parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TownwiseContext } from '../app.ts';
import type { Principal } from '../access/policy.ts';
import type { ChatTurnRecord, TurnRecordEvent } from '../stores/chat-turns.ts';
import { eventFrame, notFound, PING_MS, TERMINAL_EVENTS } from './chat.ts';
import { loadLocation, memberOf } from './locations.ts';

/** How often a tail reads the record again for new events. */
const TAIL_POLL_MS = 500;
/** A tail ends on its own after this without a terminal event, under the ingress's 240 seconds; the client resumes. */
const TAIL_MS = 200_000;
/** A turn id as the claims make it (a UUID), or as tests write one; anything else is a turn that is not there. */
const TURN_ID = /^[\w-]{1,64}$/;

const tailQuery = z.strictObject({ after: z.string().regex(/^(0|[1-9]\d{0,8})$/).optional() });
const stopBody = z.strictObject({});

/** The turn id from the path, or 404 for one that cannot be a turn's. */
function turnIdOf(req: Request): string {
  const { turnId } = req.params;
  if (typeof turnId !== 'string' || !TURN_ID.test(turnId)) throw notFound();
  return turnId;
}

/** The last event of a turn that ended without one stored here: its record is gone, or its lease passed. */
function interrupted(seq: number): TurnRecordEvent {
  return { seq, type: 'error', data: { code: 'interrupted' } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

/**
 * GET /api/org/locations/:locationId/chat/:conversationId/turns/:turnId?after=<n>: the turn's events numbered above
 * `after` (default 0) as text/event-stream, each with its number as the SSE id, then each new one as the record gains
 * it, read every 500 ms, until the terminal event. A running record whose lease has passed ends with `error
 * { code: "interrupted" }`, numbered as the next event, and nothing is written (the sweep settles it); so does a record
 * deleted while it is read (its conversation, location or person deleted). Ends after 200 seconds without a terminal
 * event, and at once for a turn that ended at or before `after`. 404 when the turn is not that conversation's, or the
 * conversation not the caller's.
 */
export async function getTurnEvents(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const after = Number(parseInput(tailQuery, req.query).after ?? '0');
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  const turnId = turnIdOf(req);
  // The record names its author and location: the author's conversation is the only one that holds it.
  const first = await ctx.stores.chatTurns.readAfter(scope, conversationId, turnId, after);
  if (first?.userId !== caller.userId || first.locationId !== location.id) throw notFound();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const gone = new AbortController();
  res.on('close', () => { gone.abort(); });
  const ping = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, PING_MS);
  const endsAt = Date.now() + TAIL_MS;
  let cursor = after;
  let record: ChatTurnRecord | null = first;
  try {
    for (;;) {
      if (record === null) {
        res.write(eventFrame(interrupted(cursor + 1)));
        return;
      }
      for (const event of record.events) {
        res.write(eventFrame(event));
        cursor = event.seq;
        if (TERMINAL_EVENTS.has(event.type)) return;
      }
      if (record.state !== 'running') return;
      if (record.leaseUntil.getTime() <= ctx.now().getTime()) {
        res.write(eventFrame(interrupted(record.eventCount + 1)));
        return;
      }
      if (Date.now() >= endsAt) return;
      await sleep(TAIL_POLL_MS);
      if (gone.signal.aborted) return;
      record = await ctx.stores.chatTurns.readAfter(scope, conversationId, turnId, cursor);
    }
  } catch (err) {
    // A read that failed mid-stream: the stream ends, and the client resumes from its last number.
    ctx.logger.warn({
      orgId: scope.orgId, locationId: location.id, conversationId, errType: err instanceof Error ? err.constructor.name : typeof err,
    }, 'townwise.chat_tail_failed');
  } finally {
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  }
}

/**
 * POST /api/org/locations/:locationId/chat/:conversationId/turns/:turnId/stop, an empty body: sets the stop flag on the
 * author's running turn and answers 202 `{ state: "running" }`; the replica running it aborts it within about a second,
 * saves nothing but its cost and ends every stream with `stopped`. A turn that already ended answers 200 with the state
 * it ended in, so a repeat is harmless. 404 when it is not the caller's turn of that conversation. The view-as guard
 * refuses it, as every write.
 */
export async function stopTurn(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  parseInput(stopBody, req.body ?? {});
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const conversationId = parseInput(objectId, req.params.conversationId);
  const turnId = turnIdOf(req);
  const state = await ctx.stores.chatTurns.requestStop(caller.scope, { locationId: location.id, conversationId, userId: caller.userId }, turnId);
  if (state === null) throw notFound();
  res.status(state === 'running' ? 202 : 200).json({ state });
}
