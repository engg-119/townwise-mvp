# AGENTS.md

This file provides guidance to Codex (claude.ai/code) when working with code in this repository.

## What this is

Townwise (townwise.tech) is an ENGG 119 course project at Dartmouth: daily guest and sales forecasts for restaurants in small towns, built from the town's own calendar. The repo holds the product (a TypeScript API, a React Native/Expo client and their Azure infrastructure) and the research side (`data/`, `eda/`, `modeling/`). `README.md` is the human overview.

Scale (2026-11-19): about 280,000 lines of TypeScript, half of it tests, plus 13,000 of Python; breakdown in `README.md` (### Size). Search with targeted paths rather than reading whole workspaces.

## Commands

Node 24 is required (`.nvmrc`; `.npmrc` sets `engine-strict`). A non-interactive shell may start on an older Node: if `node --version` is not 24, run `. "$HOME/.nvm/nvm.sh" && nvm use` in the same command. Integration tests need Docker running.

```sh
npm ci                  # .npmrc also sets ignore-scripts, save-exact and min-release-age=7
npm run verify          # what CI runs: npm ls, lint, typecheck, every test, web export, expo-doctor
npm run lint            # eslint . (type-aware, whole repo); one file: npx eslint api/src/app.ts
npm run typecheck
npm test                # every workspace
```

Workspaces: `@townwise/api` (`api/`), `@ckeith26/expo-shell` (`client/`), and `@ckeith26/{auth,mongo,rate-limit,redis,server-core}` (`api/kit/*`).

Single tests:

```sh
# api and api/kit/* use vitest with two projects: "unit" (*.test.ts) and "integration" (*.int.test.ts,
# Mongo and Valkey started by testcontainers in a global setup)
npm test -w @townwise/api -- test/notes.int.test.ts
npm run test:unit -w @townwise/api -- -t "cross-tenant"
npm run test:int -w @ckeith26/auth

# client uses jest-expo with two projects, "native" and "web". Put the path before --selectProjects,
# or the flag swallows it and every suite runs.
npm test -w @ckeith26/expo-shell -- test/auth/store.test.ts -t "routeFor"
npm test -w @ckeith26/expo-shell -- test/marketing/links.test.ts --selectProjects web
```

Client test suffixes pick the project: `*.test.native.tsx` runs on native only, `*.test.web.tsx` on web only, and a plain `*.test.ts` runs in both.

Local run (full steps, including generating the auth keys, in `api/README.md`):

```sh
docker compose up -d                  # Mongo on 27017, Valkey on 6379, Azurite (blobs) on 10000
npm run dev -w @townwise/api          # :8080, after az login; Key Vault secrets, .env.local overrides them
npm start -w @ckeith26/expo-shell     # expo start; web on :8081, the API's CORS origin; reads client/.env.local
```

Terraform, as CI runs it (no backend, mocked providers), in each of `infra/terraform/bootstrap` and `infra/terraform/production`:

```sh
terraform fmt -check -recursive       # from infra/terraform
terraform init -backend=false -input=false -lockfile=readonly && terraform validate && tflint --init && tflint && terraform test
```

Python notebooks in `eda/` and `modeling/` use uv, run from inside each folder. They read the private exports in `data/`, so they only run where a teammate has copied those in:

```sh
uv sync                               # .venv from pyproject.toml and uv.lock
uv run jupyter lab
uv run jupyter nbconvert --to notebook --execute --inplace demand_model_v0.ipynb
```

## Architecture

### No build step

Node runs the TypeScript directly (`node src/main.ts`, in dev and in the Docker image). Imports carry the `.ts` extension, and `erasableSyntaxOnly` forbids enums, namespaces and constructor parameter properties. `tsconfig.base.json` also turns on `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

### Kit modules and Townwise code

`api/kit/*` and `client/` were copied from the camkeith/modules kit at the commits in `KIT.md`, hence the `@ckeith26/` names. The code is ours, but every change to it is recorded under `## Local changes` in that module's `MODULE.md`, naming the test that pins it. Townwise product code lives in `api/src/`.

Library code under `api/kit/*/src` never reads `process.env` (lint-enforced). Each module exports a zod `configSchema`; `api/src/main.ts` (the API) and `api/src/workers/weekly-forecasts.ts` (the weekly forecast worker job) are the composition roots and the only files under `api/src/` that read the environment.

### API request chain

Every `/api` route is one entry in `TOWNWISE_ROUTES` (`api/src/access/routes.ts`): an id, a policy (`signed_in`, `member`, `org_admin`, `staff`, `staff_self`), a body limit and an optional limiter. `mountTownwiseRoutes` gives each the same chain: kit `requireAuth`, the `writes` limiter on non-GET, `resolveAccess`, the view-as guard, the policy, the body parser (after the policy, so a refused request is never parsed), the route's limiter, then the handler. Add a route by adding a table entry.

`resolveAccess` (`access/resolve.ts`) recomputes the caller's access from the primary on every request, with no cache. The client routes on `access.state` from `GET /api/me`.

### Tenant isolation (pinned by `api/test/isolation.test.ts`)

- Tenant store functions in `api/src/stores/` take an `OrgScope`, which only `access/policy.ts` can mint. The organization always comes from the caller's seat, never from the request, so an id from another organization answers 404 exactly like an unknown id.
- Lookups keyed by a person or spanning organizations live in `stores/cross-tenant.ts`; the test pins which files may import it.
- Product code answers 401 only through `userGone()` in `access/resolve.ts`. The client refreshes its session on any 401, so every other denial is 403 or 404.

### Data and writes

MongoDB through mongoose. Production is Azure DocumentDB (`retryWrites=false`) and local Mongo is standalone, so there are no multi-document transactions: writes are ordered so a retry completes them, unique indexes catch races, and concurrent edits use compare-and-set (joins, chat turn claims) or change, recount, revert (the last org admin). Townwise collections take the `tw_` prefix. Indexes build at boot, in `ensureIndexes` after every store has registered its models.

### Privacy rules in code

Logs and audit events carry ids and counts from per-action allowlists. Never put an email or name in a URL path or query (server-core logs the URL), and never log sales figures, note text, chat messages, or tool inputs and results. A sales upload is three fields per day, parsed in the browser.

### Tuning chat

`api/src/chat/` runs Codex turns (Anthropic SDK) in a turn runner detached from the request and streams them over SSE, resumable from the turn's record (D45), with tools that read a location's sales, notes, rules, forecast, orders, calendars, town and Your data, draw charts, search the web, start calibrations for org admins, and propose notes, data items and order changes. What TownwiseAI saves on its own (D59) goes through `api/src/agent/apply.ts` into `tw_agent_changes`, with Undo. Off unless `ANTHROPIC_API_KEY` is set. Bounded per turn (8 model calls, 150 seconds) and per organization per month (`TOWNWISE_CHAT_MONTHLY_BUDGET_USD`, list prices in `chat/pricing.ts`). Contract: `docs/portal/tuning-chat.md`.

### Client

Expo Router (SDK 58) for iOS, Android and web. `app/(marketing)/` holds public pages that read no auth state; on web they render DOM and SVG from `.web.tsx` files (the homepage map is `src/marketing/map/`). `app/(gate)/` holds the signed-in app behind `Stack.Protected` guards. Inside it, `PortalGate` loads `GET /api/me` and each route group's `AccessGuard` redirects any path that `isAllowed` (`src/portal/routing.ts`) refuses for the person's access state, role or view-as, so a new page needs its path added there. Page ownership and the shared portal pieces: `src/portal/README.md`. Rules, each pinned by a test or lint:

- Only `.web` files import a module by its `.web` name, and no platform-suffixed file goes under `app/` (`test/marketing/boundary.test.ts`).
- Only static `process.env.EXPO_PUBLIC_*` reads; each value is compiled into the bundle.
- An `asChild` element (expo-router's `<Link asChild>`) has one child written in place, styled with an object literal, a `styles.x` member or `StyleSheet.flatten(...)`. `Link` merges that style as a plain object, so a function style is dropped and an array throws in development (`test/portal/link-child.test.ts`).
- No inline `<script>` in the web export (`scripts/check-web-export.mts`). The CSP in `client/MODULE.md` (## Security) is served by `infra/web/staticwebapp.config.json`, so a change that needs a new origin updates both.

### Infra and deploy

Azure, with Terraform in two stacks: `bootstrap` (applied by the subscription owner) and `production`. `deploy.yml` runs only on `main` with the `DEPLOY_ENABLED` repository variable, every job on camo's self-hosted runner (`runs-on: [self-hosted, townwise-deploy]`; `id-token-guard` allows only that list or `ubuntu-24.04`). It deploys only the services whose files changed since its last successful run (web: `client/`, `infra/web/`; API: `api/`, which also moves the weekly forecast worker job; lab: `modeling/lab/`; all three for root package files, `.nvmrc`, `.npmrc`, `tsconfig.base.json` or the workflow). Its build jobs get no OIDC token, and CI's `id-token-guard` fails unless `jobs.deploy` is the only job that can request one. `api/production.env` is public, non-secret config baked into the image; secrets are Key Vault references set in `infra/terraform/production/containerapp.tf`. Runbook: `infra/README.md`.

## Docs are the spec

- `api/README.md`: roles, access states, flows, every endpoint, rate limits, collections and env vars. Update it when routes or behavior change.
- `docs/portal/spec.md`: the build spec; "spec Section N" in code comments points here.
- `client/MODULE.md` and `api/kit/*/MODULE.md`: contracts, security notes and local changes.
- `[CONFIRM: ...]` marks a shipped default awaiting the team's sign-off; `[DECISION NEEDED: ...]` marks an open gap the product shows honestly. Do not resolve or delete either without a decision from the team.

## Conventions

- PRs target `develop`. `main` is production: a merge there deploys.
- `develop` is never behind `main` (owner, 2026-11-19). Right after a release PR merges into `main`, merge `main` back into `develop` and push it: `git fetch origin && git merge --no-autostash --no-edit origin/main` on `develop` (a fast-forward when `develop` hasn't moved, otherwise a merge commit named `chore: merge main back into develop`). A release adds only its merge commit, so this changes no files; a fix that lands on `main` or a release branch first comes back the same way. Check with `git rev-list --count origin/develop..origin/main`, which must be 0.
- Pushing to `develop` needs no one's go: the owner gave every session standing permission on 2026-11-17 ("you have permission to push anything to develop"). Push straight to `develop` or merge a PR into it, after the checks your change needs, and hold off while a release PR's CI is running. `main` still needs the owner's go, through a release PR.
- Commit as you go (owner, 2026-11-17): commit each finished, checked piece of work on your branch when it's done, in Conventional Commits, rather than leaving work uncommitted until the end of a task.
- `data/` holds a partner restaurant's private Toast exports and is gitignored, as is `modeling/outputs/`. Never commit either, and never print customer or group names that appear in Toast item names.
- `modeling/forecasts/` holds frozen forecasts, committed before their outcomes existed so they can be scored honestly; the commit is the timestamp. Never edit or regenerate them (`demand_model_v0.ipynb` refuses to overwrite them).
- Everything is pinned: exact dependency versions, container images by digest, GitHub Actions by commit SHA. Keep new additions pinned the same way.
