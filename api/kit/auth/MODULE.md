---
name: auth
summary: Web and native sign-in with 10-minute JWT access tokens, hashed rotating refresh tokens with reuse detection, Google ID-token sign-in, magic links and TOTP.
requires: [server-core, mongo, redis, rate-limit]
env:
  - { name: AUTH_ISSUER, required: true, secret: false }
  - { name: AUTH_JWT_KEYS, required: true, secret: true }
  - { name: AUTH_ENCRYPTION_KEYS, required: true, secret: true }
  - { name: AUTH_MAGIC_LINK_URL, required: true, secret: false }
  - { name: AUTH_TOTP_ISSUER, required: true, secret: false }
  - { name: AUTH_GOOGLE_CLIENT_IDS, required: false, secret: false }
status: beta
source:
  repo: coffee-chats/coffee-chats-mvp
  commit: ea8d0d8b20ffb1ab880e949c53d7377a6a72fd0e
  paths:
    - api/src/modules/extensionAuth/
    - api/src/modules/auth/services/tokenService.js
    - api/src/modules/auth/services/googleIdentityService.js
    - api/src/modules/auth/strategies/jwt.js
    - api/src/modules/auth/controllers/signinController.js
    - api/src/modules/auth/controllers/signupController.js
    - api/src/modules/auth/controllers/magicLinkController.js
    - api/src/modules/mcp/authorization/googleIdentityVerifier.js
    - api/src/modules/admin/services/adminMfaService.js
    - api/src/shared/utils/totp.js
    - api/src/shared/utils/tokenCrypto.js
    - api/src/infrastructure/middleware/csrfOrigin.js
---

## Wire it in

Status stays beta until the manual checks in 3-auth.md 20.2 are done.

`createAuth` reads `NODE_ENV` and `CORS_ORIGINS` from server-core. They are not auth env vars. The composition root spreads `serverSchema`, `mongoSchema`, `redisSchema` and auth's `configSchema` (shown below as `authSchema`) into one `loadEnv` call. Library code never reads `process.env`.

```ts
const config = loadEnv(z.object({
  ...serverSchema.shape, ...mongoSchema.shape, ...redisSchema.shape, ...authSchema.shape,
}), process.env);
const logger = createLogger(config);
const mongo = await connectMongo({ config, logger });
const redis = createRedis({ config, logger });
const auth = createAuth({
  config, logger, redis: redis.client,
  stores: createMongoAuthStores(mongo.connection),
  sendMagicLink,                       // the product's mailer until the wave-2 email module
});
await ensureIndexes(mongo.connection, { logger });   // after every store has registered its models
await redis.ready(3000);
const api = express.Router();
api.use(express.json({ limit: '100kb' }));
api.get('/projects', auth.requireAuth, (req, res) => { const { userId } = authOf(req); /* ... */ });
const server = createServer({ config, logger, routes: [{ path: '/auth', router: auth.router }, { path: '/api', router: api }],
  onShutdown: [redis, mongo] });
await server.listen();
```

`sendMagicLink({ to, url, expiresAt })` must not log `url`. The provider's click tracking must be off for this message. Click tracking rewrites the link through the provider's redirector, which then holds the full URL, fragment included.

For local development only, append each URL to a gitignored file. Never use the logger or stdout. The kit root `.gitignore` lists `.magic-links`.

```ts
import { appendFile } from 'node:fs/promises';
import type { MagicLinkMessage } from '@ckeith26/auth';

async function sendMagicLink(message: MagicLinkMessage): Promise<void> {
  const line = `${message.url}\n`;
  await appendFile('.magic-links', line, { mode: 0o600 });
}
```

Call `ensureIndexes` before `listen`. `createMongoAuthStores` registers models; the first registration of a model name on a connection wins, so build a fresh schema inside the factory.

## Deployment assumptions

