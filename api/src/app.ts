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
import { createItemReader, type ItemReader } from './files/items.ts';
import { createForecastReader, type ForecastReader } from './forecasts/reader.ts';
import type { LabCaller } from './lab/caller.ts';
import { createLabCallbackRouter } from './lab/callback.ts';
import type { LabRunner } from './lab/runner.ts';
import { OFF_MAILER, type Mailer } from './mail/mailer.ts';
import { createPeopleInTownReader, type PeopleInTownReader } from './people-in-town/reader.ts';
import { PEOPLE_DATA, type PeopleData } from './people-in-town/sources.ts';
import type { PlacesClient } from './places/google.ts';
import type { StaticMapSigner } from './places/static-map.ts';
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
  /** Townwise's emails (spec D14); absent turns email off (main.ts builds it only when EMAIL_ENDPOINT is set). */
  readonly mailer?: Mailer | undefined;
  /**
   * Signs the confirm card's map URL; absent turns the map off (main.ts builds it only when GOOGLE_MAPS_STATIC_KEY and
   * GOOGLE_MAPS_SIGNING_SECRET are both set).
   */
  readonly placesMap?: StaticMapSigner | undefined;
  /** Client file storage; absent turns stored files off (main.ts builds it only when FILES_BLOB_ACCOUNT_URL is set). */
  readonly files?: FileBlobs | undefined;
  /** Wakes the file reader (files/worker.ts) after an import starts or a file is queued. */
  readonly fileWorker?: { nudge(): void } | undefined;
  /**
   * Reading with TownwiseAI (files/ai-reader.ts, spec 11A.9); absent turns it off (main.ts builds it only while stored
   * files are on, ANTHROPIC_API_KEY is set and TOWNWISE_FILES_MONTHLY_BUDGET_USD is above 0).
   */
  readonly aiReader?: { nudge(): void } | undefined;
  /** U13A: the researched headcount inputs; absent, the committed people-in-town/sources.ts. Tests pass synthetic ones. */
  readonly peopleData?: PeopleData | undefined;
  /** Starts the forecast lab's jobs; absent turns calibrations off (main.ts builds it from TOWNWISE_LAB_RUNNER). */
  readonly labRunner?: LabRunner | undefined;
  /** Who may call the lab callback (lab/caller.ts); main.ts builds it with the runner. Absent, /lab answers 404 to all. */
  readonly labCaller?: LabCaller | undefined;
}

/**
 * U13A: the readers TownwiseAI's tools and the estimates routes share (spec 13.2). The town calendar is pure public
 * data, read straight from town-calendar.ts. U13B adds the published forecast runs.
 */
export interface TownwisePorts {
  readonly peopleInTown: PeopleInTownReader;
  /** U13B: published forecast runs only (spec 14.4). */
  readonly forecasts: ForecastReader;
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
  /** Always set: OFF_MAILER while email is off, so a handler calls send either way. */
  readonly mailer: Mailer;
  /** Null while the map is off; the Places proxy can be on without it. */
  readonly placesMap: StaticMapSigner | null;
  /** Null while stored files are off. */
  readonly files: FileBlobs | null;
  readonly nudgeFiles: () => void;
  /** Reading with TownwiseAI: null while it is off (503 ai_unavailable); its nudge after a read is asked for. */
  readonly aiReads: { nudge(): void } | null;
  /** The one door TownwiseAI's tools read a reference item's text through (chat/* imports no file code). */
  readonly items: ItemReader;
  /** U13A. */
  readonly ports: TownwisePorts;
  /** Null while the forecast lab is off (503 lab_unavailable). */
  readonly labRunner: LabRunner | null;
  /** Null while the forecast lab is off (the callback answers 404). */
  readonly labCaller: LabCaller | null;
}

/** Registers the Townwise models on `connection` (call it before ensureIndexes) and builds what every handler receives. */
export function createTownwiseContext(deps: TownwiseDeps): TownwiseContext {
  const stores = createTownwiseStores(deps.connection);
  return {
    config: resolveTownwiseConfig(deps.config),
    logger: deps.logger,
    connection: deps.connection,
    authStores: deps.authStores,
    auth: deps.auth,
    redis: deps.redis,
    now: deps.now,
    stores,
    chat: deps.chat ?? null,
    chatTurnTimeLimitMs: deps.chatTurnTimeLimitMs ?? TURN_TIME_LIMIT_MS,
    places: deps.places ?? null,
    mailer: deps.mailer ?? OFF_MAILER,
    placesMap: deps.placesMap ?? null,
    files: deps.files ?? null,
    nudgeFiles: () => { deps.fileWorker?.nudge(); },
    aiReads: deps.aiReader ?? null,
    items: createItemReader(stores, deps.files ?? null),
    ports: {
      peopleInTown: createPeopleInTownReader({ stores, data: deps.peopleData ?? PEOPLE_DATA }),
      // U13B.
      forecasts: createForecastReader({ stores }),
    },
    labRunner: deps.labRunner ?? null,
    labCaller: deps.labCaller ?? null,
  };
}

/**
 * Registers the Townwise models on `connection` (call it before ensureIndexes) and returns the /api router.
 * `routes` is TOWNWISE_ROUTES in production; tests pass their own table to exercise the chain.
 */
export function createTownwiseApi(deps: TownwiseDeps, routes: readonly TownwiseRoute[] = TOWNWISE_ROUTES): Router {
  const ctx = createTownwiseContext(deps);
  // No router-wide body parser: each route mounts its own limit after the policy passes (spec 7.2 step 6).
  const router = express.Router();
  mountTownwiseRoutes(router, routes, ctx);
  return router;
}

/** The forecast lab job's callback router, which main.ts mounts at /lab, outside /api and the kit's auth (lab/callback.ts). */
export function createTownwiseLab(deps: TownwiseDeps): Router {
  return createLabCallbackRouter(createTownwiseContext(deps));
}
