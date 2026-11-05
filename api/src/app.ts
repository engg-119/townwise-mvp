import type { Auth, AuthStores } from '@ckeith26/auth';
import type { RedisHandle } from '@ckeith26/redis';
import type { Logger, ServerConfig } from '@ckeith26/server-core';
import express, { type Router } from 'express';
import type { Connection } from 'mongoose';

import { mountTownwiseRoutes, TOWNWISE_ROUTES, type TownwiseRoute } from './access/routes.ts';
import type { ChatModel } from './chat/model.ts';
import { resolveTownwiseConfig, type ResolvedTownwiseConfig, type TownwiseConfig } from './config.ts';
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
  };
  // No router-wide body parser: each route mounts its own limit after the policy passes (spec 7.2 step 6).
  const router = express.Router();
  mountTownwiseRoutes(router, routes, ctx);
  return router;
}
