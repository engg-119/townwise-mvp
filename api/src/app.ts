import type { Auth, AuthStores } from '@ckeith26/auth';
import type { RedisHandle } from '@ckeith26/redis';
import type { Logger, ServerConfig } from '@ckeith26/server-core';
import express, { type Router } from 'express';
import type { Connection } from 'mongoose';

import { mountTownwiseRoutes, TOWNWISE_ROUTES, type TownwiseRoute } from './access/routes.ts';
import type { ChatModel } from './chat/model.ts';
import { TURN_TIME_LIMIT_MS } from './chat/turn.ts';
import { resolveTownwiseConfig, type ResolvedTownwiseConfig, type TownwiseConfig } from './config.ts';
import type { FileBlobs } from './files/blobs.ts';
import type { PlacesClient } from './places/google.ts';
import { createTownwiseStores, type TownwiseStores } from './stores/index.ts';

export interface TownwiseDeps {
  readonly config: TownwiseConfig & Pick<ServerConfig, 'NODE_ENV'>;
  readonly logger: Logger;
  readonly connection: Connection;
  readonly authStores: Pick<AuthStores, 'users' | 'totp'>;
  readonly auth: Auth;
  readonly redis: RedisHandle['client'];
  /** The same clock main.ts passes to createAuth (AuthDeps.now). Townwise code reads the time only from it. */
  readonly now: () => Date;
  /** The tuning chat's model; absent turns the chat off (main.ts builds it only when ANTHROPIC_API_KEY is set). */
  readonly chat?: ChatModel | undefined;
  /** A tuning chat turn's time limit in milliseconds; tests shorten it. Absent, TURN_TIME_LIMIT_MS (150 seconds). */
  readonly chatTurnTimeLimitMs?: number | undefined;
  /** Google Places for the Places proxy; absent turns it off (main.ts builds it only when GOOGLE_PLACES_API_KEY is set). */
  readonly places?: PlacesClient | undefined;
  /** Client file storage; absent turns stored files off (main.ts builds it only when FILES_BLOB_ACCOUNT_URL is set). */
  readonly files?: FileBlobs | undefined;
  /** Wakes the file reader (files/worker.ts) after an import starts or a file is queued. */
  readonly fileWorker?: { nudge(): void } | undefined;
}

/** What every route handler receives besides the request and the principal. */
export interface TownwiseContext {
  readonly config: ResolvedTownwiseConfig;
  readonly logger: Logger;
  readonly connection: Connection;
  readonly authStores: Pick<AuthStores, 'users' | 'totp'>;
  readonly auth: Auth;
  readonly redis: RedisHandle['client'];
  readonly now: () => Date;
  readonly stores: TownwiseStores;
  /** Null while the tuning chat is off. */
  readonly chat: ChatModel | null;
  readonly chatTurnTimeLimitMs: number;
  /** Null while the Places proxy is off. */
  readonly places: PlacesClient | null;
  /** Null while stored files are off. */
  readonly files: FileBlobs | null;
  readonly nudgeFiles: () => void;
}

/**
 * Registers the Townwise models on `connection` (call it before ensureIndexes) and returns the /api router.
 * `routes` is TOWNWISE_ROUTES in production; tests pass their own table to exercise the chain.
 */
export function createTownwiseApi(deps: TownwiseDeps, routes: readonly TownwiseRoute[] = TOWNWISE_ROUTES): Router {
  const ctx: TownwiseContext = {
    config: resolveTownwiseConfig(deps.config),
    logger: deps.logger,
    connection: deps.connection,
    authStores: deps.authStores,
    auth: deps.auth,
    redis: deps.redis,
    now: deps.now,
    stores: createTownwiseStores(deps.connection),
    chat: deps.chat ?? null,
    chatTurnTimeLimitMs: deps.chatTurnTimeLimitMs ?? TURN_TIME_LIMIT_MS,
    places: deps.places ?? null,
    files: deps.files ?? null,
    nudgeFiles: () => { deps.fileWorker?.nudge(); },
  };
  // No router-wide body parser: each route mounts its own limit after the policy passes (spec 7.2 step 6).
  const router = express.Router();
  mountTownwiseRoutes(router, routes, ctx);
  return router;
}
