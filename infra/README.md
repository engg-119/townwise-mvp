# Townwise infrastructure (Azure)

Everything runs in the Azure Sponsorship subscription `2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999` (tenant `37acb94f-e2d9-41d9-a697-1bd7a1d60bf1`), region `eastus`, in two resource groups, `rg-townwise-bootstrap` and `rg-townwise-prod`, plus `rg-townwise-prod-infra`, which the Container Apps platform manages. The existing `Dartmouth` and `cameronkeith` groups are unrelated and never touched. This infrastructure is Townwise-specific code; the camkeith/modules kit is AWS-only.

- **API:** Azure Container Apps, a workload-profiles environment with the Consumption profile only, in the virtual network `vnet-townwise`. 1 to 2 replicas, health probes on `/healthz`. Valkey runs as a TLS-only sidecar on `127.0.0.1`: an init container generates a per-replica CA, and the API trusts it through `NODE_EXTRA_CA_CERTS`, so the kit's `rediss:` rule holds. The image comes from a private Azure Container Registry, pulled with the app's managed identity. Secrets are Key Vault references. Custom domain `api.townwise.tech` with a managed certificate.
- **Database:** Azure DocumentDB (vCore; formerly Cosmos DB for MongoDB vCore), free tier, `docdb-townwise-2d2c15bf`. Public network access is disabled and there are no firewall rules: the only way in is a private endpoint in `snet-endpoints`, whose NSG admits port 10260 from the apps subnet only. The API connects as `townwise-app`, not as the administrator.
- **Backups:** a nightly Container Apps job dumps the database with `mongodump` as the read-only user `townwise-backup` and uploads the archive to Blob Storage, where it is write-once for 30 days and deleted on day 31. An alert emails when a day passes without a successful upload. A manual job restores a named dump.
- **Client files:** the exports restaurants drop into Townwise, in `sttwfiles2d2c15bf` (containers `client-raw` and `client-clean`, blob names `{orgId}/{locationId}/{fileId}`, ids only). Public network access is disabled: the only way in is a private endpoint in `snet-endpoints`, whose NSG admits 443 from the apps subnet only. The API reads and writes with its managed identity through a custom role on the two containers that cannot mint a SAS. Every blob read, write and delete is logged to the audit account for a year. Off in the API until step 18.
- **Web:** Static Web Apps (Free) serving the Expo web export. `infra/web/staticwebapp.config.json` sets the headers from `client/MODULE.md` and the `/index.html` fallback. Domains `townwise.tech` and `www`.
- **DNS:** Azure DNS for `townwise.tech`.
- **Email:** Azure Communication Services, from `no-reply@townwise.tech`, sent with the app's managed identity. Access keys are disabled. DMARC is `p=reject`.
- **CI:** GitHub Actions reaches Azure only through an OIDC federated credential on a managed identity, for `deploy.yml` on `main` only. No CI identity is an app registration, and there is no client secret.
- **Lab callback audience:** one app registration, `townwise-lab-callback` (`terraform/bootstrap/lab.tf`), is the audience the forecast lab job's managed identity signs in to the API with (step 20). It holds no secret, certificate or federated credential, no app role and no permission.

| Stack | Applied by | Holds |
|---|---|---|
| `terraform/bootstrap` | you (subscription Owner) | both resource groups, Terraform state account, the $60 budget, the GitHub deploy identity, Entra groups and their RBAC, the lab callback app registration |
| `terraform/production` | `townwise-admins` | network, Container Apps and jobs, DocumentDB and its private endpoint, backup storage, client file storage and its private endpoint, registry, Key Vault, Log Analytics and alerts, Static Web App, DNS, Communication Services, deploy-identity roles |

State lives in `sttwtfstate2d2c15bf` with Entra ID auth only (shared keys off) and blob-lease locking. Bootstrap state, which names the groups and the applier, sits in container `tfstate-admin`; production state sits in `tfstate`, so a future read-only plan identity can be given `tfstate` alone. Terraform never holds a secret value: the one secret it writes (the database admin password) goes through write-only arguments, and no connection string is read into state.

## Runbook

You need the Azure CLI, Terraform 1.14.4, Node 24 (`nvm use`), `npm ci` done, and Docker for local builds. Start with:

```sh
az login --tenant 37acb94f-e2d9-41d9-a697-1bd7a1d60bf1
az account set --subscription 2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999
```

### 1. Bootstrap (local state, then migrated)

```sh
cd "$(git rev-parse --show-toplevel)/infra/terraform/bootstrap"
printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf      # gitignored
printf 'budget_email = "<alert email>"\n' > terraform.tfvars                  # gitignored
terraform init && terraform apply
rm backend_override.tf
terraform init -migrate-state          # answer yes; RBAC can take a few minutes to reach the state account
```

Delete the local `terraform.tfstate*` files once `terraform plan` shows no changes. The apply registers the resource providers production needs and adds you to `townwise-admins`.

### 2. Secrets access

The next apply writes the database admin password into Key Vault, which needs Key Vault Secrets Officer. Add yourself to `townwise-secrets-admins`, then sign out and back in so both group memberships reach your token:

```sh
az ad group member add --group townwise-secrets-admins --member-id "$(az ad signed-in-user show --query id -o tsv)"
az logout && az login --tenant 37acb94f-e2d9-41d9-a697-1bd7a1d60bf1
```

### 3. Production, part one: zone, registry, vault, network and database

One apply, so the admin password reaches Key Vault and the cluster in the same run:

```sh
cd "$(git rev-parse --show-toplevel)/infra/terraform/production"
printf 'alert_email = "<alert email>"\n' > terraform.tfvars                   # gitignored
terraform init
terraform apply -target=azurerm_dns_zone.main -target=azurerm_container_registry.main \
  -target=azurerm_private_endpoint.docdb -target=azurerm_private_dns_zone_virtual_network_link.docdb
```

If the apply fails with a 403 on the Key Vault secret, RBAC has not reached the new vault yet: wait a few minutes and run it again.

**Check the free tier accepted private-only access.** Microsoft documents private endpoints for DocumentDB and lists no free-tier exclusion, but does not confirm free tier plus private endpoint, and does not say whether a Sponsorship subscription may hold the free tier.

```sh
az resource show --ids "$(terraform output -raw db_cluster_id)" \
  --query '{tier:properties.compute.tier, publicNetworkAccess:properties.publicNetworkAccess, status:properties.clusterStatus}' -o table
az network private-endpoint show -g rg-townwise-prod -n pe-townwise-docdb \
  --query 'privateLinkServiceConnections[0].privateLinkServiceConnectionState.status' -o tsv
```

Expect `Free`, `Disabled`, `Ready` and `Approved`. **If the cluster or the endpoint is refused because of the tier**, switch to the cheapest paid tier and apply the same command again. Free upgrades to M10 in place and keeps the connection string and network rules; M10 cannot go back to free.

```sh
printf 'db_tier = "M10"\n' >> terraform.tfvars
# Only if the cluster itself was refused: Key Vault already holds a password that the next run would not
# resend, so rotate it in the same apply.
printf 'db_admin_password_version = 2\n' >> terraform.tfvars
```

M10 adds about $17.60 a month (about $67 in total); raise the budget in `bootstrap/budget.tf` to match.

### 4. Name servers at InterNetX

```sh
az network dns zone show -g rg-townwise-prod -n townwise.tech --query nameServers -o tsv
```

Replace `ns1-4.dns.host` with the four Azure name servers. Wait until `dig +short NS townwise.tech @1.1.1.1` returns the `azure-dns` names. Static Web Apps, the API's managed certificate and the email domain all validate through DNS.

### 5. Seed the secrets

`infra/scripts/set-secret.sh` reads a value from a hidden prompt, or one piped line, and hands it to `az` on stdin. The value never appears in argv, history or output. `printf` is a shell builtin, so the generated passwords below never reach a process's argv either.