- The web app and the API must be same-site: `app.example.com` with `api.example.com`, or the API path-mounted on the web origin. Then SameSite cookies flow on `fetch(..., { credentials: 'include' })`.
- Two default platform domains are cross-site even when the names look related: `vercel.app`, `herokuapp.com`, `fly.dev`, `onrender.com`, `netlify.app` and `pages.dev` are public suffixes. Use a custom domain.
- If the API cannot be same-site, SameSite cookies are not sent, and `SameSite=None` breaks under third-party cookie blocking (Safari blocks by default). The supported fix is a same-site reverse proxy or a custom domain, not a weaker cookie mode.
- If the API host is a CNAME to another registrable domain (for example `*.elb.amazonaws.com`), WebKit's CNAME-cloaking defense caps cookies it sets at 7 days. Use a Route 53 alias (flattened) record, and check the `__Host-refresh` expiry in Safari Web Inspector during QA.
- Development: cookies scope by site and the scheme is part of the site, so `http://localhost:8081` and `http://localhost:9090` share cookies, while `127.0.0.1` or an https dev proxy is cross-site and breaks dev auth. `createAuth` enforces one scheme and the `localhost` host across issuer, magic-link URL and web origins.
- `trust proxy` must be right in server-core so `req.ip` is the client address. Otherwise the per-IP rules key on the load balancer or on attacker-supplied `X-Forwarded-For`.

## Client contract

Owned by `mobile/expo-shell`. The server half is what this module answers.

- `requireAuth` answers 401 `unauthenticated` for a bad or expired access token. The shell refreshes on any 401 from an `auth: true` request (one refresh, one retry, never a loop). Only a 401 `session_ended` from `/refresh` ends the session. 429, 5xx and network errors keep it. 403 `origin_not_allowed` is a configuration error, not a dead session.
- After a refresh, retry the original request with the new access token.
- Wrong codes are 400 `invalid_code`, not 401, so generic refresh-on-401 never fires on TOTP screens. An expired or foreign mfa token is 401 `invalid_mfa_token` (back to sign-in).
- Native requests send `credentials: 'omit'` and never send `Origin`. Web requests send `credentials: 'include'`. Neither sends `X-Requested-With`.
- Refresh is single-flight per client: an in-process promise on native, `navigator.locks.request('kit-auth-refresh', ...)` across tabs on web. Without it, two concurrent refreshes from one client both succeed (one normal, one grace) and the client may keep the older token, which its next refresh, 10 minutes later, reports as reuse.

## Security

1. Access tokens: 10 min, pinned `alg`, `typ`, `iss`, `aud` and required claims, `KeyObject` keyring with the two-phase rotation runbook below.
2. Refresh tokens: opaque, SHA-256 at rest, CAS rotation, every retired hash remembered, reuse of any of them revokes the session, one-shot 60 s grace that does not move its own clock, idle and absolute expiry on every path, session ends when the user is gone.
3. Per-request liveness from the primary. Credentials are bound to their platform's channel.
4. Platform: explicit declaration, refused for native when browser-only headers are present, web requires an allowlisted `Origin`. Mfa tokens and magic links are bound to the requesting platform.
5. Web: `__Host-` httpOnly cookies, Strict refresh cookie, duplicate cookie names refused, no tokens in web bodies, one Origin list for CORS, the global guard and auth, JSON-only bodies, `no-store`. GET handlers must be side-effect free. The only GET is `/me`.
6. Google: single verification path, string `aud` from an allowlist, issuer pin, RS256 only, verified email, identity by `sub`, email linking and sync only when Google is authoritative.
7. Magic link: 256-bit token, hash at rest, 15 min, atomic single use bound to email and platform, POST plus click redemption showing the account, fragment delivery, identical responses, per-email and per-IP limits keyed by HMAC email ids, newest link only, pending links deleted on redemption and logout-all.
8. TOTP: secret encrypted (AES-256-GCM with AAD) through `createTokenCrypto`, monotonic step guard, attempts counted before checking, two-window per-account limits, hashed single-use recovery codes, recent-auth window, other sessions revoked on enable.
9. zod on every body. Intentional query operators only through `trusted()`. `sanitizeFilter` sits underneath.
10. Boot refuses production configs with http or localhost URLs, mixed schemes, or a magic-link URL off the web origins.

