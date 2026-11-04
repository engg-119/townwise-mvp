---
name: expo-shell
summary: Expo SDK 58 app shell (iOS, Android, web) with Google and magic-link sign-in, TOTP, protected routes and a refresh-safe client for backend/auth.
requires: []
env:
  - { name: EXPO_PUBLIC_API_URL, required: true, secret: false }
  - { name: EXPO_PUBLIC_WEB_URL, required: false, secret: false }
  - { name: EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, required: false, secret: false }
  - { name: EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, required: false, secret: false }
status: beta
source:
  repo: coffee-chats/coffee-chats-mvp
  commit: ea8d0d8b20ffb1ab880e949c53d7377a6a72fd0e
  paths:
    - client/services/api.js
    - client/services/tokenStore.js
    - client/store/authSlice.js
    - client/app/_layout.jsx
    - client/app/(app)/_layout.jsx
    - client/app/(auth)/_layout.jsx
    - client/app/auth/verify.jsx
    - client/hooks/useMagicLink.js
    - client/hooks/useGoogleAuth.js
    - client/utils/gisClient.js
    - client/utils/navHistory.js
    - client/services/adminMfaGate.js
    - client/services/adminMfa.js
    - client/components/shared/AdminMfaModal.jsx
    - client/constants/webGlobalCss.js
    - client/metro.config.js
    - extension/src/lib/apiClient.js
    - extension/src/lib/auth.js
    - extension/src/lib/tokenStore.js
---

## Wire it in

Copy the module in, then `npm run export:web` from the package (or `npm run export:web -w @ckeith26/expo-shell`). That runs `expo export --platform web` and fails if `index.html` contains an inline script. The web build must not be deployed without the headers in Security.

Set the four `EXPO_PUBLIC_*` variables. Every one of them is compiled into the app. `EXPO_PUBLIC_API_URL` is required. `EXPO_PUBLIC_WEB_URL` is the bare web origin; leave it empty on a native build that should not open magic links. The sign-in screen offers Google only and has no email form. The auth service's magic-link URL must be `${EXPO_PUBLIC_WEB_URL}/auth/magic`.