```sh
cd "$(git rev-parse --show-toplevel)"
V=kv-townwise-2d2c15bf
printf 'k1:%s' "$(openssl rand -base64 32)" | infra/scripts/set-secret.sh "$V" auth-jwt-keys
printf 'e1:%s' "$(openssl rand -base64 32)" | infra/scripts/set-secret.sh "$V" auth-encryption-keys

# The database users' connection strings. The cluster host comes from its connection string, which ARM
# returns with <user> and <password> placeholders. Options from Microsoft's Node.js quickstart; DocumentDB
# does not support retryable writes. The db-users job (step 7) creates the users from these strings.
host="$(az resource show --ids "$(terraform -chdir=infra/terraform/production output -raw db_cluster_id)" \
  --query properties.connectionString -o tsv | sed -E 's#^mongodb\+srv://[^@]*@##; s#[/?].*$##')"
: "${host:?no cluster host: stop, do not write a URI without one}"
O='tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000'
pw() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40; }
printf 'mongodb+srv://townwise-app:%s@%s/townwise?%s' "$(pw)" "$host" "$O" | infra/scripts/set-secret.sh "$V" mongodb-uri
printf 'mongodb+srv://townwise-backup:%s@%s/townwise?%s' "$(pw)" "$host" "$O" | infra/scripts/set-secret.sh "$V" mongodb-backup-uri
printf 'none' | infra/scripts/set-secret.sh "$V" mongodb-restore-uri     # no restore user until a restore (step 14)
```

**Rotation.** JWT and encryption rings: run the same command, then `az containerapp revision restart`; key order is in `api/kit/auth/MODULE.md`. Database users: write a new `mongodb-uri` or `mongodb-backup-uri` as above (same user name, new password), run the db-users job (step 7), then restart the API revision; between the job and the restart, new pool connections fail, so do it at a quiet time. Admin password: bump `db_admin_password_version` and apply. Container Apps picks up new secret versions within about 30 minutes on its own; a job started sooner can still see the old value, so wait, or check what the db-users job reports.

### 6. Images

Import the pinned Valkey and MongoDB images (Docker Hub rate limits make pulling directly from Container Apps unreliable), and build the first API image in Azure:

```sh
R=crtownwise2d2c15bf
az acr import --name $R --source docker.io/valkey/valkey@sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507 --image valkey/valkey:8.1.10-alpine
az acr import --name $R --source docker.io/library/mongo@sha256:d0d926f94df099bff534b7ee5b5986458131a22489dfff8664509af0c1e2ca9c --image mongo:8.0.32
az acr build --registry $R --image townwise-api:initial --file api/Dockerfile --platform linux/amd64 .
printf 'api_image = "%s.azurecr.io/townwise-api@%s"\n' $R "$(az acr repository show --name $R --image townwise-api:initial --query digest -o tsv)" \
  >> infra/terraform/production/terraform.tfvars
```

If ACR Tasks is unavailable on the subscription, build and push from a laptop instead:

```sh
az acr login --name $R
docker buildx build --platform linux/amd64 -f api/Dockerfile -t $R.azurecr.io/townwise-api:initial --push .
```

### 7. Database users

The API's first boot needs its user, so create the users before the full apply. The job signs in as the built-in administrator and creates, or sets the password of, the two users named in the step 5 strings. It prints user names only.

```sh
cd "$(git rev-parse --show-toplevel)/infra/terraform/production"
terraform apply -target=azapi_resource.job_db_users      # creates the environment too (about 10 minutes)
az containerapp job start -n caj-townwise-db-users -g rg-townwise-prod
az containerapp job execution list -n caj-townwise-db-users -g rg-townwise-prod --query '[0].properties.status' -o tsv
```

Wait for `Succeeded`. Logs are in Log Analytics (`ContainerAppConsoleLogs`) or the portal's execution history. Any failure prints only an error name and code, never a URI.

This is the only job that reads `db-admin-password`, and its identity, `id-townwise-job-db-users`, is not available inside the container at all (`identitySettings` lifecycle `None`: image pull and Key Vault references only).

