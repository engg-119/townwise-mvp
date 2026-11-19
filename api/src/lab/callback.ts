// The forecast lab job's two callback routes (design call 3), mounted at /lab by main.ts, outside /api and outside the
// kit's auth: the job holds no session and no secret of its own, only its calibration's id. It signs in with its
// managed identity (lab/caller.ts: an Entra token for the lab callback app, from the lab identity and no one else; in
// development, the API process's own secret), so nothing in its environment or the job's execution history is a
// credential. The live calibration is then found by id (cross-tenant findLabCallback, the one lookup made before an
// organization is known), and access/policy.ts mints the scope from what it finds, so the job reads and writes one
// location of one organization.
//
// The lab identity's token is not tied to one calibration, so the input is fetched once and the result is bound to that
// fetch: the input answer carries a fresh result token in X-Townwise-Result-Token, and a result needs it with the
// identity token. A second fetch, by anyone, is 404 (the job never retries its fetch). Whoever fetches first gets the
// result token, so code running as the lab identity that fetches another calibration's input first can read it and post
// a forged result for it, and that calibration's own job is refused (`not_live` in the log): a known risk the owner
// deferred (infra/README.md, Known risks).
//
// Every refusal is 404: a missing or wrong token, an unknown id, another calibration's result token and a finished
// calibration look alike; nothing here answers unauthenticated (only access/resolve.ts's userGone does). Only when
// Entra's keys cannot be fetched is it 503 lab_auth_unavailable, which the job's result post retries once. Every
// refusal past the lab being on logs townwise.lab_callback_refused with its route and reason, never an id or a token:
// the identity check's reason (lab/caller.ts), `not_live` when a signed-in caller names no live calibration or one whose
// input was already fetched, and `result_token` when a result's token is missing or is not that calibration's, so
// probing calibrations shows in the log. The body is parsed only after both checks passed. Nothing here logs a figure.
import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '@ckeith26/server-core';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';

import { scopeForLabCallback, type OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { canonicalSha256 } from '../forecasts/file.ts';
import { findLabCallback, type LabCallbackClaim } from '../stores/cross-tenant.ts';
import type { LabCallerRefusal } from './caller.ts';
import { buildLabInput, labInputFingerprint } from './input.ts';
import { finishCalibration, ingestLabResult } from './service.ts';

/** The result token: randomBytes(32) as base64url, 43 characters. */
const RESULT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/**
 * The input answer's header naming the token the job posts its result with, and the result post's header carrying it
 * (modeling/lab/townwise_lab/job.py).
 */
export const RESULT_TOKEN_HEADER = 'X-Townwise-Result-Token';
/** A result is about 50 KB; the run file allows 400 days. */
export const LAB_RESULT_LIMIT = '256kb';

type LabRoute = 'input' | 'result';
/** Why a call was refused, as townwise.lab_callback_refused logs it. */
type LabRefusal = LabCallerRefusal | 'not_live' | 'result_token';

interface Claimed { readonly claim: LabCallbackClaim; readonly scope: OrgScope }

const claims = new WeakMap<Request, Claimed>();

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** Logs a refusal with its route and reason only, and answers 404 like every refusal. */
function refused(ctx: TownwiseContext, route: LabRoute, reason: LabRefusal): AppError {
  ctx.logger.info({ route, reason }, 'townwise.lab_callback_refused');
  return notFound();
}

function sha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function bound(run: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void run(req, res).then(() => { if (!res.headersSent) next(); }).catch(next);
  };
}

function claimedOf(req: Request): Claimed {
  const claimed = claims.get(req);
  if (claimed === undefined) throw notFound();
  return claimed;
}

export function createLabCallbackRouter(ctx: TownwiseContext): Router {
  const router = express.Router();

  // The caller is read per request, so building the router touches no context (test/routes.test.ts).
  const authorize = (route: LabRoute): RequestHandler => bound(async (req) => {
    const caller = ctx.labCaller;
    const id = req.params.id;
    if (caller === null || typeof id !== 'string') throw notFound();
    const verdict = await caller.verify(req.get('authorization'));
    if (!verdict.ok) {
      if ('unavailable' in verdict) {
        ctx.logger.warn({ route, reason: 'keys_unavailable' }, 'townwise.lab_callback_unavailable');
        throw new AppError(503, 'lab_auth_unavailable', 'The lab callback is unavailable');
      }
      throw refused(ctx, route, verdict.refusal);
    }
    let resultTokenSha256: string | null = null;
    if (route === 'result') {
      const resultToken = req.get(RESULT_TOKEN_HEADER);
      if (resultToken === undefined || !RESULT_TOKEN.test(resultToken)) throw refused(ctx, route, 'result_token');
      resultTokenSha256 = sha256(resultToken);
    }
    const now = ctx.now();
    const claim = await findLabCallback(ctx.connection, id, now, resultTokenSha256);
    if (claim === null) {
      // Only a refusal looks again, to say whether the calibration is live and the result token is not its.
      const live = resultTokenSha256 !== null && (await findLabCallback(ctx.connection, id, now, null)) !== null;
      throw refused(ctx, route, live ? 'result_token' : 'not_live');
    }
    claims.set(req, { claim, scope: scopeForLabCallback(claim) });
  });

  /**
   * GET /lab/calibrations/:id/input, once, signed in as the lab identity: 200 LabInput, and the result token in
   * X-Townwise-Result-Token. A queued calibration is running from here. Any later fetch is 404.
   */
  router.get('/calibrations/:id/input', authorize('input'), bound(async (req, res) => {
    const { claim, scope } = claimedOf(req);
    const { calibrations } = ctx.stores;
    const calibration = await calibrations.find(scope, claim.calibrationId);
    // Gone, or its input already fetched.
    if (calibration?.inputSha256 !== null) throw refused(ctx, 'input', 'not_live');
    if (calibration.status === 'queued') await calibrations.markRunning(scope, calibration.id, { now: ctx.now(), imageDigest: null });
    const input = await buildLabInput(ctx, scope, calibration);
    if (input === null) {
      // Its sales data went while it waited (an empty upload since, say): nothing to calibrate on.
      await finishCalibration(ctx, scope, calibration, { status: 'failed', failure: 'not_enough_history' });
      throw notFound();
    }
    const resultToken = randomBytes(32).toString('base64url');
    const recorded = await calibrations.recordInput(scope, calibration.id, {
      inputSha256: canonicalSha256(input), dataSha256: labInputFingerprint(input), dataThrough: input.dataThrough,
      termsThrough: input.termsThrough, resultTokenSha256: sha256(resultToken),
    });
    // A concurrent fetch recorded its input first.
    if (!recorded) throw refused(ctx, 'input', 'not_live');
    res.status(200).set(RESULT_TOKEN_HEADER, resultToken).json(input);
  }));

  /**
   * POST /lab/calibrations/:id/result, a LabResult, signed in as the lab identity and with the result token the input
   * answer named in X-Townwise-Result-Token (so nothing is taken before the input was fetched): see ingestLabResult.
   */
  router.post('/calibrations/:id/result', authorize('result'), express.json({ limit: LAB_RESULT_LIMIT }), bound(async (req, res) => {
    const { claim, scope } = claimedOf(req);
    const answer = await ingestLabResult(ctx, scope, claim.calibrationId, req.body);
    res.status(answer.status).json(answer.body);
  }));

  return router;
}