| # | Threat | Control | Named test |
|---|---|---|---|
| T1 | ID token minted for another app signs a user in or creates an account (pre-account takeover) | one `verifyGoogleIdToken` with an `aud` allowlist for sign-in and sign-up | `google > first-time Google sign-in rejects an ID token issued to another client id` |
| T2 | Forged or algorithm-confused JWT | `algorithms: ['HS256']`, kid lookup | `tokens > rejects alg none, HS512 and RS256 tokens` |
| T3 | Refresh or mfa token used as an access token | opaque refresh tokens; `typ` pinned per kind | `refresh > the refresh token is rejected as a bearer access token`; `tokens > an mfa token is not an access token and an access token is not an mfa token` |
| T4 | Access token works after logout or revocation | per-request liveness, primary reads, no cache | `require-auth > a revoked session's access token is refused on the next request` |
| T5 | Stolen refresh token replayed after the owner rotated | reuse detection revokes | `refresh > replay of the previous token after the grace window revokes the session` |
| T6 | Attacker rotates a stolen token twice so the owner's copy looks unknown | retired ledger | `refresh > replay of a token two rotations old revokes the session` |
| T7 | Two holders alternate grace retries to share a session | grace leaves the rotation clock unchanged; one-shot grace | `refresh > a grace rotation does not move lastUsedAt`; `refresh > presenting the original token after a grace retry revokes the session` |
| T8 | Concurrent refresh forks a family or double-spends | CAS on the current hash; one row per family | `refresh > concurrent refreshes with one token leave exactly one live token` |
| T9 | Database dump yields live credentials | hashes for refresh, ledger, magic link, recovery codes; TOTP secret encrypted | `refresh > the raw refresh token never reaches the store or the database`; `magic-link > stores only the SHA-256 of the token`; `totp > stores the secret encrypted and recovery codes hashed` |
| T10 | XSS reads session tokens | httpOnly cookies; no tokens in web bodies | `web-session > web sign-in sets __Host- httpOnly cookies and returns no token fields` |
| T11 | XSS in the browser obtains native-mode tokens | native refused when `Origin` or `Sec-Fetch-Site` is present; web requires an allowlisted `Origin` | `native-session > a native declaration with an Origin header is 403`; `native-session > a native declaration with Sec-Fetch-Site is 403` |
| T12 | XSS exfiltrates a first-factor credential and redeems it off-browser for a long native session | mfa `plat` claim; magic link bound to platform; Google residual below | `native-session > an mfaToken issued to a web sign-in is refused in native mode`; `magic-link > a link requested on web cannot be redeemed as native and stays redeemable on web` |
| T13 | CSRF on cookie-authenticated mutations, including from a sibling subdomain | SameSite plus an exact Origin allowlist (server-core guard and `requireAuth`) | `web-session > cookie-authenticated POST with a sibling-subdomain Origin is 403`; `require-auth > a cookie-authenticated POST without Origin is 403` |
| T14 | Login CSRF on sign-in routes | allowlisted Origin for web sign-in | `web-session > web sign-in from a non-allowlisted Origin is 403` |
| T15 | Cookie tossing or duplicate cookies from a subdomain | `__Host-` on both cookies; duplicate names refused | `web-session > both cookies are __Host- with Path=/ and no Domain`; `web-session > a request carrying the refresh cookie name twice is refused and clears cookies` |
| T16 | Link scanner or prefetch redeems the magic link | POST-only redeem, click-to-continue page, fragment token | `magic-link > GET on the redeem path does not consume the token` |
| T17 | Magic-link token leaks through logs, Referer or the mail provider | fragment delivery, no URL tokens, allowlist serializers, click tracking off | `magic-link > the link carries the token in the fragment only`; `logging > no log line contains a token, code or credential header` |
| T18 | Magic link redeemed twice | atomic consume | `magic-link > one token redeems exactly once under 5 concurrent POSTs` |
| T19 | Forwarded magic link signs the victim into the attacker's account | landing page shows the email; redeem must echo it | `magic-link > a redeem whose email does not match consumes nothing` |
| T20 | Email enumeration | no lookup on request; identical 202 and limits | `magic-link > known and unknown emails get byte-identical responses` |
| T21 | Mail-bombing a stranger | per-IP first, then per-email 3 per 15 min and 10 per day | `magic-link > the 4th request for one email within 15 minutes is 429` |
| T22 | Email ids in logs or Redis reversed by dictionary | HMAC with a server-held derived key | `email-id > differs from the unsalted SHA-256 and changes with the key` |
| T23 | TOTP brute force | 5 per 15 min and 20 per 24 h per account, counted before checking | `totp > a correct code on the 6th attempt within 15 minutes is 429`; `totp > the 6th attempt is 429 even when submitted concurrently`; `totp > the 21st attempt within 24 hours is 429` |
| T24 | TOTP code replay | monotonic `lastUsedStep` CAS | `totp > a code from an earlier step is refused after a later step was accepted` |
| T25 | Session thief enrolls TOTP to persist and lock out the owner | recent-auth window; other sessions revoked on enable | `totp > enroll requires a session created within 15 minutes`; `totp > enabling TOTP revokes the user's other sessions` |
| T26 | Account takeover through Google email linking | link by `sub`; email linking only when authoritative | `google > refuses to create or link for a non-Gmail, non-Workspace email` |
| T27 | Reassigned Workspace address reaches the old account by magic link | email sync on sign-in by `sub` | `google > sub sign-in with a changed authoritative email updates the stored email` |
| T28 | NoSQL operator injection | zod string schemas; `sanitizeFilter`; `trusted()` only on code-built operators | `magic-link > a non-string token is 400 and consumes nothing` |
| T29 | Outage signs everyone out | store errors are 500, never 401 | `require-auth > answers 500, not 401, when the session store throws`; `refresh > answers 500, not 401, when Mongo is unavailable` |
| T30 | Stale secondary read accepts a revoked session | `read: 'primary'` on every auth model | `mongo-stores > every auth model reads from the primary` |
| T31 | Deleted or banned user keeps a session | session ends at the next refresh; `revokeAllSessions` for immediate effect | `refresh > a session whose user was deleted ends at the next refresh`; `logout > revokeAllSessions ends every session and deletes pending links` |
| T32 | Development config shipped to production silently drops Secure and mails localhost links | boot-time scheme, host and origin checks | `config > createAuth rejects an http issuer when NODE_ENV is production` |
| T33 | Malformed body logs a token through `err.body` | server-core error handler logs the type only; auth never logs bodies | `logging > a malformed JSON body containing a refresh token appears in no log line` |
| T34 | Key rotation breaks sessions or causes a rolling-deploy outage | verify-only phase before signing; refresh tokens are not JWTs | `tokens > a key appended but not yet first verifies tokens it signed` |
| T35 | Ciphertext swapped between users | cipher AAD `auth_totp:<userId>:secret` | `totp > a TOTP ciphertext copied to another user does not decrypt` |

