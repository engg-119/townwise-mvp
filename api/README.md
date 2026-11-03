# api

Townwise backend: one Node process (`src/main.ts`) composed from the kit modules in `../backend/` (copied from camkeith/modules; versions in `../KIT.md`). Sign-in is Google only.

## Run locally

Needs Node 24 (`nvm use` reads `.nvmrc`) and Docker. From the repo root:

```sh
nvm use
npm install
docker compose up -d    # Mongo on 27017, Valkey (Redis) on 6379; stop a local mongod first if 27017 is taken
grep -v -E '^AUTH_(JWT|ENCRYPTION)_KEYS=' api/.env.example > api/.env.local
printf 'AUTH_JWT_KEYS=k1:%s\nAUTH_ENCRYPTION_KEYS=e1:%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" >> api/.env.local
npm run dev -w @townwise/api
curl localhost:8080/healthz
```

`api/.env.local` is gitignored and holds throwaway local keys. Never commit it or paste its values.

Google sign-in needs an OAuth web client (Google Cloud console, APIs & Services, Credentials, OAuth client ID, type Web) with `http://localhost:8081` as an authorized JavaScript origin. Put its client ID in `AUTH_GOOGLE_CLIENT_IDS`. Without it, `/auth/google` answers 404.

## Check

`npm run verify` from the repo root runs `npm ls`, lint, typecheck and every kit module's unit and integration tests (Docker required).

## Kit modules

The code under `../backend/` is ours to own. Record any change under `## Local changes` in that module's `MODULE.md` with the test that pins it. To take a kit fix: in a camkeith/modules clone, `git diff <commit in KIT.md> <new commit> -- backend/<name>`, apply it here, run `npm run verify`, and update the line in `KIT.md`.
