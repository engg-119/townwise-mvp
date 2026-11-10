// The forecast lab job's two callback routes (design call 3), mounted at /lab by main.ts, outside /api and outside the
// kit's auth: the job holds no session, only its calibration's id and bearer token. The token is checked by its sha256
// against the live calibration (cross-tenant findLabCallback, the one lookup made before an organization is known), and
// access/policy.ts mints the scope from what it finds, so the job reads and writes one location of one organization.
// Every refusal is 404: an unknown id, a missing, wrong or expired token, another organization's id and a finished
// calibration look alike; nothing here answers unauthenticated (only access/resolve.ts's userGone does). The body is
// parsed only after the token passed. Nothing here logs a figure.
//
// The token the job is started with sits in the Container Apps execution's environment, which anyone who can read the
// job's executions (Reader on its resource group) can see, so it fetches the input once and posts no draft: the input
// answer carries a fresh result token in X-Townwise-Result-Token, and from then on only that token works. A second
// fetch, by anyone, is 404 (the job never retries its fetch), so a token read from the execution history is dead once
// the job has called, and one used first leaves the job's own fetch refused and the calibration failing for all to see.
import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '@ckeith26/server-core';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';

import { scopeForLabCallback, type OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { canonicalSha256 } from '../forecasts/file.ts';
import { findLabCallback, type LabCallbackClaim } from '../stores/cross-tenant.ts';
import { buildLabInput } from './input.ts';
import { finishCalibration, ingestLabResult } from './service.ts';

/** randomBytes(32) as base64url: 43 characters. */
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;
/** The input answer's header naming the token the job posts its result with (modeling/lab/townwise_lab/job.py). */
export const RESULT_TOKEN_HEADER = 'X-Townwise-Result-Token';
/** A result is about 50 KB; the run file allows 400 days. */
export const LAB_RESULT_LIMIT = '256kb';

interface Claimed { readonly claim: LabCallbackClaim; readonly scope: OrgScope; readonly tokenSha256: string }

const claims = new WeakMap<Request, Claimed>();

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
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

  const authorize = bound(async (req) => {
    const token = BEARER.exec(req.get('authorization') ?? '')?.[1];
    const id = req.params.id;
    if (token === undefined || typeof id !== 'string') throw notFound();
    const tokenSha256 = sha256(token);
    const claim = await findLabCallback(ctx.connection, id, tokenSha256, ctx.now());
    if (claim === null) throw notFound();
    claims.set(req, { claim, scope: scopeForLabCallback(claim), tokenSha256 });
  });

  /**
   * GET /lab/calibrations/:id/input, once, with the token the job was started with: 200 LabInput, and the result token
   * in X-Townwise-Result-Token. A queued calibration is running from here. Any later fetch is 404.
   */
  router.get('/calibrations/:id/input', authorize, bound(async (req, res) => {
    const { claim, scope, tokenSha256 } = claimedOf(req);
    const { calibrations } = ctx.stores;
    const calibration = await calibrations.find(scope, claim.calibrationId);
    // Gone, or its input already fetched.
    if (calibration?.inputSha256 !== null) throw notFound();
    if (calibration.status === 'queued') await calibrations.markRunning(scope, calibration.id, { now: ctx.now(), imageDigest: null });
    const input = await buildLabInput(ctx, scope, calibration);
    if (input === null) {
      // Its sales data went while it waited (an empty upload since, say): nothing to calibrate on.
      await finishCalibration(ctx, scope, calibration, { status: 'failed', failure: 'not_enough_history' });
      throw notFound();
    }
    const resultToken = randomBytes(32).toString('base64url');
    const recorded = await calibrations.recordInput(scope, calibration.id, {
      tokenSha256, inputSha256: canonicalSha256(input), dataThrough: input.dataThrough, resultTokenSha256: sha256(resultToken),
    });
    if (!recorded) throw notFound();
    res.status(200).set(RESULT_TOKEN_HEADER, resultToken).json(input);
  }));

  /**
   * POST /lab/calibrations/:id/result, a LabResult, with the result token (before the input was fetched, the start
   * token, which can only fail the calibration: ingestLabResult refuses a draft with no input recorded): see
   * ingestLabResult.
   */
  router.post('/calibrations/:id/result', authorize, express.json({ limit: LAB_RESULT_LIMIT }), bound(async (req, res) => {
    const { claim, scope } = claimedOf(req);
    const answer = await ingestLabResult(ctx, scope, claim.calibrationId, req.body);
    res.status(answer.status).json(answer.body);
  }));

  return router;
}