Google residual risk: a Google ID token is not bound to a platform in wave 1. Script on the web origin that obtains a Google Identity Services credential can redeem it in native mode until the token's `exp` (at most one hour) and receive a 30-day native session. TOTP still applies to users who enabled it. Binding by `azp` waits until real iOS and Android tokens have been captured.

Delegated choices, written 2026-10-29:

- A-L1 `previousTokenDecision` returns `rotate_again` when `now.getTime() - session.lastUsedAt.getTime() <= GRACE_SECONDS * 1000`, and `revoke` otherwise. `GRACE_SECONDS` is 60.
- A-L2 `isGoogleAuthoritative` returns `claims.email.endsWith('@gmail.com') || claims.hd !== undefined`.
- A-L3 `isRecentAuth` returns `now.getTime() - auth.authenticatedAt.getTime() <= 15 * 60 * 1000`. The clock is `session.createdAt` (`authenticatedAt`). Refresh does not move it.
- A-L4 `onLimiterUnavailable` returns `deny` when `rule.sensitive` is true, and `allow` for `auth:ip`, the only rule that is not sensitive. A Redis outage therefore answers 503 on magic-link send and TOTP checks, and still serves the resource-bounding IP rule.

## Key rotation

Both rings are `kid:base64,kid:base64`. The first entry is current. Every listed entry verifies or decrypts. Kids match `^[a-z0-9][a-z0-9-]{0,15}$` and are unique. Keys are canonical standard base64. JWT keys decode to 32 to 64 bytes. Encryption keys decode to exactly 32 bytes. Parsed keys are `KeyObject`s, which serialize to `{}`.

`AUTH_JWT_KEYS`, two phases, so a rolling deploy never has an instance that cannot verify what another signs:

1. Append the new key (`old,new`) and deploy everywhere. It only verifies.
2. Move it first (`new,old`) and deploy. New tokens are signed with it. Instances still on phase 1 verify them. This step also changes the email-id key (`HKDF-SHA-256` of the first JWT key, info `kit-auth:email-id`), so per-email rate-limit counters restart once and `emailId` values before and after do not correlate.
3. When that deploy has finished, wait 10 minutes (one access lifetime; mfa tokens live 5), remove `old`, and deploy.