**Least privilege, as far as DocumentDB allows.** Native users take cluster-level roles only (https://learn.microsoft.com/azure/documentdb/secondary-users): `readAnyDatabase`, or `readWriteAnyDatabase` together with `clusterAdmin`. A `readWrite` role on one database is rejected (`RoleNotFound`; checked on `documentdb-local`). So `townwise-app` gets `readWriteAnyDatabase` plus `clusterAdmin`, and `townwise-backup` gets `readAnyDatabase`. Their reach is still Townwise data only, because the cluster holds nothing else. None of them can manage users; only the administrator, whose password only the db-users job reads, can. A third user, `townwise-restore`, exists only during a restore (step 14). Entra ID auth, which would allow managed identities instead of passwords, is not available on the free tier.

### 8. Production, full apply

```sh
terraform apply
az containerapp hostname list -n ca-townwise-api -g rg-townwise-prod -o table
```

The apply creates the Container App, its custom domain and managed certificate, the backup and restore jobs, the Static Web App and its domains, and every DNS record. On first boot the API connects as `townwise-app` and builds its indexes. If `api.townwise.tech` shows binding `Disabled` after about 15 minutes, bind the managed certificate:

```sh
az containerapp hostname bind --hostname api.townwise.tech -n ca-townwise-api -g rg-townwise-prod \
  --environment cae-townwise --validation-method HTTP
```

### 9. Email domain

Once DNS has propagated, verify the domain in Communication Services. The CLI needs the `communication` extension, on your machine only.

```sh
az extension add --name communication
for t in Domain SPF DKIM DKIM2; do
  az communication email domain initiate-verification -g rg-townwise-prod --email-service-name acse-townwise-2d2c15bf \
    --domain-name townwise.tech --verification-type $t
done
az communication email domain show -g rg-townwise-prod --email-service-name acse-townwise-2d2c15bf --domain-name townwise.tech --query verificationStates
```

When all four states show `Verified`, add `acs_domain_verified = true` to `terraform.tfvars` and apply. This links the domain to the Communication Services resource. The sender is `no-reply@townwise.tech`.

DMARC is `v=DMARC1; p=reject; sp=reject; adkim=s;` from the start. Only Communication Services sends as `townwise.tech`, and it DKIM-signs with the two selector keys. **Before adding any other sender** (a newsletter tool, a help desk), make it DKIM-sign as `townwise.tech` with an aligned key, or its mail is rejected. Inbound mail is out of scope.

**Turning on the API's emails.** The API sends two emails (`api/README.md`, Email): request received, and you're in. It sends them with its managed identity, which already holds the `Townwise email sender` role on this resource, so no Terraform change is needed. Email stays off while `EMAIL_ENDPOINT` is unset in `api/production.env`. Turn it on only in the release whose waiting, request and approval screens say that Townwise emails, together with the privacy page's Email section.

1. **Set it.** Done in the 2026-11-09 release, with the new screens and privacy page: `api/production.env` sets `EMAIL_ENDPOINT=https://acs-townwise-2d2c15bf.unitedstates.communication.azure.com` (from `terraform output -raw communication_service_endpoint` in `infra/terraform/production`) and `EMAIL_SENDER=no-reply@townwise.tech`. It takes effect when that release merges to `main` and the deploy starts a new revision; then run steps 2 and 3.
2. **Smoke send.** From a Google account the team owns (a Gmail address), send an access request, then approve it from the console. Each email should arrive within a minute. In Gmail's "Show original", check SPF pass, DKIM pass with `d=townwise.tech`, DMARC pass, the Reply-To header, and that no link was rewritten. Look at both emails in Gmail on the web (light and dark), Gmail on iOS, Apple Mail (dark) and Outlook on the web.
3. **Logs.** `ContainerAppConsoleLogs | where Log has "townwise.email_"` shows one `townwise.email_sent` per email, with ids only and no address. A `townwise.email_failed` with code `upstream_status` and status 401 or 403 points at the token resource (`https://communication.azure.com`, `api/src/mail/acs.ts`) or the role assignment; code `token` means the identity endpoint refused.

**Turn it off** by commenting out the two lines again and deploying. A failed send is never retried, so an email lost while it was failing is not sent later.

### 10. Real-cluster smoke test

Run it after step 8, and **again after the kit's duplicate-key fix for DocumentDB lands** (it is being made on its own branch; deploy it first, because the test runs the deployed API image). Locally, five auth integration tests fail on `documentdb-local` until that fix: DocumentDB's duplicate-key errors carry no `keyPattern` or `keyValue`, so the kit cannot name the field, and the Google email conflict and concurrent first sign-in paths answer 500.

1. **Connect and indexes.** `curl -s https://api.townwise.tech/healthz` returns `{"status":"ok"}`. On first boot the console log has 9 `mongo.index_built` lines and no `IndexError`. A restart builds none.
2. **Sign-in edge cases, on the real cluster.** `infra/scripts/db-smoke.sh` runs `infra/smoke/db-smoke.js` once inside the network as an execution of its own job, `caj-townwise-db-smoke`, in the deployed API image (the live kit code), as the application user, in a scratch database `townwise_smoke` that it drops. Its identity reads only `mongodb-uri` and is not available inside the container. It checks the store results the HTTP behavior rests on: a duplicate email and a taken Google subject raise `DuplicateError` with the right field; an email conflict on update raises `DuplicateError('email')`, which `google.ts` turns into **409 `google_email_conflict`**; and **two concurrent first sign-ins** create one user while the other gets `DuplicateError`, which the sign-in flow resolves by re-reading. Expect `db smoke test passed` in the execution's console log. Before the kit fix, the four duplicate checks fail; against MongoDB they pass. The 409 itself cannot be produced against production, because it needs a Google account whose email changes to another user's.

   ```sh
   infra/scripts/db-smoke.sh
   az containerapp job execution list -n caj-townwise-db-smoke -g rg-townwise-prod --query '[0].properties.status' -o tsv
   ```

3. **Dump and restore.** Run the backup now (`az containerapp job start -n caj-townwise-backup -g rg-townwise-prod`), wait for `Succeeded` and the `uploaded townwise-<time>.archive.gz` line, then follow the restore steps in step 14 with that dump name, beside the live data (`townwise_restore`), and end the restore there.

### 11. Google OAuth client IDs

In Google Cloud console, open APIs & Services, then Credentials:

- **Consent screen:** add `townwise.tech` as an authorized domain.
- **Web client:** origins `https://townwise.tech` and `https://www.townwise.tech`.
- **iOS client:** bundle `tech.townwise.app`.
- **Android client:** package `tech.townwise.app` plus the signing SHA-1.

Put `<web id>,<ios id>` in `AUTH_GOOGLE_CLIENT_IDS` in `api/production.env` (in a pull request), and the same IDs in the repository variables below.

In the same pull request, put the Google addresses of Townwise staff in `TOWNWISE_SUPERADMIN_EMAILS` (comma-separated). The API refuses to start in production while it is empty, so until this is set the new revision never becomes ready and the deploy workflow fails. Each staff account must then turn on two-step sign-in at `/settings/security` before the staff console opens.

### 12. GitHub (Free plan, private repository)

On GitHub Free a private repository has no environments, environment variables or secrets, deployment branch policies, or branch protection. Teammates keep Read access and send pull requests from forks; only the owner merges to `main`.

**Two-factor sign-in.** The organization owner must turn on two-factor authentication on their own account first; that account is the deploy gate. Then require it for everyone: organization settings, Authentication security, **Require two-factor authentication**. Members without 2FA are removed until they enable it.

**Forks.** The forking and fork pull request settings are currently **off**, so teammates cannot yet open pull requests from forks. In the `engg-119` organization settings:

- **Member privileges:** base permissions **Read**, and **Allow forking of private repositories** on.
- **Collaborators:** Read on `engg-119-mvp`. Only the owner has write or admin.
- **Actions, General, private repository fork pull requests:** **Run workflows from fork pull requests** on. **Send write tokens to workflows from fork pull requests** off. **Send secrets and variables to workflows from fork pull requests** off.

CI and Security run on those pull requests with read-only tokens. Nothing enforces them, so check them before merging. CI's `id-token-guard` parses every workflow and fails unless `jobs.deploy` in `deploy.yml` is the only job that can request an OIDC token; it is a check, not a gate.

**Bind the deploy credential to `deploy.yml` (server side).** By default the OIDC subject names only the repository and the ref, so any workflow pushed to `main` could get a deploy token. Customize the repository's subject to also carry `job_workflow_ref`, which for a job that is not a reusable-workflow call is the running workflow's own `owner/repo/.github/workflows/<file>@<ref>`. GitHub documents the endpoint (repository admin) with no plan or visibility restriction; `owner_id` and `repo_id` stay in the `repo` segment. Run this **before the first deploy**; bootstrap already expects it:

```sh
gh api -X PUT repos/engg-119/engg-119-mvp/actions/oidc/customization/sub \
  -F use_default=false -F use_immutable_subject=true \
  -f 'include_claim_keys[]=repo' -f 'include_claim_keys[]=context' -f 'include_claim_keys[]=job_workflow_ref'
gh api repos/engg-119/engg-119-mvp/actions/oidc/customization/sub      # check: use_default false, the three keys
```

The deploy credential's subject is then exactly `repo:engg-119@343069214/engg-119-mvp@1427161209:ref:refs/heads/main:job_workflow_ref:engg-119/engg-119-mvp/.github/workflows/deploy.yml@refs/heads/main`. If the first deploy's `azure/login` fails with `AADSTS700213`, the error shows the subject GitHub actually sent; compare it with `terraform -chdir=infra/terraform/bootstrap state show 'azurerm_federated_identity_credential.github["github-main"]'`. If GitHub refuses the PUT, set `github_bind_deploy_workflow = false` in the bootstrap `terraform.tfvars` and apply: the subject falls back to any workflow on `main`, and the guard is the only check on which workflow asks for a token. Neither control can tell jobs within `deploy.yml` apart; only the guard does that.

Invite Azure teammates as Entra B2B guests: Entra admin center, Users, Invite external user. Then add them to `townwise-developers`, and add only the people who rotate secrets to `townwise-secrets-admins`.

Repository variables (repository-level only):

```sh
R=engg-119/engg-119-mvp
B="$(git rev-parse --show-toplevel)/infra/terraform/bootstrap"
gh variable set AZURE_TENANT_ID -R $R --body 37acb94f-e2d9-41d9-a697-1bd7a1d60bf1
gh variable set AZURE_SUBSCRIPTION_ID -R $R --body 2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999
gh variable set AZURE_DEPLOY_CLIENT_ID -R $R --body "$(terraform -chdir="$B" output -raw deploy_client_id)"
gh variable set AZURE_RESOURCE_GROUP -R $R --body rg-townwise-prod
gh variable set AZURE_ACR_NAME -R $R --body crtownwise2d2c15bf
gh variable set AZURE_CONTAINER_APP -R $R --body ca-townwise-api
gh variable set AZURE_STATIC_WEB_APP -R $R --body swa-townwise
gh variable set EXPO_PUBLIC_API_URL -R $R --body https://api.townwise.tech
gh variable set EXPO_PUBLIC_WEB_URL -R $R --body https://townwise.tech
gh variable set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID -R $R --body "<web client id>"
gh variable set EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID -R $R --body "<ios client id>"
```

**The main-only deploy gate rests on only the owner having write access.** The deploy workflow runs only on `refs/heads/main`, and the deploy identity trusts exactly `repo:engg-119@343069214/engg-119-mvp@1427161209:ref:refs/heads/main`. Anyone given write access later can push to `main` and deploy, and a deploy can read production secrets, because it ships the code that runs with the app's identity. To add branch protection and required reviews, upgrade the organization to GitHub Team, or make the repository public.

There is no plan identity and no pull-request credential: until a plan job exists, nothing but `deploy.yml` on `main` can obtain an Azure token. When one is added, give it its own identity, a `...:pull_request` credential, Reader, and Storage Blob Data Reader on the `tfstate` container only, and plan with `-lock=false`.

### 13. First deploy, rollback, and the client-IP check

```sh
gh variable set DEPLOY_ENABLED -R engg-119/engg-119-mvp --body true
gh workflow run deploy.yml -R engg-119/engg-119-mvp --ref main && gh run watch -R engg-119/engg-119-mvp
curl -sI https://townwise.tech/sign-in | grep -i -E 'content-security|strict-transport|referrer|x-content-type|cross-origin-opener'
```

**How deploys work:**

- `build-web`, `build-api` and `build-lab` run the repository's code with no id-token. Each uploads one artifact with its SHA-256; `build-api` and `build-lab` also output the image ID.
- `deploy` is the only job with an id-token, and it runs no repository or npm code. It:
  1. checks the hashes, and that the web archive holds only plain files and directories, none outside its folder;
  2. pushes the API image, and the lab image `townwise-lab:<sha>`, to the registry (the log prints the lab digest);
  3. points the Container App at the image digest and waits for the revision, then, only when `LAB_ENABLED` is `true`, points the lab job at its digest and waits until the job reports it;
  4. fetches the Static Web Apps token, signs out of Azure, and uploads the web build with `docker run` of the Static Web Apps client image, pinned by digest. The container gets only the token and the web folder (read-only): no OIDC request variables, no Azure session, no docker socket;
  5. checks `https://api.townwise.tech/healthz`, printing only the status.

API logs never appear in the Actions log. Read them in Log Analytics (`townwise-developers` can), or with `az containerapp logs show -n ca-townwise-api -g rg-townwise-prod`.

**Client-IP check (after the first deploy).** The API trusts `X-Forwarded-For` only from the ingress proxy (`TRUST_PROXY`), so a spoofed header must change neither the logged IP nor the rate-limit key:

```sh
me="$(curl -s https://api.ipify.org)"
curl -s -o /dev/null -D - -H 'X-Forwarded-For: 203.0.113.7' https://api.townwise.tech/no-such-path | grep -i x-request-id
# In Log Analytics: ContainerAppConsoleLogs | where Log has "<x-request-id>"   -> req.ip must be $me, not 203.0.113.7
for i in $(seq 1 125); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.townwise.tech/auth/google \
    -H 'Content-Type: application/json' -H "X-Forwarded-For: 198.51.100.$i" -d '{"idToken":"x","platform":"native"}'
done | sort | uniq -c
```

Each request consumes `auth:ip` (120 a minute) before the token is checked. Expect some `429` near the end. If every response is a 4xx other than 429, the spoofed addresses were trusted: stop and fix `TRUST_PROXY` in `api/production.env`.

**Rollback** to a previous revision's image, in one command:

```sh
az containerapp update -n ca-townwise-api -g rg-townwise-prod --container-name api --image \
  "$(az containerapp revision show -n ca-townwise-api -g rg-townwise-prod --revision <previous revision> \
      --query "properties.template.containers[?name=='api'].image | [0]" -o tsv)"
```

List revisions with `az containerapp revision list -n ca-townwise-api -g rg-townwise-prod -o table`. The web app rolls back by re-running the deploy workflow on an earlier commit.

### 14. Backups and restore

- **Schedule.** `caj-townwise-backup` runs at 07:17 UTC. Its init container dumps `townwise` with `mongodump` (the kit's pinned `mongo:8.0.32`, imported into the registry) into the job's EmptyDir; then the pinned Azure CLI uploads `townwise-<UTC time>.archive.gz` to container `mongodump` in `sttwbackup2d2c15bf` as one Put Blob with `If-None-Match: *`. Recovery point: up to 24 hours.
- **Identities.** Every job has its own identity with only what it needs (`jobs.tf` has the table). The backup identity's only data right is creating a new blob (custom role "Townwise backup writer", `blobs/add/action`): it cannot read, overwrite or delete dumps. Only the upload container can obtain its token; `mongodump` cannot.
- **Alert.** `townwise-backup-missing` emails `alert_email` when no `uploaded townwise-` line reached `ContainerAppConsoleLogs` in the last day (checked every 6 hours). It also fires if the log cap stopped ingestion.
- **Dump size limit.** The EmptyDir shares the replica's ephemeral storage, 2 GiB at 0.5 vCPU (1 GiB at 0.25). The upload is one Put Blob of at most 5,000 MiB. The upload log prints each dump's size: when it passes about 500 MB, raise the job to 1 vCPU and 2 GiB (4 GiB of ephemeral storage); before about 2 GB, move off EmptyDir (an Azure Files volume, or `mongodump --archive` streamed through block uploads, which needs `blobs/write`).
- **Protection.** The container has a 30-day time-based retention policy: dumps can be added and read, never changed or deleted, for 30 days, even by admins through the data plane. Lifecycle management deletes them on day 31. The blob endpoint admits only the apps subnet, Entra ID auth only. The policy starts **unlocked**, so a `townwise-admins` member (guests included) could remove it, then delete every dump.
- **Lock it after a week of clean backups.** When `az containerapp job execution list -n caj-townwise-backup -g rg-townwise-prod -o table` shows seven `Succeeded` runs and step 10's restore worked, add `lock_backup_retention = true` to `terraform.tfvars` and apply. **Locking is irreversible**: the policy can then only be lengthened, no one can remove it, and the storage account cannot be deleted until its newest dump is 30 days old, so a teardown begins by stopping the backup job 30 days ahead.
- **Restore** (`infra/scripts/db-restore.sh`, always with a named dump; never "the newest"). The restore job downloads with its own read-only identity (`Storage Blob Data Reader`; only the download container gets the token) and restores as `townwise-restore`, a user that exists only for the restore:
  1. **Begin.** Create the restore user, then run the db-users job:

     ```sh
     printf 'mongodb+srv://townwise-restore:%s@%s/townwise?%s' "$(pw)" "$host" "$O" | infra/scripts/set-secret.sh "$V" mongodb-restore-uri
     az containerapp job start -n caj-townwise-db-users -g rg-townwise-prod      # reports "restore: created townwise-restore"
     ```

     (`pw`, `host` and `O` as in step 5.)
  2. **Restore a named dump** beside the live data, then inspect `townwise_restore`:

     ```sh
     infra/scripts/db-restore.sh townwise-<YYYYMMDD>T<HHMMSS>Z.archive.gz                # into townwise_restore
     ```

     Over live data: stop the API first (`az containerapp revision deactivate -n ca-townwise-api -g rg-townwise-prod --revision <latest revision>`, and `revision activate` afterwards), then `infra/scripts/db-restore.sh <dump> townwise`. `--drop` replaces each collection in the dump; collections not in the dump are left alone.
  3. **End.** Remove the restore user and the `townwise_restore` copy (it would otherwise outlive the dumps' 30-day retention):

     ```sh
     printf 'none' | infra/scripts/set-secret.sh "$V" mongodb-restore-uri
     az containerapp job start -n caj-townwise-db-users -g rg-townwise-prod      # reports "restore: dropped townwise-restore"
     ```

- **Who can.** Microsoft: "Treat permission to start a job as permission to use the job's secrets and available managed identities", because a start request can replace the job's containers. Only `townwise-admins` (Owner on the group) can start jobs; developers (Reader) and the deploy identity cannot. Because each job has its own identity and secrets, starting the smoke or restore job does not expose the admin password, and starting the backup job does not expose read access to the dumps. With the forecast lab (step 20), the API's identity may also start `caj-townwise-lab`, and the deploy identity may update it (any part of its definition, not only the image); that job's identity holds AcrPull only, so neither grant exposes a secret or a data role. Its `identitySettings` lifecycle is `Main`, so whoever can start or update the job (the API identity, the deploy identity, admins) can also obtain the lab identity's token for the lab callback app, and so call the callback as the lab job. Neither identity gains anything by it: the API identity already reads the database, and the deploy identity already sets the API's image, which runs as the API identity. Developers and secrets admins (Reader) cannot start, update or read a token for the job.

### 15. Sponsorship balance

Check the remaining credit at https://www.microsoftazuresponsorships.com/Balance. The subscription's spending limit is off, so usage bills the card on file once the credits run out. The $60 budget covers the three Townwise resource groups and alerts at 80% of actual spend and at 100% of forecast. Expected spend is about $50.50, so the 80% alert fires late in most months. Once file storage is applied (step 18) it is about $58.40, so the 80% alert fires every month and the forecast alert near the end of most; raise the budget in `terraform/bootstrap` before step 18 if that noise is unwanted.

### 16. Enable the tuning chat

The tuning chat (`docs/portal/tuning-chat.md`) is off until the API has `ANTHROPIC_API_KEY`. Off, `GET /api/org/locations/<id>/chat` answers `enabled: false` and a turn answers 503 `chat_unavailable`. Turning it on sends chat messages, and the location data the assistant reads, to Anthropic.

1. **Create the key.** In the Anthropic Console, in a workspace used only by Townwise production, create an API key named `townwise-production`, and set that workspace's monthly spend limit to what you can afford to lose; it is the hard cap. The API's own cap, `TOWNWISE_CHAT_MONTHLY_BUDGET_USD` in `api/production.env` (20 dollars a month per organization), stops new turns per organization but is not a cap on the account.
2. **Seed it** without it reaching argv, history or the terminal (paste at the hidden prompt):

   ```sh
   cd "$(git rev-parse --show-toplevel)"
   infra/scripts/set-secret.sh kv-townwise-2d2c15bf anthropic-api-key
   ```

3. **Turn it on.** Add `enable_chat = true` to `infra/terraform/production/terraform.tfvars`, then `terraform plan` and `terraform apply` from `infra/terraform/production`. The plan adds one role assignment (the app's identity reads `anthropic-api-key` only) and changes the Container App (the `anthropic-api-key` Key Vault reference and the `ANTHROPIC_API_KEY` env var), which starts a new revision.
4. **Check.** Signed in as a member, `GET /api/org/locations/<id>/chat` answers `enabled: true`.

**Rotate** by seeding a new version with the same command and running `az containerapp revision restart`, then revoke the old key in the Console. **Turn it off** with `enable_chat = false` and apply, which removes the reference, the env var and the role assignment; the secret stays in Key Vault until you delete it.

**Shared developer key.** To run the chat locally, developers use one shared key that cannot reach production's workspace or budget:

1. **Create it.** In the Anthropic Console, create a workspace used only for development, `townwise-dev` (the Default workspace cannot take a spend limit). Set its monthly spend limit to 50 dollars and create an API key named `townwise-dev` in it. A key stays in the workspace it was made in, so that limit caps everything the key spends.
2. **Seed it** as above: `infra/scripts/set-secret.sh kv-townwise-2d2c15bf anthropic-dev-key`.
3. **Grant it.** Apply `infra/terraform/bootstrap`. The plan adds one role assignment: `townwise-developers` gets Key Vault Secrets User on `anthropic-dev-key` only, never on the vault. Seed first, because the assignment is scoped to the secret.
4. **Use it.** Each developer, signed in with `az login`, reads it with `az keyvault secret show --vault-name kv-townwise-2d2c15bf --name anthropic-dev-key --query value -o tsv` and sets it as `ANTHROPIC_API_KEY` in `api/.env.local` (gitignored). Every read is in the vault's audit log.

**Rotate** by seeding a new version, revoking the old key in the Console and telling developers to read it again. Do the same when someone leaves the team, after removing them from `townwise-developers`.

### 17. Enable the Places search

The Places search on the access request (`api/README.md`, Places search) is off until the API has `GOOGLE_PLACES_API_KEY`. Off, `POST /api/places/autocomplete` and `POST /api/places/details` answer 503 `places_unavailable`, and the client shows the manual fields. Turning it on sends the text typed into the search, and the place picked, from the API to Google. Nothing Google answers is stored.

The same step turns on the map at the top of the confirm card. The API signs a Maps Static API URL for the picked place with `GOOGLE_MAPS_SIGNING_SECRET` and answers it; the browser (or the app) loads the image straight from `maps.googleapis.com`, so Google sees the viewer's IP address, and the web CSP's `img-src` allows that origin (`client/MODULE.md`, Security). The API never fetches or keeps the image. The URL carries `GOOGLE_MAPS_STATIC_KEY`, so that key is public by design: it gets its own key, restricted to the Maps Static API, with unsigned requests refused, so it cannot draw anything without a signature from the secret, which never leaves the API.

1. **Create the Places key.** In Google Cloud console, in the project that holds the OAuth clients (step 11), enable **Places API (New)**. Under APIs & Services, Credentials, create an API key named `townwise-production` and restrict it to Places API (New) only. Set the API's quotas (APIs & Services, Places API (New), Quotas & System Limits) to what you can afford to pay for: they are the hard cap. A billing budget alert only warns. The API's own `townwise:places` limiter (300 calls an hour per account) is per person, not a cap on the account.
2. **Create the map key.** In the same project (the signing secret belongs to the project, and Google checks that the key and the secret come from the same one), enable **Maps Static API**. Create a second API key named `townwise-maps-static` and restrict it to Maps Static API only. Leave its application restriction at None: the native app sends no referrer, and the signature is what guards it. Set the Maps Static API quota (map loads per day) to what you can afford, as for Places.
3. **Get the signing secret and refuse unsigned requests.** Google Maps Platform, Credentials, URL signing secret ("Secret Generator"): copy the current secret (generate one if there is none). Then on the Quotas page, pick Maps Static API, open **Unsigned requests** and set "Unsigned requests per day" to **0**, so Google refuses any map request without a valid signature. A signed URL never expires, but it draws only the one place it was made for, and every load counts against the quota.
4. **Seed all three** without them reaching argv, history or the terminal (paste each at the hidden prompt):

   ```sh
   cd "$(git rev-parse --show-toplevel)"
   infra/scripts/set-secret.sh kv-townwise-2d2c15bf google-places-api-key
   infra/scripts/set-secret.sh kv-townwise-2d2c15bf google-maps-static-key
   infra/scripts/set-secret.sh kv-townwise-2d2c15bf google-maps-signing-secret
   ```

   Seed all three **before** the next step: a Key Vault reference to a missing secret fails the new revision.
5. **Turn it on.** Add `enable_places = true` to `infra/terraform/production/terraform.tfvars`, then `terraform plan` and `terraform apply` from `infra/terraform/production`. The plan adds three role assignments (the app's identity reads `google-places-api-key`, `google-maps-static-key` and `google-maps-signing-secret` only) and changes the Container App (the three Key Vault references and the `GOOGLE_PLACES_API_KEY`, `GOOGLE_MAPS_STATIC_KEY` and `GOOGLE_MAPS_SIGNING_SECRET` env vars), which starts a new revision. A malformed signing secret stops the revision at boot with a `ConfigError` naming `GOOGLE_MAPS_SIGNING_SECRET`: reseed it and restart.
6. **Check.** Signed in, typing a restaurant's name into the access request's search shows suggestions. A 503 `places_unavailable` with the key set means Google refused or failed: the API logs `townwise.places_failed` with Google's HTTP status. Picking one shows the dark map with a mint pin on the confirm card, with no CSP violation in the browser console. No map there with both map secrets set: open the image's request in the browser's network panel; a 403 from Google usually means the key lacks Maps Static API, or the secret and the key are from different projects.

**Rotate the Places key** by seeding a new version with the same command and running `az containerapp revision restart`, then delete the old key in Google Cloud console. **Rotate the map key** the same way with `google-maps-static-key`. **Rotate the signing secret**: generate a new one in Google, seed it as `google-maps-signing-secret`, and run `az containerapp revision restart` **within 24 hours**, because the old secret stops working 24 hours after the new one is made (until the restart, the API signs with the old one). **Turn it off** with `enable_places = false` and apply, which removes the three references, the three env vars and the three role assignments; the secrets stay in Key Vault until you delete them.

### 18. Enable file storage

Stored files (`api/README.md`, Files; `docs/portal/spec.md` 11A) are off until the API has `FILES_BLOB_ACCOUNT_URL`. Off, every files and imports route answers 503 `files_unavailable`, and the client offers the in-browser upload (P13), which sends only three values a day.

**Wait for all of these before step 3.** Raw exports hold other people's personal data (diner names, phones, card details), so files go on only in one release with:

- the file storage client pieces and the drop screen (HistoryStep) that mounts them;
- Your data's reference items (any file, pasted text, text kept from TownwiseAI) and TownwiseAI's reading of text items (spec D28), with the privacy page's Your data wording;
- the privacy page's stored-files wording, because the privacy page's promise changes with it: stored files, ZIP, PDF and Word reading, the AI column step's redacted profile going to Anthropic, the retention periods once confirmed, the owner's "delete originals", and the staff purge for a person's deletion request.

The API side is in the build (spec 11A): ZIP, PDF and Word reading, the AI column step, and every deletion path. Before step 3, check on `develop` that each still has a passing test (`npm test -w @townwise/api`):

- deleting a location's sales data, a location, an organization, and an org admin's "delete originals", which leaves reference items whole (`api/test/files-deletion.int.test.ts`);
- an organization's deletion refused while stored files are off but it has files (`api/test/deletion.int.test.ts`);
- the daily sweep: unfinished uploads after 24 hours, originals after 365 days, never-read drops after 30 days, staff purges finished, orphan blobs (`api/test/files-sweeper.int.test.ts`);
- the staff purge of an organization's originals for a person's deletion request (`api/test/files-deletion.int.test.ts`).

If any fails, stop: the 400-day lifecycle rule is the only other thing that would remove those files. The AI column step runs only when `ANTHROPIC_API_KEY` is also set (step 16), within `TOWNWISE_FILES_MONTHLY_BUDGET_USD` (`api/production.env`, 5 dollars an organization a month).

1. **Apply.** `terraform plan` and `terraform apply` from `infra/terraform/production`. The plan adds the account `sttwfiles2d2c15bf`, its two containers, the custom role "Townwise client files", the two container-scoped assignments for the app's identity, the lifecycle rule, the diagnostic setting, the private DNS zone `privatelink.blob.core.windows.net` and its VNet link, the private endpoint `pe-townwise-files`, and the NSG rule `allow-apps-to-blob`. Storage is managed through Resource Manager only (`data_plane_available = false`), so the apply never needs the blob endpoint, which no laptop or runner can reach.
2. **Wait about 10 minutes** for the role assignments to reach the data plane. Until then the API's blob calls are refused, which it answers as 503 `storage_unavailable`.
3. **Turn it on.** Uncomment `FILES_BLOB_ACCOUNT_URL=https://sttwfiles2d2c15bf.blob.core.windows.net` in `api/production.env` and merge to `main`. The value is public; the API authenticates with its managed identity (`AZURE_CLIENT_ID`, already set) through the shared token source (`api/src/azure-identity.ts`), and refuses to start if the identity's variables are missing.
4. **Check from outside:** `curl -sI https://sttwfiles2d2c15bf.blob.core.windows.net/client-raw` from a laptop must fail (the name resolves to a public address that refuses, because public network access is disabled).
5. **Check in the app:** signed in as a test organization's admin, drop a small CSV, read it, download the original and the cleaned copy, delete it. On Your data, add a small reference file and paste a short text, download both and delete them. Then drop a file over 64 MiB from a browser throttled to DevTools "Slow 4G" and confirm it completes: each 8 MiB chunk is its own request, so none comes near the 240-second ingress timeout.
6. **Check the access log:** the audit account's `insights-logs-storagewrite` and `insights-logs-storagedelete` containers hold entries for those calls, made by the app's identity, with blob names that are ids only.

The files account is `prevent_destroy`, and deleting it deletes every client file: export or delete the organizations first. Soft delete keeps a deleted blob for 7 days.

### 19. Forecasts

No infrastructure of its own: a forecast is a run's outputs, which staff export on the team's computers and import through the staff console, or, with the forecast lab (step 20), from a calibration job. The model, the partner's exports and the fitted models stay on those computers (spec 14.4). Owner decision (2026-11-05): Sawtooth's frozen v3 forecast may be imported and published only once Sawtooth is an organization in Townwise and the owner has confirmed its consent to see it and to its being sent to Anthropic through TownwiseAI, and only after the privacy page carries the forecasts paragraph (`docs/portal/estimates.md` section 5).

1. **Export.** From `modeling/`, run `uv run python export_forecast_run.py` with the frozen daily, weekly and events CSVs and the sha256 of each from `modeling/forecasts/README.md` (the script refuses a file that doesn't match), the model's version, family and notebook commit, its training dates and made-at date, the town id, each full buyout day from the booking rule as `--booked`, `--widened` when its ranges were widened, and the backtest figures from the README. It writes `modeling/outputs/forecast-run-{version}-{first day}.json`, which is gitignored: never commit it, and never paste its numbers anywhere.
2. **Import as a draft.** Signed in as staff, open the organization (`/admin/orgs/<id>`), Forecasts, Import a forecast: pick the location, choose the file, check the summary (model, day count, dates, trained to, made), then Import. It lands as a draft that no owner and not TownwiseAI can see. Importing the same file again finds the same run, and finishes one a crash left unfinished.
3. **Check, then publish.** Check the draft's row (model, dates, day count, trained to, made) against the forecasts README, then Publish. No route shows a draft's days to anyone, so the check is of the file before import. The organization's admins see the import and the publish in their Townwise staff activity. Signed in as a member of the organization, the model card names the run, and TownwiseAI's `get_forecast` reads it. Withdraw takes it back at once; Delete removes it.
4. **Deletion duty.** Deleting the organization, the location or its sales data deletes its runs in Townwise. When an organization is deleted, or a person asks, staff also delete its fitted models, its exports and any forecast run files from the team's computers, and say so in the deletion record's notes.

### 20. Enable the forecast lab

The lab retrains a location's forecast model in Azure, from the sales the API hands the job (`modeling/lab`, `api/src/lab`). It is the one job the API hands sales to directly (over the callback), so it is off until you apply it: `enable_lab` is false, and `lab_image` and `lab_callback_client_id` are null. The job `caj-townwise-lab` is Manual, 1 vCPU and 2 GiB, 900 seconds, never retried, with no secrets and its own identity (`id-townwise-job-lab`) that holds AcrPull and nothing else. It holds no database or storage credential and no secret of any kind: the API starts it with only `TOWNWISE_LAB_CALIBRATION_ID` added to its environment, and the job signs in to the API's callback with its own identity. `identitySettings` lifecycle `Main` lets its one container ask the Container Apps identity endpoint for a token, which it does only for the lab callback app (`AZURE_CLIENT_ID` and `TOWNWISE_LAB_TOKEN_RESOURCE` in its environment), and the API accepts that token only from the lab identity's object id (`TOWNWISE_LAB_AUDIENCE`, `TOWNWISE_LAB_CALLER_ID`, `TOWNWISE_LAB_TENANT_ID` in its environment). Nothing token-shaped is in the job's environment or its execution history. The input is fetched once, and the result needs a result token the input answer hands the job. The API's identity gets the custom role "Townwise lab starter" (`Microsoft.App/jobs/read` and `Microsoft.App/jobs/start/action`) at the job's scope only, and the deploy identity gets the "Townwise deployer" role on the job. Agents write and test both stacks but never apply them.

1. **Merge with `LAB_ENABLED` unset.** The release builds `modeling/lab/Dockerfile` in a job with no token and pushes `townwise-lab:<sha>`. The deploy log prints the pushed digest on the line `lab image: <registry>/townwise-lab@sha256:...`; copy it. No lab job exists yet, so the deploy does not touch one. Only an image built from this change or later signs in with its identity; an older one stops at "missing environment variable".
2. **Create the lab callback app (bootstrap, you).** This needs Application Administrator or Global Administrator in the tenant. From `infra/terraform/bootstrap`, `terraform plan` shows three `azuread` resources (the application `townwise-lab-callback` with v2 access tokens, its identifier URI `api://<client id>`, its service principal) and one output, and no Azure role change; `terraform apply`, then `terraform output lab_callback_client_id`.
3. **Apply.** In `infra/terraform/production/terraform.tfvars` set `enable_lab = true`, `lab_image = "<that digest>"` and `lab_callback_client_id = "<the output from 2>"` (the client id, a GUID, not the `api://` URI), then `terraform plan` and `terraform apply` from `infra/terraform/production`. The plan adds the identity, its AcrPull assignment, the role "Townwise lab starter", its assignment to the API's identity at the job, the deploy identity's assignment at the job, the job (lifecycle `Main`; `TOWNWISE_LAB_API_URL`, `AZURE_CLIENT_ID` and `TOWNWISE_LAB_TOKEN_RESOURCE` in its environment), and changes the Container App (`TOWNWISE_LAB_RUNNER=azure`, `TOWNWISE_LAB_JOB_ID`, `TOWNWISE_LAB_AUDIENCE`, `TOWNWISE_LAB_CALLER_ID`, `TOWNWISE_LAB_TENANT_ID`), which starts a new revision. `terraform output lab_job_id` prints the id. Terraform ignores later changes to the job's image (`ignore_changes` on the container image), so a plan after a release shows no drift; if a future provider stops honoring that for the job body, re-apply with the newest digest instead.
4. **Turn the deploy on.** Set the repository variable `LAB_ENABLED=true`. From the next release, the deploy points `caj-townwise-lab` at the new digest (with `az rest`, the same PATCH as `az containerapp job update --image`, whose wait the deploy role cannot follow) and waits until the job reports `Succeeded` with that image.
5. **Check on a test organization with synthetic days.** Calibrate in the console (a location with at least the minimum history), and wait for the execution to succeed. Its console log has only `fetched input: N days` and `posted result: ok`, and `ContainerAppConsoleLogs | where ContainerName == "lab" | project TimeGenerated, Log` shows no figure, date or name (`lab` is the job's container name, which no other app or job in the environment uses). If the job cannot reach the API's default host name (it uses `https://<fqdn from terraform output container_app_fqdn>`), set its `TOWNWISE_LAB_API_URL` to `https://api.townwise.tech` in `lab.tf` and apply again. Then check the sign-in:
   - `az containerapp job execution show -n caj-townwise-lab -g rg-townwise-prod --job-execution-name <that execution> --query "properties.template.containers[0].env[].name"` lists only `TOWNWISE_LAB_API_URL`, `AZURE_CLIENT_ID`, `TOWNWISE_LAB_TOKEN_RESOURCE` and `TOWNWISE_LAB_CALIBRATION_ID`, and no value in it is a token.
   - `curl -i https://api.townwise.tech/lab/calibrations/<that calibration id>/input` with no `Authorization` header, and again with `-H 'Authorization: Bearer x.y.z'`: both 404. The API's console log has `townwise.lab_callback_refused` with `reason` `missing` and `malformed`, the route, and nothing else.
   - If the calibration fails instead, the API's log names the setting to check (see Logs). A job that could not sign in prints `failed: <error class>` and posts nothing, so its calibration shows `timeout` after 20 minutes.
   - After the first release with `LAB_ENABLED` set, `az containerapp job show -n caj-townwise-lab -g rg-townwise-prod --query "properties.configuration.identitySettings"` still shows lifecycle `Main`, the container still has its three variables, and a production `terraform plan` shows no drift (the deploy's PATCH sends `configuration: {}` and has not yet run against a real lab job).
6. **Revoke the lab's sign-in at once, if ever needed.** `terraform apply -replace='azurerm_user_assigned_identity.lab[0]'` from `infra/terraform/production`: the new identity has a new object id, which Terraform writes into the API's `TOWNWISE_LAB_CALLER_ID`, so every token of the old one is refused (the API checks `oid`, not a role Entra caches). Setting `enable_lab = false` turns the lab and its callback off.
7. **Switch forecasts on.** Only for an organization whose owner agreed, and only once the privacy page carries the forecasts paragraph (step 19): until then a better draft stays a draft with its scorecard visible to staff.
8. **Delete old lab images now and then.** Every release pushes `townwise-lab:<sha>`, about 0.5 GB compressed (on Linux, xgboost brings NVIDIA's NCCL library, a 305 MB wheel), even while the lab is off, and its dependency layer is new each time because the build has no cache. The registry has no retention policy, Basic includes 10 GiB, and storage beyond that costs $0.10 per GB a month, so about twenty releases pass it. Keep the newest three (the job runs the newest once `LAB_ENABLED` is on; before that, also keep the `lab_image` digest) and delete the rest:

   ```sh
   az acr manifest list-metadata -r crtownwise2d2c15bf -n townwise-lab --orderby time_desc --query '[3:].digest' -o tsv \
     | while read -r d; do az acr manifest delete -r crtownwise2d2c15bf -n "townwise-lab@$d" --yes; done
   ```

## Logs

Container Apps and Key Vault `AuditEvent` logs go to `log-townwise`, capped at 0.1 GB a day to stay inside the 5 GB monthly free ingestion. `AuditEvent` also goes to `sttwaudit2d2c15bf`, which has no cap, keeps it for a year, and admits only Azure Monitor, so spending the cap cannot blind the audit trail. When the cap is reached, ingestion stops until the daily reset, and the alert `townwise-log-daily-cap-reached` emails `alert_email`. A flood of rate-limited requests logs one line per `429`, which can spend the cap; excluding 429s from the request log is an upstream suggestion for the kit's `server-core`, not changed here.

The forecast lab's callback logs `townwise.lab_callback_refused { route, reason }` for each refused sign-in (never the token). On a calibration that should have worked, the reason points at the setting: `issuer` (a v1 token: the lab callback app's `requested_access_token_version` is not 2, or `TOWNWISE_LAB_TENANT_ID` is wrong), `audience` (`TOWNWISE_LAB_AUDIENCE` is not the app's client id, or the job's `TOWNWISE_LAB_TOKEN_RESOURCE` names another app), `tenant` (`TOWNWISE_LAB_TENANT_ID`), `caller` (`TOWNWISE_LAB_CALLER_ID` is not the lab identity's principal id, or the job asked as another identity: `AZURE_CLIENT_ID`), `expired` (clock), `signature` (a token not from Entra), `missing` or `malformed` (not the job). `townwise.lab_callback_unavailable` (a warning) means the API could not fetch Entra's signing keys from `login.microsoftonline.com`; both routes answer 503 meanwhile. Entra caches managed identity tokens for about 24 hours per resource, so a change to the app registration or to `TOWNWISE_LAB_TOKEN_RESOURCE` can take that long to reach the job's tokens.

## Monthly cost

Prices are from the Azure Retail Prices API (eastus), with a 730-hour month (2,628,000 seconds).

| Item | Price | Per month |
|---|---|---|
| Container Apps API, 0.5 vCPU and 1 GiB per replica (API 0.25/0.5Gi plus Valkey 0.25/0.5Gi), 1 replica always on | idle $0.000003 per vCPU-second and per GiB-second (active vCPU $0.000024); monthly free grant of 180,000 vCPU-s, 360,000 GiB-s and 2M requests | about $10.20 idle, plus about $1 per active hour a day |
| Container Apps environment on a VNet: one Standard load balancer (in `rg-townwise-prod-infra`) | $0.025 an hour | $18.25 |
| Two static public IPs, ingress and egress (same group) | $0.005 an hour each | $7.30 |
| Workload-profiles environment, Consumption profile only | no Dedicated plan management fee | $0 |
| Azure DocumentDB, free tier (32 GiB) | | $0 |
| Private endpoint for the database | $0.01 an hour, plus $0.01 per GB in and out | $7.30 |
| Private DNS zone `privatelink.mongocluster.cosmos.azure.com` | $0.50 per zone (queries $0.40 per million) | $0.50 |
| Private endpoint for client files | $0.01 an hour, plus $0.01 per GB in and out | $7.30 |
| Private DNS zone `privatelink.blob.core.windows.net` | $0.50 per zone (queries $0.40 per million) | $0.50 |
| Client file storage, Hot LRS | $0.0208 per GB a month; transactions and access-log writes are cents a month at this scale | under $0.10 at a few GB |
| Backup job, about 5 minutes a night at 0.5 vCPU and 1 GiB | active rates | about $0.14 |
| Forecast lab, when on (step 20), a calibration of about 15 minutes at 1 vCPU and 2 GiB | active rates | about $0.03 per calibration |
| Backup storage, Hot LRS, 30 dumps kept | $0.0208 per GB a month, writes $0.05 per 10,000 | about $0.03 at 50 MB a dump |
| Container Registry Basic, 10 GiB included | $0.1666 a day; storage beyond 10 GiB $0.10 per GB a month | $5.07, while old lab images are deleted (step 20) |
| Azure DNS zone | $0.50 per zone (queries $0.40 per million) | $0.50 |
| Key Vault | $0.03 per 10,000 operations | about $0.02 |
| Log Analytics | first 5 GB a month free; the 0.1 GB daily cap keeps ingestion under it | $0 |
| Daily-cap alert, a log search rule every 15 minutes | $0.50 a rule | $0.50 |
| Backup-missing alert, a log search rule every 6 hours | $0.50 a rule | $0.50 |
| Key Vault audit archive, Hot LRS, a year kept | $0.0208 per GB a month | under $0.05 |
| Static Web Apps Free | | $0 |
| Communication Services email | $0.00025 per message plus $0.00012 per MB | about $0.25 per 1,000 emails |
| State storage | | under $0.05 |
| **Total** | | **about $58.40 at low traffic** |

The tuning chat, when on (step 16), bills Anthropic directly, not Azure: at most the Console workspace's spend limit, and the API stops new turns once an organization reaches `TOWNWISE_CHAT_MONTHLY_BUDGET_USD` in a month.

The Places search, when on (step 17), bills Google Cloud directly, not Azure: at most what the Places API (New) and Maps Static API quotas allow. Each pick is one Place Details call and one map load, and each time the confirm card is shown again the browser may load the map again.

If the free tier refuses private access (step 3), M10 adds $0.0191 an hour ($13.94) plus 32 GiB at $0.115 per GB ($3.68): about $68 in total. If init-container resources turn out to be billed too, the Container Apps line rises by about half.

## Known risks

- **The kit's duplicate-key handling on DocumentDB.** Until the fix on its own branch lands, a Google email conflict answers 500 instead of 409, and the second of two concurrent first sign-ins answers 500. The smoke test in step 10 shows when it is fixed.
- **`documentdb-local` is a proxy, not proof.** It runs the same open-source engine (1.0.0) but accepts `retryWrites=true`, which the managed service rejects, and its administrator cannot create users. Step 10 is the real check.
- **Free tier.** No backups (the nightly dump is the only copy outside the cluster; up to 24 hours of data at risk), no HA and no SLA, 32 GiB, no Entra ID auth, and the cluster pauses after 60 days with no connections (the API holds connections while it runs). Private endpoint support on the free tier, and free tier on a Sponsorship subscription, are undocumented; step 3 checks both.
- **Database roles are cluster-wide** (step 7). The application user can read and write any database in the cluster and holds `clusterAdmin`, the pair DocumentDB requires. Only Townwise data lives there.
- **Index builds.** On the emulator, each index build on an existing collection took about 2 seconds. First boot builds on empty collections; a later index on a large collection could outlast the startup probe (60 seconds).
- **The Static Web Apps client image** is pinned to the `prev` tag's digest (2026-09-28): the current `stable` digest (`sha256:026b202f...`, 2026-10-29) was inside the 7-day release-age window. Move to it after 2026-11-05. The client runs with the documented `INPUT_*` variables plus `GITHUB_WORKSPACE=/github/workspace`, which it resolves `app_location` against; without it the first deploy failed with "App Directory Location: 'web' is invalid" (it looked in `/bin/staticsites/web`).
- **Production state holds two credentials,** computed attributes Terraform cannot omit: the Communication Services access keys, which authenticate nothing now that local auth is disabled, and the Static Web App deployment token. Only admins can read that state. If refreshing `azurerm_communication_service` ever fails because its keys cannot be listed with local auth off, manage that resource with `azapi_resource` instead.
- **The email role includes `CommunicationServices/Write`** (the minimal role Microsoft documents), scoped to the one Communication Services resource.
- **`TRUST_PROXY=uniquelocal,100.64.0.0/10`:** Microsoft does not publish the ingress proxy's source range. The client-IP check in step 13 confirms real addresses.
- **The API's own init container** (`valkey-tls`) can still obtain the API identity's token: the app is an azurerm resource, which has no `identitySettings`. It runs the pinned Valkey image with a fixed script.
- **`id-token-guard` is a check, not a gate** (GitHub Free has no required checks). The `job_workflow_ref` subject is the enforced control; it cannot tell jobs inside `deploy.yml` apart.
- **Client files behind a private endpoint.** With public network access disabled, any provider call that touched the files account's data plane from a laptop or runner would fail. azurerm 5.11 manages the containers and the lifecycle rule through Resource Manager (`data_plane_available = false`), but CI's mocked plan cannot prove it; the first real apply in step 18 does.
- **Platform-managed group.** `rg-townwise-prod-infra` holds the environment's load balancer and public IPs. Do not edit it; it goes with the environment.
- **The lab identity's token is not tied to one calibration** (step 20). It lives about 24 hours, and the callback accepts it for any live calibration. The input is fetched once and a result needs the result token from that fetch, so a misused token cannot post a result or fetch an input twice. But code running as the lab identity (a compromised lab image, or anyone who can start or update the job) could read a sibling calibration's input during its unfetched window, before that calibration's own job fetches it; that job's fetch is then refused and its calibration fails `timeout`. Before this change each execution held only its own token. Binding each fetch to its Container Apps execution (the job sends `CONTAINER_APP_JOB_EXECUTION_NAME`, and the API checks that execution through Resource Manager, which needs `Microsoft.App/jobs/executions/read` for the API identity) is deferred by owner decision (2026-11-10). Revoke with step 20.6.
- **Lifecycle `Main` makes the lab identity's AcrPull usable from inside the lab container** (step 20): it could pull any image in the registry (API, Mongo, Valkey; none holds a secret by design). Accepted by owner decision (2026-11-10).
- **A lab job that cannot sign in or fetch its input fails by `timeout` after 20 minutes,** not `job_failed` at once: without the input answer it has no result token to post a failure with. Accepted by owner decision (2026-11-10).
- **The lab callback depends on `login.microsoftonline.com`** for Entra's signing keys (cached by the API). While they cannot be fetched, the callback answers 503 and the job retries its result once.

## Teardown

1. Set `DEPLOY_ENABLED=false`.
2. **Move the name servers back first.** At InterNetX, point `townwise.tech` back at `ns1-4.dns.host`. Then wait for the old delegation's TTL to run out, so no resolver still sends queries to the Azure zone: read the TTL on the `.tech` registry's NS answer (`dig +norecurse NS townwise.tech @$(dig +short NS tech. | head -n 1)`) and wait at least that long, often up to 48 hours.
3. If `lock_backup_retention` is true, stop the backups **30 days before** this step (`az containerapp job delete -n caj-townwise-backup -g rg-townwise-prod`) and wait for the newest dump to age out. Otherwise, remove the unlocked retention policy on the backup container, or the group deletion stops at the storage account: `az storage container immutability-policy delete --account-name sttwbackup2d2c15bf --container-name mongodump --if-match "$(az storage container immutability-policy show --account-name sttwbackup2d2c15bf --container-name mongodump --query etag -o tsv)"`. (A locked policy cannot be removed.)
4. Delete `rg-townwise-prod` (`az group delete -n rg-townwise-prod`). This deletes the zone, the database (Terraform's `prevent_destroy` does not apply outside Terraform), and the environment, which takes `rg-townwise-prod-infra` with it. The Key Vault keeps purge protection in Azure, so its name stays reserved for 90 days.
5. Delete `rg-townwise-bootstrap`, which holds the state account and the deploy identity, the budget (`az consumption budget delete --budget-name townwise-monthly`), the three `townwise-*` Entra groups (`az ad group delete --group <name>`), and the `townwise-lab-callback` app registration (`az ad app delete --id <lab_callback_client_id>`, which also removes its service principal).
6. Outside Azure: delete the Google OAuth clients, the Places API key and the Maps Static API key (without a key, the project's URL signing secret signs nothing), and remove the guest users.