Rename the app identity in `app.config.ts` before shipping: `name` (`Kit App`), `slug` (`kit-app`), `scheme` (`kitapp`), and the iOS and Android ids (`com.example.kitapp`). Create Google Cloud clients for web, iOS, and Android (the Android client needs the app's SHA-1). Put the web client id in `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and the iOS client id in `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`. When the iOS id is set, the config plugin registers `com.googleusercontent.apps.<id-prefix>` as the URL scheme.

Native Google sign-in does not run in Expo Go. Use `npx expo run:ios`, `npx expo run:android`, or an EAS dev build.

Universal links and app links need `apple-app-site-association` and `assetlinks.json` under `/.well-known/` on the web origin, with this product's team id and certificate fingerprints. `apple-app-site-association` has no file extension and must be served as `application/json`. When `EXPO_PUBLIC_WEB_URL` is set, the config adds `applinks:<host>` and an Android intent filter for `https://<host>/auth/magic`.

Release age: `npx expo install --fix` was run under `min-release-age=7` and exited `ETARGET`. The gate refused Expo patch ranges because no version of those patches was published before the cutoff, and the gate was not lowered. The installed pins are the plan pins npm accepted:

- dependencies: `expo` 58.0.13, `expo-router` 58.0.22, `expo-linking` 58.0.13, `expo-constants` 58.0.13, `expo-secure-store` 58.0.2, `expo-file-system` 58.0.9, `expo-splash-screen` 58.0.10, `@expo/metro-runtime` 58.0.14, `react` 19.3.0, `react-dom` 19.3.0, `react-native` 0.88.0, `react-native-web` 0.21.4, `react-native-safe-area-context` 5.10.1, `react-native-screens` 4.30.0, `@react-native-google-signin/google-signin` 16.1.5, `zod` 4.6.7

`npx expo install expo-constants` also exited `ETARGET` for `expo-constants@~58.0.15` (published 2026-11-03, inside the 7-day gate). The plan pin 58.0.12 and `expo-asset`'s `~58.0.13` installed two copies, which `expo-doctor` rejects even with the dependency-version check skipped. `58.0.13` (published 2026-10-21) is the newest release that passes the gate and satisfies both ranges, so the direct dependency is that version and there is one copy.
- devDependencies: `typescript` 6.0.3, `@types/react` 19.3.0, `@types/node` 24.19.2, `jest` 30.5.2, `@types/jest` 30.0.0, `jest-expo` 58.0.11, `@react-native/jest-preset` 0.88.0, `@testing-library/react-native` 14.1.0, `test-renderer` 1.3.0, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2, `expo-doctor` 1.21.4

`typescript`, `@types/node`, and `zod` stay on the repo pins. The root override keeps `uuid` at 11.1.1.

## HTTP contract

The shell sends only `Accept: application/json`, `Content-Type: application/json` when there is a body, and on native `Authorization: Bearer <access>`. It sends no custom header. Every unauthenticated auth POST carries `platform` from the session kind (`cookie` is `web`, `bearer` is `native`). Web requests use `credentials: 'include'`. Native requests use `credentials: 'omit'`.

| Shell call | Request | Success | Errors the shell handles |
|---|---|---|---|
| Google | `POST /auth/google { idToken, platform }` | 200 `SignInResult` | 401 `invalid_google_token`; 403 `google_email_unverified`, `google_email_not_authoritative`, `origin_not_allowed`; 404 (Google off on the server); 409 `email_linked_to_other_google_account`, `google_email_conflict`; 429; 503 `google_unavailable`, `unavailable` |
| Magic link request | `POST /auth/magic-link { email, platform }` | 202 `{ ok: true }` | 400; 429; 503 `email_unavailable`, `unavailable` |
| Magic link redeem | `POST /auth/magic-link/redeem { token, email, platform }` | 200 `SignInResult` | 400 `invalid_or_expired_link`; 403; 429; 503 |
| MFA verify | `POST /auth/mfa/verify { mfaToken, platform, code or recoveryCode }` | 200 `SignInResult` (`signed_in`) | 400 `invalid_code` (inline, stay); 401 `invalid_mfa_token` (to sign-in with notice); 429 (lockout copy); 503 |
| Refresh | `POST /auth/refresh`; web `{ platform: 'web' }`; native `{ platform: 'native', refreshToken }` | web 204; native 200 `{ accessToken, accessTokenExpiresAt, refreshToken }` | 401 `session_ended` ends the session; everything else is transient |
| Current user | `GET /auth/me` | 200 `{ user: { id, email }, session: { id, platform }, totp: { enabled, recoveryCodesRemaining } }` | 401 triggers one refresh |
| Logout | `POST /auth/logout`; web `{ platform: 'web' }`; native `{ platform: 'native', refreshToken }` plus bearer | 204 | web: anything but 2xx keeps the user signed in; native: ignored |
| TOTP enroll | `POST /auth/totp/enroll` | 200 `{ secret, otpauthUri, expiresAt, qrPngDataUrl }` | 403 `reauth_required`; 409 `totp_already_enabled`; 503 |
| TOTP confirm | `POST /auth/totp/enroll/confirm { code }` | 200 `{ recoveryCodes: string[10] }` | 400 `invalid_code`, `enrollment_expired`; 403 `reauth_required`; 429; 503 |

`SignInResult` is `{ status: 'signed_in', user, session }` on web, the same plus `accessToken`, `accessTokenExpiresAt`, and `refreshToken` on native, or `{ status: 'mfa_required', mfaToken, mfaTokenExpiresAt }`. Schemas are `z.object` and strip unknown keys. The committed `backend/auth` route table also returns `isNewUser` on `signed_in`. The shell does not read it. Paths, body keys, and the fields the shell reads match that table.

Error bodies use `{ error, message, retryAfterSeconds? }`. `toApiError` reads `error` as the code. Any 401 on an authenticated request triggers one refresh and one retry, then stops. Server reuse grace is 60 seconds (`GRACE_SECONDS` in the committed auth module). `REFRESH_TIMEOUT_MS` is 15 seconds.

## Security

The web build must not be deployed without these headers:

```
Content-Security-Policy: default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client;
  style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data:; font-src 'self';
  connect-src 'self' <origin of EXPO_PUBLIC_API_URL> https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/;
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin-allow-popups   (needed only for the non-FedCM GIS popup; never same-origin)
Strict-Transport-Security: max-age=31536000; includeSubDomains
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
Every path rewritten to /index.html (single-page fallback)
```

`'unsafe-inline'` is for styles only. The export has an inline `expo-reset` style, and react-native-web injects styles at runtime. `img-src` allows `data:` for the QR PNG and nothing remote. `form-action` is set because `default-src` does not cover it. Async route bundles are on for web (`asyncRoutes: { web: true }` in `app.config.ts`, the SDK 58 default made explicit). Re-checked on 2026-11-04 against the production export: the web loader adds each route chunk with a `<script src>`, which `script-src 'self'` allows, and the entry bundle's two `eval` sites run only when `window` is undefined. Re-check the policy after any Expo upgrade. `scripts/check-web-export.mts` keeps the no-inline-script property true.

The GIS script is loaded from `https://accounts.google.com/gsi/client` with no `integrity` attribute. Google replaces that file in place and does not publish a stable hash, so a subresource integrity pin would break sign-in on the next publish. The URL is a constant, and the CSP allows that script host only.

1. Web: no token enters JS-reachable storage. The session is httpOnly cookies on a same-site API. Native: the refresh token is in the Keychain or Keystore (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), the access token is in memory, and a leftover Keychain token is cleared on first launch after an install.
2. Native requests use `credentials: 'omit'`, so the OS cookie jar never becomes an ambient credential.
3. `Authorization` carries only the access token, only to `apiUrl`, built per send.
4. The client declares `platform` from its session kind and sends no custom headers.
5. A session ends locally only on 401 `session_ended`.
6. Web sign-out reports success only when the server cleared the cookies.
7. Magic link: fragment token, removed from the URL through the router, redeemed only by POST after a press, destination email confirmed first, custom-scheme deliveries dropped, never echoed into errors.
8. Google: ID token only, held for one POST, never stored. The Google SDK session is cleared right after.
9. Recovery codes and TOTP secrets are shown once, held in component state only, and never logged or persisted.
10. Responses are validated with zod. Unknown keys are stripped. Web schemas carry no token fields.
11. `z.config({ jitless: true })`: zod never probes `new Function`.
12. No telemetry. No logging of tokens, emails, or bodies. `console.error` only under `__DEV__`.
13. Protected routes are client-side only. The server authorizes every route.
14. Host the headers above at the CDN. Headers set through Metro apply only to `expo start`, and a `public/_headers` file does nothing on S3 plus CloudFront.
15. Web app and API are same-site (`app.example.com` and `api.example.com`, both https). `localhost` and `127.0.0.1` are different sites. WebKit caps cookies set by a CNAME-cloaked API host at 7 days, so point the API host at the load balancer with a flattened record.
16. `apple-app-site-association` is served as `application/json`.
17. Native magic links require the universal-link files in Wire it in.

## Changes from source

Ported:

- `extension/src/lib/apiClient.js` typed errors, shared refresh promise, headers per send, and 401 then retry, into `src/api/client.ts`.
- `extension/src/lib/auth.js` refresh-first write, end or throw, and sign-out clearing, into `client.ts` and `tokens.ts`.
- `client/services/api.js` timeouts and 5xx sanitizing, into `client.ts`.
- `client/services/tokenStore.js` web stores nothing, native SecureStore, write errors propagate, clear never fails, and the same-site notes, into `tokens.ts`, `ui.tsx`, and this file.
- `client/store/authSlice.js` anonymous probe is not a sign-out, and native local teardown first, into `auth.ts` and `client.ts`.
- `client/app/_layout.jsx` restore, splash, and the root error boundary, into `app/_layout.tsx`.
- `client/app/(app)/_layout.jsx` and `client/app/(auth)/_layout.jsx` declarative redirects, into `Stack.Protected` and `Redirect`.
- `client/utils/navHistory.js` URL rewrite through the router's own state, into `router.setParams({ '#': undefined })`.
- `client/utils/gisClient.js` cached loader and reset on failure, into `GoogleButton.web.tsx`.
- `client/hooks/useMagicLink.js` request and trim, into `auth.requestMagicLink`.
- `client/services/adminMfa.js`, `adminMfaGate.js`, and `AdminMfaModal.jsx` TOTP prompt, enrollment, copy, busy guard, and `openURL`.
- `client/constants/webGlobalCss.js` 16 px inputs, into `Field`.
- `client/metro.config.js` headers belong to the CDN, into Security above.
- `client/.env.example` into `.env.example`.

- Fixed: stale bearer on retry and on queued retries (`client/services/api.js:130`, `client/services/api.js:161`). Pinned by `test/api/client.test.ts` > "retries a 401 with the refreshed access token, not the one it first sent"; `test/api/client.test.ts` > "requests waiting on an in-flight refresh retry with the new token".
- Fixed: logout on any refresh failure, including network errors (`client/services/api.js:162-169`). Pinned by `test/api/client.test.ts` > "ends the session only on 401 session_ended".
- Fixed: web sign-out claiming success while the cookies stay valid (`client/store/authSlice.js:209-218`). Pinned by `test/auth/auth.test.ts` > "web sign-out that fails on the network keeps the user signed in and reports the failure".
- Fixed: magic link auto-redeemed on GET (`client/app/auth/verify.jsx:55-83`, `client/hooks/useMagicLink.js:82-88`). Pinned by `test/app/magic.test.native.tsx` > "does not redeem on mount; shows the destination email; redeems once on press".
- Fixed: account existence revealed to the requester (`client/hooks/useMagicLink.js:49-50`); expired-link response echoing the email (`client/hooks/useMagicLink.js:118`, `client/app/auth/verify.jsx:85-92`). Pinned by `test/app/sign-in.test.native.tsx` > "shows the same confirmation whatever the server says about the account"; `test/app/magic.test.native.tsx` > "the expired-link message does not show the email".
- Fixed: SecureStore read error treated as no token (`client/services/tokenStore.js:79-83`). Pinned by `test/auth/tokens.test.ts` > "a SecureStore read error rejects as storage and never deletes the token".
- Fixed: native requests sharing the OS cookie jar (`client/services/api.js:19-23`). Pinned by `test/api/client.test.ts` > "bearer session sends credentials omit; cookie session sends include".
- Fixed: native refresh token surviving app deletion on iOS (`client/services/tokenStore.js:8-19`). Pinned by `test/auth/tokens.test.ts` > "first launch after install clears a leftover refresh token".
- Fixed: single-flight only within one tab on web. Pinned by `test/api/client.test.web.ts` > "cookie session runs refresh and logout inside navigator.locks when available".

Dropped:

- axios and interceptors. `fetch` replaces them. Interceptor config reuse caused the stale-bearer bug.
- Payment-issue toast, admin step-up replay, and the network-error toast latch. Callers handle `ApiError.kind`.
- Safari refresh-token-in-body fallback. Web holds no token to send.
- Access-token expiry tracking with a 30 second early-expiry skew. A 401 then one retry is enough.
- `react-native-qrcode-svg` and `react-native-svg`. The server returns a PNG data URL.
- Redux, page caches, and PostHog. Products subscribe to the auth store to clear their own caches.
- Google code flow, offline access, consent prompts, and referral payloads. The ID-token flow needs none of them.
- `metro.config.js` and `babel.config.js` customizations. SDK 58 does not need them for this code.
- Legacy AsyncStorage purge, `bypassAuthGate`, and marketing-route boot code.
- The reload-loop guard. One guarded "Go to start" covers it.
- Blur-before-navigation. Navigation here is guard-driven. The skipped fix is a console warning, not a broken flow.

## Known gaps

- No return to the route the user wanted after sign-in.
- No Expo Go for native Google. Use a dev build.
- No TOTP disable, device list, or logout-all screens. Those routes exist in `backend/auth`.
- Other tabs learn of a sign-out at their next request.
- A refresh whose response is lost, followed by more than 60 s before the next attempt, ends the session through reuse detection. The committed auth module rotates again while `now` is within `GRACE_SECONDS` (60) of `lastUsedAt`, and revokes after that.
- Email click tracking can strip the link fragment, so the email module must disable it for magic links.
- Android sign-in uses Google's deprecated legacy SDK (16.1.5 free edition) with no announced removal date.

## Recorded choices

- C-L1, `endsSession` in `src/api/client.ts`: return `status === 401 && code === 'session_ended'`. Anything else keeps the session. Pinned by `test/api/client.test.ts` > "ends the session only on 401 session_ended".
- C-L2, `restoreFailed` in `src/auth/auth.ts`: return `{ status: 'unreachable', error }`. The unreachable screen has Retry. Native also offers Sign in again.
- C-L3, `onFirstLaunch` in `src/auth/tokens.ts`: when `marker.exists()` is false, delete `kit.refreshToken` with the same keychain options, then `marker.create()`. When the marker exists, do nothing. Pinned by `test/auth/tokens.test.ts` > "first launch after install clears a leftover refresh token".
- Marker-write failure: if `marker.create()` throws after that delete, do not write the token back and do not swallow the error. `getRefresh` maps that rejection to `ApiError` kind `storage` and does not delete a second time. Pinned by `test/auth/tokens.test.ts` > "an install marker that cannot be written at first launch".

## Local changes

- App identity renamed to Townwise as `## Wire it in` directs: `name` `Townwise`, `slug` `townwise`, `scheme` `townwise`, iOS `bundleIdentifier` and Android `package` `tech.townwise.app` (`app.config.ts`). No security control changed; no pinning test needed.
- Public route group and auth gate. The root layout renders `AuthProvider` and `RootStack` with two groups. `app/(gate)/_layout.tsx` (`AuthGate`) holds the former root navigator unchanged: the same three `Stack.Protected` guards, `redirectTo` from `routeFor`, and the unguarded `auth/magic`. `app/(marketing)/` holds the public pages `/`, `/about`, `/privacy`, `/terms`, and `/security`; they read no auth state, never restore, and make no API request. The server still authorizes every route. Pinned by `test/app/routing.test.web.tsx` > "/ renders the marketing page without restoring while %s" and "/sign-in still waits for restore", and `test/app/routing.test.native.tsx` > "a signed-out deep link to /settings/security lands on /sign-in".
- Route moves. The signed-in home moved from `/` to `/dashboard`, and TOTP settings from `/security` to `/settings/security`. `/sign-in`, `/totp`, and `/auth/magic` keep their URLs, so the magic-link URL and the Android intent filter are unchanged. On native, `/` redirects to `/dashboard` (`src/marketing/Home.tsx`) and the guards pick the screen. `routeFor` returns `'/dashboard'` for `signedIn`. Pinned by `test/auth/store.test.ts` > "routeFor for every status" and `test/app/routing.test.native.tsx` > "/ signed out lands on /sign-in", "mfaRequired on / lands on /totp", and "/ signed in lands on /dashboard, which links to /settings/security".
- Restore once per auth object (`src/auth/restoreOnce.ts`). The gate calls it on mount, so moving between public pages and the gate never restores twice. Retry still calls `auth.restore()`. Pinned by `test/auth/restoreOnce.test.ts` and `test/app/routing.test.native.tsx` > "restore runs once across moves between public pages and the gate" and "unreachable offers Retry and Sign in again".
- Native splash. The gate renders `Loading` while restoring on every platform (it rendered `null` on native). `+not-found` and the native `MarketingShell` hide the splash on mount; nothing on the `/` redirect path does. Pinned by `test/app/routing.test.native.tsx` > "a cold start at / keeps the splash up until restore settles", "a cold start at /privacy hides the splash without restoring; Back shows Loading while the gate restores", and "an unknown path hides the splash; Go to home shows Loading while the gate restores".
- Web-only code stays out of the native bundle: no platform-suffixed file under `app/`, and only `.web` files import a module by its `.web` name. Pinned by `test/marketing/boundary.test.ts`.
- Google-only sign-in and the app theme. `app/(gate)/sign-in.tsx` shows one Continue with Google button (on web the Google Identity Services button with `text: 'continue_with'`), the line "By continuing, you agree to the Terms and the Privacy Policy" with links to `/terms` and `/privacy`, the wordmark linking to `/` on web, and Request early access. The magic-link request form is gone from the UI; `auth.requestMagicLink`, the `/auth/magic` route and redemption are unchanged. There is no sign-up page: the server creates the account on the first Google sign-in from a Gmail or Google Workspace address. The layout is `src/auth/SignInFrame`: one column on native, and on web the marketing header and footer around it with a Privacy, Terms and Security row. The server's Google refusals (`google_email_not_authoritative`, `google_email_unverified`, `email_linked_to_other_google_account`, `google_email_conflict`, `origin_not_allowed`, `google_unavailable`, and 404 when Google is off) show the sign-in mockup's message for each; every other error keeps its mapping. While the token is checked, a disabled "Signing you in…" replaces the button. On iOS without an iOS client ID the screen says sign-in is off. An error `Message` has the alert role and an assertive live region, and iOS announces it. `src/ui.tsx` styles every app screen from `src/theme.ts`. No security control changed. Pinned by `test/app/sign-in.test.native.tsx` > "one Continue with Google button, links to the terms and privacy pages, and no email field", "a %i %s refusal says why, as an alert", "while the server checks the Google token, the button gives way to a disabled Signing you in" and "on iOS without an iOS client ID, says sign-in is off instead of showing nothing"; `test/app/sign-in.test.web.tsx` > "one Continue with Google button, links to the terms and privacy pages, and no email field" and "sign-in sits in the site header and footer, with the legal links and its own title"; and `test/ui.test.native.tsx`.
- Sign-in links to `/privacy` and `/terms`, and the public `/security` page links to `/settings/security` as "Two-factor settings". Pinned by `test/app/routing.test.native.tsx` > "sign-in links to /privacy and /terms, and Back returns to /sign-in" and `test/app/routing.test.web.tsx` > "the public /security page links to /settings/security".
- Async routes explicit for web (`app.config.ts`); see the re-check in `## Security`. Config only, no pinning test; the browser CSP check is manual.
- Web template `public/index.html`: title, description and Open Graph tags, and the `expo-reset` style unchanged except for the ground color on `html` and `body`, so the page is dark before the bundles run. Instrument Sans and Geist Mono are self-hosted as latin WOFF2 files in `public/fonts/` (SIL Open Font License, the license texts beside them), declared with `@font-face` and `font-display: swap` in a second inline `<style>`, with the sans face preloaded. No header change: the fonts are same-origin (`font-src 'self'`), the inline styles use the existing `style-src 'unsafe-inline'`, and there is no inline script. Pinned by `test/public/index-html.test.ts` and `scripts/check-web-export.mts`.
- Marketing chrome and text pages. On web, `src/marketing/MarketingShell.web.tsx` puts every public page inside one scroll container with a skip link, the header (wordmark, the four homepage section links, Sign in, Request early access) and `Footer.web.tsx`. Their CSS (`src/marketing/styles.web.ts`, values from `src/theme.ts`) is one React-rendered `<style>`, covered by the existing `style-src 'unsafe-inline'`; the pages fetch nothing and load no script, so no header changes. Links are plain anchors: internal ones are routed client-side, and section links (`/#how`, `#cookies`) scroll without animating. `mailto:` links go to the browser. Each page sets its document title through `expo-router/head` (applied after JavaScript loads, by the focused screen only); the root stack's default "Townwise" covers the app screens, so no page's title outlives it. The four text pages are universal route files written once with `src/marketing/html`: DOM elements on web, plain Text and View on native, which imports no `.web` module. Pinned by `test/marketing/links.test.ts`, `test/marketing/pages.test.web.tsx`, `test/marketing/footer.test.web.tsx`, `test/marketing/pages.test.native.tsx` and `test/marketing/boundary.test.ts`.
- Homepage map, web only: `src/marketing/map/NortheastMap.web.tsx` with `TownPanel.web.tsx`, `mapState.ts` and `mapStyles.web.ts`, imported by `src/marketing/Home.web.tsx` alone, so it ships only in the `/` route chunk. It draws the bundled public data (BLS QCEW county employment and the Census and us-atlas geometry in `src/marketing/map/`) as inline SVG, fetches nothing and loads no script; its source links are plain `https:` anchors. Its CSS is a second React-rendered `<style>`, covered by the existing `style-src 'unsafe-inline'`, so no header changes. The town list is the keyboard control (markers are `aria-hidden` with `tabindex="-1"`), and Escape is handled on the map's own element, with no `document` or `window` listener. Pinned by `test/marketing/map.test.web.tsx` and `test/marketing/boundary.test.ts`.
- Homepage, web only: `src/marketing/Home.web.tsx` (with `HowItWorks.web.tsx`) renders the eyebrow, the title, the sub, Request early access and Sign in, and the status line above the map, then the sections in the mockup's order. Its CSS (`homeStyles.web.ts`) is a third React-rendered `<style>`, kept in the `/` route chunk like the map's rather than in the shared chunk every route loads; it is covered by the existing `style-src 'unsafe-inline'`, so no header changes. The page fetches nothing and loads no script. Sections reveal once through an IntersectionObserver rooted at the page's scroll container (`ScrollRoot` in `MarketingShell.web.tsx`); without an observer nothing is hidden, and focus inside a section shows it at once. From 1024px with an observer, How it works pins one decorative stage (`aria-hidden`, nothing focusable) beside the steps with `position: sticky`; a center-band observer on the same root picks the active step, with no scroll or wheel listener. Its illustration parts carry a stagger index in a `style` attribute, also covered by `style-src 'unsafe-inline'`. Pinned by `test/marketing/home.test.web.tsx`, `test/marketing/how.test.web.tsx` and `test/marketing/pages.test.web.tsx`.
- Geometry and data modules, generated and bundled (`src/marketing/map/countyData.ts`, `geometry.ts`, `towns.ts`, with `camera.ts` and `src/marketing/format.ts`). `countyData.ts` is the BLS QCEW county restaurant and bar employment index (2024), `geometry.ts` the pre-projected Census and us-atlas outlines (56 KiB budget), and `towns.ts` the 12 fixed towns with their dated drivers and source URLs. The generated files say "do not edit by hand"; the generator is scratchpad tooling and is not in the repo. Every value is public and sourced, with no partner data. They are imported by the web homepage only and fetch nothing, so no header changes. Pinned by `test/marketing/countyData.test.ts`, `test/marketing/geometry.test.ts`, `test/marketing/towns.test.ts`, `test/marketing/camera.test.ts` and `test/marketing/format.test.ts`.

## Launch blockers

Do not announce or deploy the public site until these are settled.

- The `hello@townwise.tech` mailbox does not exist; the domain has no MX records. The early-access, contact and legal mail links (`src/marketing/links.ts`, the footer, and the privacy and terms pages) all point to it, so mail sent now bounces.
- The legal pages still show their bracketed `[DECISION NEEDED]` placeholders (`app/(marketing)/privacy.tsx`, `terms.tsx`, `security.tsx`, `about.tsx`, and the homepage FAQ and how-it-works copy). Each needs a decision or a lawyer's review, and the visible placeholders removed.
- Hosting is not chosen (the footer and the security page say so). Pick it, then update the security page's hosting section.
- The host must set the CSP and the other headers in `## Security`, with the single-page fallback. Headers set through Metro apply only to `expo start`, and a `public/_headers` file does nothing on S3 plus CloudFront. After the first deploy, load `/`, `/sign-in` and one other route in a browser and confirm there are no CSP violations (fonts, route chunks, Google sign-in).