`AUTH_ENCRYPTION_KEYS` uses the same two phases: append the new key as decrypt-only and deploy, then move it first and deploy. On every successful TOTP code, a secret whose kid is not first is re-encrypted under the current key in the same CAS that claims the step. Instances still on the old list answer 500 for secrets written under the new key during a rolling deploy.

Key compromise: replace the JWT ring with a single new key and deploy. Every access and mfa token fails. Clients refresh. Refresh tokens are not JWTs and are unaffected, so nobody is signed out. During that rolling deploy instances disagree, so clients see extra 401-then-refresh round trips until it completes. Replace a compromised encryption key the same way, then rely on the stale-key re-encrypt path for users who next present a valid code. Secrets encrypted only under a removed key do not decrypt.

## Storage note

The retired ledger stores one small document per rotation (`auth_refresh_retired`), purged a week after the session's absolute expiry. A web user active an hour a day rotates about 6 times a day, about 180 documents per active session per month.

## Changes from source

- Ported: `sessions.ts` from `api/src/modules/extensionAuth/services/extensionSessionService.js:51-57` (hash, generation), `:84-107` (mint), `:117-187` (grace, rotate CAS), `:196-202` (revoke). Generalized to web and native, with absolute expiry, expiry on the grace path, a retired ledger, grace that does not move the clock, a CAS loser that takes the previous-hash path, and no Redis.
- Ported: `stores/mongo/sessions.ts` from `api/src/modules/extensionAuth/models/ExtensionSession.js:22-36`. `refreshHash` is unique. Drops `cid`, `codeJti`, `heartbeatAt` and `userAgentHint`. Adds `platform`, `absoluteExpiresAt`, `revokeReason`, a purge TTL and `auth_refresh_retired`.
- Ported: the refresh user check from `api/src/modules/extensionAuth/controllers/extensionAuthController.js:327-334` and `api/src/modules/auth/strategies/jwt.js:106-110`. Moved to rotation only, so `requireAuth` stays one read.
- Ported: `tokens.ts` from `api/src/modules/auth/services/tokenService.js:19` (HS256 pin), `:31-44` and `:134-148`. jose instead of jwt-simple, 600 s instead of 30 days, and `iss`, `aud`, `sid`, `kid` and `typ` added and pinned.
- Ported: the mfa token in `tokens.ts` from `api/src/modules/auth/services/tokenService.js:85-117`. One purpose survives, with its own `typ` and a `plat` claim.
- Ported: `middleware.ts` from `api/src/modules/auth/strategies/jwt.js:27-57, 68-140` and `api/src/modules/auth/strategies/index.js:58-79`. passport removed. Bearer wins over the cookie. Platform binding. Origin required on unsafe cookie requests. Store errors are never 401.
- Ported: `cookies.ts` from `api/src/modules/auth/services/tokenService.js:160-176, 194-267` (set, and clear with identical options at `:255-267`). `__Host-` on both cookies, Strict refresh, no Domain, duplicate names refused.
- Ported: CSRF via server-core from `api/src/infrastructure/middleware/csrfOrigin.js:25-48`. server-core owns the global guard. Auth uses the same parsed list for its own check.
- Ported: `google.ts` from `api/src/modules/auth/services/googleIdentityService.js:20-29` (primary reads), `:86-153` (sub first, email sync CAS at `:97-117`, conditional link), `:60-68` and `:208-232` (race retry, effects once); `api/src/modules/mcp/authorization/googleIdentityVerifier.js:19, 97-110` (claim hardening); `api/src/modules/auth/controllers/signinController.js:552-561` (audience). ID token via jose. Email linking and sync only when authoritative. Side effects become `onUserCreated`.
- Ported: `magic-link.ts` from `api/src/modules/auth/controllers/magicLinkController.js:50` (single response), `:56-79` (limit before lookup), `:302` (32 random bytes), `:308` (new link replaces old), `:396-399` (cooldown reset on redemption). Hash at rest, fragment link with email, POST redeem with email echo, platform binding, atomic consume, sign-up on redeem.
- Ported: `totp/totp.ts` from `api/src/shared/utils/totp.js:16-219`. Straight TypeScript port. Issuer comes from config.
- Ported: `token-crypto.ts` from `api/src/shared/utils/tokenCrypto.js`. Canonical 32-byte keys, AAD with version, kid and context, pinned tag length, no plaintext passthrough. Auth adds the per-user context `auth_totp:<userId>:secret` and lazy re-encryption.
- Ported: `totp/factor.ts` from `api/src/modules/admin/services/adminMfaService.js:273-305` (count, verify, replay guard in one place) and `api/src/modules/admin/controllers/adminMfaController.js:137-200` (enroll then confirm; `otpauthUri` returned). The pending secret is encrypted in Mongo. Recovery codes are new. The QR is a server-rendered PNG data URL instead of the client drawing it (`client/components/shared/AdminMfaModal.jsx:41`).
- Ported: `limits.ts` from `api/src/modules/auth/routes.js:64-74, 123-133`. The refresh-limit rationale is kept. Rules are centralized.
- Ported: logout from `api/src/modules/auth/routes.js:94-103`. Logout succeeds without a valid access token.
- Ported: logout-all from `api/src/modules/auth/services/tokenService.js:269-301` (including pending links at `:297-299`). Per-session rows. `revokeAllSessions` is exported for app code.
- Ported: the Mongo index rule from `api/src/modules/users/models/User.js:1526-1530, 1559-1564`. Partial `$type` indexes, never sparse, no null defaults.

