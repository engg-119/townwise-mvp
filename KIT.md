- backend/auth @ d43185ab6ced93ff5265db42983da5cb2086fc0d, copied to `api/kit/auth`
- backend/mongo @ d43185ab6ced93ff5265db42983da5cb2086fc0d, copied to `api/kit/mongo`
- backend/rate-limit @ d43185ab6ced93ff5265db42983da5cb2086fc0d, copied to `api/kit/rate-limit`
- backend/redis @ d43185ab6ced93ff5265db42983da5cb2086fc0d, copied to `api/kit/redis`
- backend/server-core @ d43185ab6ced93ff5265db42983da5cb2086fc0d, copied to `api/kit/server-core`
- mobile/expo-shell @ e6460b6dec7c3ae6b63acb00538cf8fc28f120e1, copied to `client/` (moved 2026-11-04 so the frontend lives in `client/`; apply kit updates for `mobile/expo-shell` there)

Kit updates for the five `backend/*` modules apply in `api/kit/<name>`. Only paths changed: each module's `tsconfig.json` `extends` gained one `../` (now `../../../tsconfig.base.json`).