- Fixed: Google sign-up path has no audience check (`api/src/modules/auth/controllers/signupController.js:375-397`). Pinned by `test/google.int.test.ts` > "first-time Google sign-in rejects an ID token issued to another client id".
- Fixed: 30-day access tokens (`api/src/shared/config/index.js:259-264`). Pinned by `test/tokens.test.ts` > "signs access tokens with HS256, typ at+jwt, kid and a 600 s lifetime".
- Fixed: refresh token usable as an access token (`api/src/modules/auth/services/tokenService.js:56-70`, `api/src/modules/auth/services/appSessionClaims.js:1-15`, asserted by `api/src/modules/auth/strategies/__tests__/jwtPurposeTokenRejection.test.js:81-84`). Pinned by `test/refresh.int.test.ts` > "the refresh token is rejected as a bearer access token".
- Fixed: refresh token stored in plaintext and compared with `!==` (`api/src/modules/users/models/User.js:423`, `api/src/modules/auth/controllers/signinController.js:219`). Pinned by `test/refresh.int.test.ts` > "the raw refresh token never reaches the store or the database".
- Fixed: refresh rotation not atomic (`api/src/modules/auth/controllers/signinController.js:212-232`). Pinned by `test/mongo-stores.int.test.ts` > "SessionStore contract rotate CAS: 10 concurrent calls, exactly 1 wins, and records the retired hash".
- Fixed: one refresh token per user, so all devices share it (`api/src/modules/users/models/User.js:423`, `api/src/modules/auth/services/tokenService.js:227-247`). Pinned by `test/refresh.int.test.ts` > "two devices hold independent sessions; revoking one leaves the other".
- Fixed: tokens in web response bodies (`api/src/modules/auth/controllers/signinController.js:239-243, 380-383`, `api/src/modules/auth/controllers/signupController.js:349-352`). Pinned by `test/web-session.int.test.ts` > "web sign-in sets __Host- httpOnly cookies and returns no token fields".
- Fixed: `SameSite=None` credentialed cookies in production (`api/src/shared/config/index.js:268`). Pinned by `test/web-session.int.test.ts` > "refresh cookie is SameSite=Strict, access cookie SameSite=Lax"; `test/web-session.int.test.ts` > "cookie-authenticated POST with a sibling-subdomain Origin is 403".
- Fixed: verbose refresh logging (`api/src/modules/auth/controllers/signinController.js:187-191`). Pinned by `test/logging.int.test.ts` > "a malformed JSON body containing a refresh token appears in no log line"; `test/logging.int.test.ts` > "no log line contains a token, code or credential header".
- Fixed: magic-link token in plaintext, in the query string (`api/src/modules/users/models/User.js:419`, `api/src/modules/auth/controllers/magicLinkController.js:308, 316`). Pinned by `test/magic-link.int.test.ts` > "stores only the SHA-256 of the token"; `test/magic-link.int.test.ts` > "the link carries the token in the fragment only".
- Fixed: magic link redeemed by GET with the token in the path, auto-redeemed by the client (`api/src/modules/auth/routes.js:226-229`, `client/hooks/useMagicLink.js:82-88`). Pinned by `test/magic-link.int.test.ts` > "GET on the redeem path does not consume the token".
- Fixed: magic-link redeem not atomic (`api/src/modules/auth/controllers/magicLinkController.js:369-415`). Pinned by `test/magic-link.int.test.ts` > "one token redeems exactly once under 5 concurrent POSTs".
- Fixed: magic-link redeem route not rate limited (`api/src/modules/auth/routes.js:226-229`). Pinned by `test/magic-link.int.test.ts` > "the redeem route is rate limited by auth:ip".
- Fixed: account-existence signal (`api/src/modules/auth/controllers/magicLinkController.js:232-239`). Pinned by `test/magic-link.int.test.ts` > "known and unknown emails get byte-identical responses".
- Fixed: unsalted SHA-256 email as a Redis key (`api/src/modules/auth/controllers/magicLinkController.js:90`). Pinned by `test/email-id.test.ts` > "differs from the unsalted SHA-256 and changes with the key".
- Fixed: a revoked sid can stay live in a cache for 31 days (`api/src/modules/extensionAuth/services/extensionSessionService.js:19-20, 64-74, 213-230`). Pinned by `test/require-auth.int.test.ts` > "a revoked session's access token is refused on the next request".
- Fixed: grace path skips expiry and there is no absolute lifetime (`api/src/modules/extensionAuth/services/extensionSessionService.js:117-129, 169-173`, `api/src/shared/config/index.js:1295`). Pinned by `test/refresh.int.test.ts` > "idle and absolute expiry end the session, including on the grace path".
- Fixed: reuse memory is one generation, so rotating twice hides a theft (`api/src/modules/extensionAuth/services/extensionSessionService.js:146-162`). Pinned by `test/refresh.int.test.ts` > "replay of a token two rotations old revokes the session".
- Fixed: a grace retry stamps the rotation clock, so two holders can share indefinitely (`api/src/modules/extensionAuth/services/extensionSessionService.js:121-123`). Pinned by `test/refresh.int.test.ts` > "a grace rotation does not move lastUsedAt".
- Fixed: a concurrent refresh that loses the CAS gets `invalid_grant` (`api/src/modules/extensionAuth/services/extensionSessionService.js:181-184`). Pinned by `test/refresh.int.test.ts` > "concurrent refreshes with one token leave exactly one live token".
- Fixed: TOTP replay guard per exact step only (`api/src/modules/admin/services/adminMfaService.js:209-218`). Pinned by `test/totp.int.test.ts` > "a code from an earlier step is refused after a later step was accepted".
- Fixed: TOTP pending secret in plaintext Redis (`api/src/modules/admin/services/adminMfaService.js:229-236`). Pinned by `test/totp.int.test.ts` > "stores the secret encrypted and recovery codes hashed".
- Fixed: rate limiter TTL set in a second call, with an in-memory fallback on error (`api/src/infrastructure/middleware/rateLimiter.js:36-56`). Pinned by `test/totp.int.test.ts` > "the 6th attempt is 429 even when submitted concurrently".
- Fixed: Google auth-code path verifies only the web client ID (`api/src/modules/auth/controllers/signinController.js:438-441`). Pinned by `test/google.int.test.ts` > "accepts an ID token issued to any listed client id".
- Fixed: the client retries with the stale bearer and signs out on any refresh failure (`client/services/api.js:130, 161, 162-169`). Pinned by `test/refresh.int.test.ts` > "answers 500, not 401, when Mongo is unavailable"; `test/refresh.int.test.ts` > "a malformed refresh token is 401 session_ended, not 400".

- Dropped: auth realms (`api/src/modules/auth/services/authRealm.js`). Coffee-chat multi-console specific. One realm per product.
- Dropped: passport, passport-jwt and jwt-simple (`api/src/modules/auth/strategies/`, `api/src/modules/auth/services/tokenService.js:2`). Middleware with jose replaces them.
- Dropped: `rememberMe` (`api/src/modules/auth/services/tokenService.js:31-70`, `api/src/shared/config/index.js:241-250`). Already duration-neutral in coffee-chat.
- Dropped: `auth.sessionsRevokedAt` iat cutoff (`api/src/modules/auth/strategies/jwt.js:118-122`, `api/src/modules/auth/services/tokenService.js:283-301`). Per-session rows make revoke-all a row update.
- Dropped: `settings.lastSeenAt` heartbeat (`api/src/modules/auth/strategies/jwt.js:128-134`). Product analytics. It must not touch `lastUsedAt`.
- Dropped: extension heartbeat, presence, authorize, consent and code exchange (`api/src/modules/extensionAuth/services/extensionSessionService.js:38-41, 242-281`, `api/src/modules/extensionAuth/controllers/extensionAuthController.js:60-308`). The extension is deferred.
- Dropped: Google token storage, refresh, revocation, Gmail scopes and photo mirroring (`api/src/modules/auth/services/tokenService.js:316-383`, `api/src/modules/auth/controllers/signinController.js:253-295, 474-524`). Identity-only sign-in. The calendar wave owns Google API tokens.
- Dropped: trial, referral, Stripe, campus, onboarding and plan-intent side effects (`api/src/modules/auth/controllers/signinController.js:330-358`, `api/src/modules/auth/services/googleIdentityService.js:159-233`, `api/src/modules/auth/controllers/signupController.js:413-440`). Product-specific. `onUserCreated` is the hook.
- Dropped: institution portal gating and RISC suppression in magic link (`api/src/modules/auth/controllers/magicLinkController.js:147-168, 261-299`). Product-specific. RISC is deferred.
- Dropped: the Redis no-account cooldown claim and `requestedAt` fallback (`api/src/modules/auth/controllers/magicLinkController.js:80-106, 241-259`). Replaced by rate-limit rules keyed by email id. The limit-before-lookup insight is kept.
- Dropped: admin step-up elevation (`api/src/modules/admin/services/adminMfaService.js:41-161`). Sensitive-action elevation is deferred. The kit has a recent-auth window.
- Dropped: phone (SMS) sign-in (`api/src/modules/auth/routes.js:242-260`). NIST restricts SMS as an authenticator.

## Local changes

- Azure DocumentDB (vCore) duplicate keys (`src/stores/mongo/users.ts`). DocumentDB's code 11000 errors carry neither `keyPattern` nor `keyValue`, so a duplicate email or Google subject was rethrown raw: a Google email conflict answered 500 instead of 409, and concurrent first Google sign-ins answered 500. When both fields are absent, the store now reads DocumentDB's exact message. An insert or update names the index, and only `email_1` and `googleSubject_1` map to a field. A findAndModify names no index, so `updateEmail` and `linkGoogleSubject` pass the one unique field their `$set` writes. Any other text or index rethrows as before; MongoDB errors still map by `keyPattern` and `keyValue` only. Pinned by `duplicate-key > a DocumentDB insert duplicate maps the named index to its field`, `duplicate-key > a DocumentDB findAndModify duplicate names no index, so it maps to the one field the update sets` and the other tests in `test/duplicate-key.test.ts`, and by `mongo-stores > the users unique indexes carry the names the DocumentDB duplicate-key mapping reads`. Checked against documentdb-local pg17-1.0.0. Offered upstream to camkeith/modules.
- The test Mongo's TTL monitor is off (`test/global-setup.ts`; tests only, the library is unchanged). The tests run on a clock frozen at 2026-06-01, but mongod's TTL monitor deletes by the wall clock, by which every session and magic link a test writes has long expired. A pass, once a minute, could delete them mid-test; the Townwise API suite, on the same harness, failed so in CI with a 401. The global setup now turns the monitor off; the TTL index definitions stay pinned by `mongo-stores > TTL indexes present with the stated expireAfterSeconds`. Pinned by `mongo-stores > the test database deletes nothing by the wall clock: its TTL monitor is off`.
- mongoose 9.11.2 to 9.11.4 (`package.json`, 2026-11-11), with the API, for the advisories osv-scanner reports on 9.11.2 (GHSA-6972-9mcm-vhwj, GHSA-8332-j7wj-wjw4, GHSA-gg4r-jv3p-qx3c, GHSA-wr5m-5jph-8m96). A patch release, published 2026-10-23, past the 7-day release-age gate. Pinned by this module's whole suite, which runs on the new version.
