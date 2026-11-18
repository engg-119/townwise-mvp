# Townwise infrastructure (Azure)

Everything runs in the Azure Sponsorship subscription `2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999` (tenant `37acb94f-e2d9-41d9-a697-1bd7a1d60bf1`), region `eastus`, in two resource groups, `rg-townwise-bootstrap` and `rg-townwise-prod`, plus `rg-townwise-prod-infra`, which the Container Apps platform manages. The existing `Dartmouth` and `cameronkeith` groups are unrelated and never touched. This infrastructure is Townwise-specific code; the camkeith/modules kit is AWS-only.

- **API:** Azure Container Apps, a workload-profiles environment with the Consumption profile only, in the virtual network `vnet-townwise`. 1 to 2 replicas, health probes on `/healthz`. Valkey runs as a TLS-only sidecar on `127.0.0.1`: an init container generates a per-replica CA, and the API trusts it through `NODE_EXTRA_CA_CERTS`, so the kit's `rediss:` rule holds. The image comes from a private Azure Container Registry, pulled with the app's managed identity. Secrets are Key Vault references. Custom domain `api.townwise.tech` with a managed certificate.
- **Database:** Azure DocumentDB (vCore; formerly Cosmos DB for MongoDB vCore), free tier, `docdb-townwise-2d2c15bf`. Public network access is disabled and there are no firewall rules: the only way in is a private endpoint in `snet-endpoints`, whose NSG admits port 10260 from the apps subnet only. The API connects as `townwise-app`, not as the administrator.
- **Backups:** a nightly Container Apps job dumps the database with `mongodump` as the read-only user `townwise-backup` and uploads the archive to Blob Storage, where it is write-once for 30 days and deleted on day 31. An alert emails when a day passes without a successful upload. A manual job restores a named dump.
- **Client files:** the exports restaurants drop into Townwise, in `sttwfiles2d2c15bf` (containers `client-raw` and `client-clean`, blob names `{orgId}/{locationId}/{fileId}`, ids only). Public network access is disabled: the only way in is a private endpoint in `snet-endpoints`, whose NSG admits 443 from the apps subnet only. The API reads and writes with its managed identity through a custom role on the two containers that cannot mint a SAS. Every blob read, write and delete is logged to the audit account for a year. Off in the API until step 18.
- **Web:** Static Web Apps (Free) serving the Expo web export. `infra/web/staticwebapp.config.json` sets the headers from `client/MODULE.md` and the `/index.html` fallback. Domains `townwise.tech` and `www`.
- **DNS:** Azure DNS for `townwise.tech`.
- **Email:** Azure Communication Services, from `no-reply@townwise.tech`, sent with the app's managed identity. Access keys are disabled. DMARC is `p=reject`.
- **CI:** GitHub Actions reaches Azure only through an OIDC federated credential on a managed identity, for `deploy.yml` on `main` only. No CI identity is an app registration, and there is no client secret. While GitHub-hosted runners are blocked, the checks (never `deploy.yml`) can run on the owner's laptop (CI on the laptop runner).
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
openssl rand -base64 32 | infra/scripts/set-secret.sh "$V" townwise-calendar-key    # seals calendar links (step 21)

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

**Rotation.** JWT and encryption rings: run the same command, then `az containerapp revision restart`; key order is in `api/kit/auth/MODULE.md`. Database users: write a new `mongodb-uri` or `mongodb-backup-uri` as above (same user name, new password), run the db-users job (step 7), then restart the API revision; between the job and the restart, new pool connections fail, so do it at a quiet time. Admin password: bump `db_admin_password_version` and apply. The calendar key is never rotated (step 21). Container Apps picks up new secret versions within about 30 minutes on its own; a job started sooner can still see the old value, so wait, or check what the db-users job reports.

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

- **Consent screen:** add `townwise.tech` as an authorized domain. Its publishing status must be **In production**, and once it is, it is never changed: it is the whole project's, every client's included, and Testing admits only listed test users (step 22). Step 22 also adds the two read-only calendar scopes, `calendar.calendarlist.readonly` and `calendar.events.readonly`, under Data Access; they are sensitive, so Google reviews them.
- **Web client:** origins `https://townwise.tech` and `https://www.townwise.tech`. Sign-in needs no client secret; step 22 adds one to this client for Google calendars.
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
- **Actions, General, private repository fork pull requests:** **Run workflows from fork pull requests** on, and **Require approval for fork pull request workflows** on, always: the laptop runner (CI on the laptop runner) can be started at any time. **Send write tokens to workflows from fork pull requests** off. **Send secrets and variables to workflows from fork pull requests** off.

Approving a fork pull request's workflows while the laptop runner is in use runs its code on the owner's Mac, with everything that section's Security list says a job can reach. Read the whole diff before approving, not only the workflows.

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

**Rolling back past suggested closure rules** (spec D46, OpenSpec change `suggest-closure-rules`). An image from before it reads a rule's schedule without its yearly `season`, and its weekly suggestions list could show an open file suggestion as a weekly one. So, before the revision is moved back, in the `townwise` database:

1. Take the season off each yearly rule, or delete those rules: find them with `db.tw_business_rules.find({ 'schedule.season': { $exists: true } })`. Taking off only `schedule.season` leaves a closure with no end that covers every day from its start, so either remove the whole schedule (`updateMany({ 'schedule.season': { $exists: true } }, { $unset: { schedule: '' } })`, which keeps the rule's words and changes no forecast) or delete them.
2. Delete the open file and sales suggestions: `db.tw_agent_suggestions.deleteMany({ source: { $in: ['file', 'sales'] }, status: 'open' })`.

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

- **Who can.** Microsoft: "Treat permission to start a job as permission to use the job's secrets and available managed identities", because a start request can replace the job's containers. Only `townwise-admins` (Owner on the group) can start jobs; developers (Reader) and the deploy identity cannot. Because each job has its own identity and secrets, starting the smoke or restore job does not expose the admin password, and starting the backup job does not expose read access to the dumps. With the forecast lab (step 20), the API's identity may also start `caj-townwise-lab`, and the deploy identity may update it (any part of its definition, not only the image); that job's identity holds AcrPull only, so neither grant exposes a secret or a data role. Its `identitySettings` lifecycle is `Main`, so whoever can start or update the job (the API identity, the deploy identity, admins) can also obtain the lab identity's token for the lab callback app, and so call the callback as the lab job. Neither identity gains anything by it: the API identity already reads the database, and the deploy identity already sets the API's image, which runs as the API identity. Developers and secrets admins (Reader) cannot start, update or read a token for the job. The weekly forecast worker (step 20) has its own identity too, holding AcrPull, `mongodb-uri` and the lab starter role at the lab job, with lifecycle `Main`. So whoever can start or update `caj-townwise-forecasts` (admins, and the deploy identity, which updates its image) can use the application user's database URI and start lab executions. Neither gains anything by it: the deploy identity already sets the API's image, which runs with that same URI, and the API identity already starts the lab.

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

3. **Turn it on.** Add `enable_chat = true` to `infra/terraform/production/terraform.tfvars`, then `terraform plan` and `terraform apply` from `infra/terraform/production`. The plan adds one role assignment (the app's identity reads `anthropic-api-key` only) and changes the Container App (the `anthropic-api-key` Key Vault reference and the `ANTHROPIC_API_KEY` env var), which starts a new revision. With the forecast lab on (step 20), it also adds the weekly worker's own read of `anthropic-api-key` and changes `caj-townwise-forecasts` (the same reference and env var, for TownwiseAI's weekly suggestions).
4. **Check.** Signed in as a member, `GET /api/org/locations/<id>/chat` answers `enabled: true`.

**Rotate** by seeding a new version with the same command and running `az containerapp revision restart`, then revoke the old key in the Console. **Turn it off** with `enable_chat = false` and apply, which removes the reference, the env var and the role assignment; the secret stays in Key Vault until you delete it.

**Web search** (spec D37). `TOWNWISE_CHAT_WEB_SEARCH=true` in `api/production.env` makes every TownwiseAI request send Anthropic's web search tool; the code's default is off. [CONFIRM: web search on in production; off by default in code]

1. **Check it is enabled in the Console first.** In Claude Console, Settings, Capabilities, web search must be on for the Anthropic organization that owns the `townwise-production` key (it is on unless an administrator turned it off; leave its domain restrictions empty). With it off there, Anthropic answers every request that sends the tool with a 400 `invalid_request_error`, so every turn fails (`error` `internal`, logged as `townwise.chat_turn_failed` with status 400).
2. **Then release** `api/production.env` with the variable set. Each search costs $0.01 plus the tokens of its pages, inside the organization's monthly TownwiseAI budget; the system prompt asks for at most three a reply.
3. **Check.** Ask TownwiseAI about a public event in the town: the stream has a `web_search` tool event and its `done` lists the sites the reply cites, and `ContainerAppConsoleLogs | where Log has "townwise.chat_turn"` shows `webSearches`, a count, and never a query or a URL.

**Turn it off**, if turns fail after a change in the Console or for any other reason: set `TOWNWISE_CHAT_WEB_SEARCH=false` in `api/production.env` and release (or set the variable on the Container App, which starts a new revision; an environment variable wins over the file). Changing it changes the tools every request sends, so each conversation's prompt cache misses once and its earlier thinking blocks are dropped once (`drop_block`). Conversations that searched before keep their stored searches, and the API reads them back without the tool: on 2026-11-14 Anthropic's token count accepted a history of a search, its results, citations and thinking with the tool removed (given `drop_block`), and refused a search stored without its result, so it checks these blocks as a request does.

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

**Use it locally.** Developers share production's three secrets: `townwise-developers` has Key Vault Secrets User on each of them (only those, never the vault), granted by `infra/terraform/bootstrap` once they are seeded. Searches and map loads from a laptop count against production's quotas. Each developer, signed in with `az login`, writes them into `api/.env.local` (gitignored) and restarts the API:

```sh
for pair in GOOGLE_PLACES_API_KEY:google-places-api-key GOOGLE_MAPS_STATIC_KEY:google-maps-static-key GOOGLE_MAPS_SIGNING_SECRET:google-maps-signing-secret; do
  printf '%s=%s\n' "${pair%%:*}" "$(az keyvault secret show --vault-name kv-townwise-2d2c15bf --name "${pair#*:}" --query value -o tsv)" >> api/.env.local
done
```

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

The lab retrains a location's forecast model in Azure, from the sales the API hands the job (`modeling/lab`, `api/src/lab`). It is the one job the API hands sales to directly (over the callback), so it is off until you apply it: `enable_lab` is false, and `lab_image` and `lab_callback_client_id` are null. The job `caj-townwise-lab` is Manual, 1 vCPU and 2 GiB, 900 seconds, never retried, with no secrets and its own identity (`id-townwise-job-lab`) that holds AcrPull and nothing else. It holds no database or storage credential and no secret of any kind: the API starts it with only `TOWNWISE_LAB_CALIBRATION_ID` added to its environment, and the job signs in to the API's callback with its own identity. `identitySettings` lifecycle `Main` lets its one container ask the Container Apps identity endpoint for a token, which it does only for the lab callback app (`AZURE_CLIENT_ID` and `TOWNWISE_LAB_TOKEN_RESOURCE` in its environment), and the API accepts that token only from the lab identity's object id (`TOWNWISE_LAB_AUDIENCE`, `TOWNWISE_LAB_CALLER_ID`, `TOWNWISE_LAB_TENANT_ID` in its environment). Nothing token-shaped is in the job's environment or its execution history. The input is fetched once, and the result needs the result token the input answer hands whoever fetched it (see Known risks for what that allows). The API's identity gets the custom role "Townwise lab starter" (`Microsoft.App/jobs/read` and `Microsoft.App/jobs/start/action`) at the job's scope only, and the deploy identity gets the "Townwise deployer" role on the job. Agents write and test both stacks but never apply them.

With the lab, Terraform also creates the weekly forecast worker (spec D42 and 14.6; OpenSpec change `autonomous-forecasts`). The owner asked for background workers, so the weekly refresh is its own Container Apps job, not a timer in the API: `caj-townwise-forecasts` runs the API's image with the command `node --env-file=api/production.env api/src/workers/weekly-forecasts.ts` at five past every hour (UTC), 0.25 vCPU and 0.5 GiB, one replica, 600 seconds, never retried. Each execution runs one pass and exits. Under a 10-minute Mongo lease, the pass starts a calibration in `caj-townwise-lab` for each location that is due: from 03:00 on Monday in its town, once a week, only when its data changed since its last fit, with at most 3 live and roughly 200 a week (`TOWNWISE_WEEKLY_FORECAST_CAP`). It logs one line, `townwise.weekly_refresh_pass`, with a state and counts. Townwise pays for these calibrations; they are not charged to the organization's TownwiseAI month. Its own identity, `id-townwise-job-forecasts`, holds AcrPull, Key Vault Secrets User on `mongodb-uri` (the application user, as the API's) and, with `enable_chat`, on `anthropic-api-key` (the pass also makes TownwiseAI's weekly suggestions; OpenSpec change `weekly-forecast-suggestions`), and "Townwise lab starter" at the lab job. `identitySettings` lifecycle `Main` lets its container get the Resource Manager token that start needs. It has no Valkey and no other secret. Its environment holds `MONGODB_URI` (the Key Vault reference), `AZURE_CLIENT_ID`, the API's five `TOWNWISE_LAB_` values (`labRunnerOf` needs all four of the lab's with `azure`) and, with `enable_chat`, `ANTHROPIC_API_KEY` (the Key Vault reference); `api/production.env` gives it the rest, `TOWNWISE_WEEKLY_FORECASTS=true` and `TOWNWISE_WEEKLY_SUGGESTIONS=true` included. The deploy identity gets the deployer role on it, so every release sets its image to the API's digest. Four alerts come with it: `townwise-forecasts-failed`, checked hourly, fires on a pass with `failed` above 0 (a calibration start, a scheduled calibration the pass timed out, or a weekly suggestions call), a location that threw, a scheduled calibration that failed after it started (`townwise.calibration_finished` with `via` `scheduled` and `status` `failed`: its lab job crashed, timed out, or answered a failure or a result the API refused, and it is not retried that week), a worker that stopped on an error, or a pass on a Sunday (UTC) still holding locations back at a cap (a location the live cap holds back is caught up later in its week, so one still held on Sunday may miss it). `townwise-forecasts-killed`, checked hourly over two hours, fires on an execution that logged `townwise.weekly_worker_started` more than 15 minutes ago and never its pass line or error line from the same replica (pino's `hostname`): one killed by the 600-second replica timeout or crashed. A pass has 8 minutes of its own, so this means something hung outside it. `townwise-forecasts-missing`, checked every 6 hours, fires when no pass line arrived in a day; it also fires if the log cap stopped ingestion. A day, not longer, because a pass runs every hour and log search windows stop at two days. `townwise-forecasts-held`, checked hourly (severity 3), fires when the API logs `townwise.calibration_finished` with gate `jump_held`: a draft whose next 28 days differ from the current forecast's by more than 25%, waiting in the staff console's Forecasts for staff to publish or withdraw (spec 14.6). After a real level shift every weekly refit is held until staff act, so it fires again each week it is held.

**Forecasts are on by default for every organization** (owner directive, 2026-11-16; spec G1 and D42), so once step 3 is applied, every location with enough history (a 230-day span) gets a calibration from the next Monday, and its forecast publishes when the gate allows. No further switch is needed. Confirm Sawtooth's consent to see its forecast before step 3.

**Weekly suggestions start with the worker.** With `enable_chat` on, the worker gets `ANTHROPIC_API_KEY`, and `api/production.env` ships `TOWNWISE_WEEKLY_SUGGESTIONS=true`, so from step 3 every Monday it also sends each location's notes, business rules and town calendar to Anthropic for TownwiseAI's weekly suggestions, for every active organization (OpenSpec change `weekly-forecast-suggestions`). The privacy page must say what they send before they run in production, and that sentence still awaits the owner (`weekly-forecast-suggestions` task 4.1, `autonomous-forecasts` task 6.5). Before step 3, the owner approves it, or knowingly enables the lab with suggestions on, or `TOWNWISE_WEEKLY_SUGGESTIONS=false` ships in `api/production.env` until then. [DECISION NEEDED: the privacy page must say what weekly suggestions send before they run in production; the drafted sentence awaits the owner]

1. **Merge with `LAB_ENABLED` unset.** The release builds `modeling/lab/Dockerfile` in a job with no token and pushes `townwise-lab:<sha>`. The deploy log prints the pushed digest on the line `lab image: <registry>/townwise-lab@sha256:...`; copy it. No lab job exists yet, so the deploy does not touch one. Only an image built from this change or later signs in with its identity; an older one stops at "missing environment variable".
2. **Create the lab callback app (bootstrap, you).** This needs Application Administrator or Global Administrator in the tenant. From `infra/terraform/bootstrap`, `terraform plan` shows three `azuread` resources (the application `townwise-lab-callback` with v2 access tokens, its identifier URI `api://<client id>`, its service principal) and one output, and no Azure role change; `terraform apply`, then `terraform output lab_callback_client_id`.
3. **Apply.** First, in `infra/terraform/production/terraform.tfvars`, set `api_image` to the live API image, `az containerapp show -n ca-townwise-api -g rg-townwise-prod --query "properties.template.containers[0].image" -o tsv`, from a release that has the worker. The worker job is created with `api_image`, and the first API image (step 6) has no worker, so every hourly execution would fail until the next release. Terraform ignores the API app's image, so this changes only the smoke job's. To check the lab (step 5) before any scheduled calibration, pause the weekly refresh in the console first (any organization's Forecasts section, Pause weekly refresh), and resume it after step 5. In the same file set `enable_lab = true`, `lab_image = "<that digest>"` and `lab_callback_client_id = "<the output from 2>"` (the client id, a GUID, not the `api://` URI), then `terraform plan` and `terraform apply` from `infra/terraform/production`. The plan adds the worker: the identity `id-townwise-job-forecasts`, its AcrPull and `mongodb-uri` assignments, its "Townwise lab starter" assignment at the lab job, the job `caj-townwise-forecasts`, the deploy identity's assignment at it, and the three alerts. It also adds the lab: the identity, its AcrPull assignment, the role "Townwise lab starter", its assignment to the API's identity at the job, the deploy identity's assignment at the job, the job (lifecycle `Main`; `TOWNWISE_LAB_API_URL`, `AZURE_CLIENT_ID` and `TOWNWISE_LAB_TOKEN_RESOURCE` in its environment), and changes the Container App (`TOWNWISE_LAB_RUNNER=azure`, `TOWNWISE_LAB_JOB_ID`, `TOWNWISE_LAB_AUDIENCE`, `TOWNWISE_LAB_CALLER_ID`, `TOWNWISE_LAB_TENANT_ID`), which starts a new revision. `terraform output lab_job_id` prints the id. Terraform ignores later changes to the job's image (`ignore_changes` on the container image), so a plan after a release shows no drift; if a future provider stops honoring that for the job body, re-apply with the newest digest instead.
4. **Turn the deploy on.** Set the repository variable `LAB_ENABLED=true`. From the next release, the deploy points `caj-townwise-lab` at the new digest (with `az rest`, the same PATCH as `az containerapp job update --image`, whose wait the deploy role cannot follow) and waits until the job reports `Succeeded` with that image, then does the same for `caj-townwise-forecasts` with the API's digest. Both jobs must exist: a release with `LAB_ENABLED=true` and no worker job fails at that step (see 9).
5. **Check on a test organization with synthetic days.** Calibrate in the console (a location with at least the minimum history), and wait for the execution to succeed. Its console log has only `fetched input: N days` and `posted result: ok`, and `ContainerAppConsoleLogs | where ContainerName == "lab" | project TimeGenerated, Log` shows no figure, date or name (`lab` is the job's container name, which no other app or job in the environment uses). If the job cannot reach the API's default host name (it uses `https://<fqdn from terraform output container_app_fqdn>`), set its `TOWNWISE_LAB_API_URL` to `https://api.townwise.tech` in `lab.tf` and apply again. Then check the sign-in:
   - `az containerapp job execution show -n caj-townwise-lab -g rg-townwise-prod --job-execution-name <that execution> --query "properties.template.containers[0].env[].name"` lists only `TOWNWISE_LAB_API_URL`, `AZURE_CLIENT_ID`, `TOWNWISE_LAB_TOKEN_RESOURCE` and `TOWNWISE_LAB_CALIBRATION_ID`, and no value in it is a token.
   - `curl -i https://api.townwise.tech/lab/calibrations/<that calibration id>/input` with no `Authorization` header, and again with `-H 'Authorization: Bearer x.y.z'`: both 404. The API's console log has `townwise.lab_callback_refused` with `reason` `missing` and `malformed`, the route, and nothing else.
   - If the calibration fails instead, the API's log names the setting to check (see Logs). A job that could not sign in prints `failed: <error class>` and posts nothing, so its calibration shows `timeout` after 20 minutes.
   - The worker: `az containerapp job execution list -n caj-townwise-forecasts -g rg-townwise-prod --query "[0:3].{name:name, status:properties.status, start:properties.startTime, end:properties.endTime}" -o table` shows hourly executions that `Succeeded`. Record their length in Monthly cost. Measured locally on 2026-11-16 with the job's limits (0.25 vCPU and 512 MB, the amd64 image under emulation on an Apple M4 Max, an empty database), an execution took 21 to 25 seconds, almost all of it node's start, the Mongo connection and the index check; the pass itself took 0.1 to 0.2 seconds. `ContainerAppConsoleLogs | where Log has "townwise.weekly_refresh_pass" | project TimeGenerated, Log` shows one line an hour with `state` and counts only, never an id. After 03:00 on the first Monday in the town (resumed, if you paused), each due location's calibration shows "Started by Townwise (weekly)" in the console, charged nothing.
   - After the first release with `LAB_ENABLED` set, `az containerapp job show -n caj-townwise-lab -g rg-townwise-prod --query "properties.configuration.identitySettings"` still shows lifecycle `Main`, the container still has its three variables, and a production `terraform plan` shows no drift (the deploy's PATCH sends `configuration: {}` and has not yet run against a real lab job).
6. **Revoke the lab's sign-in at once, if ever needed.** `terraform apply -replace='azurerm_user_assigned_identity.lab[0]'` from `infra/terraform/production`: the new identity has a new object id, which Terraform writes into the API's `TOWNWISE_LAB_CALLER_ID`, so every token of the old one is refused (the API checks `oid`, not a role Entra caches). Setting `enable_lab = false` turns the lab and its callback off.
7. **Forecasts are on by default.** Every organization's forecasts are on unless staff switched them off (the console's switch reads "On (default)"), so from step 3 every organization whose draft passes the gate publishes, Sawtooth included. Before step 3, make sure the privacy page's forecasts paragraph (redrafted for D42) is live, and switch off in the console any organization whose owner did not agree. A switched-off organization's drafts stay drafts with their scorecards visible to staff.
8. **Delete old lab images now and then.** Every release pushes `townwise-lab:<sha>`, about 0.5 GB compressed (on Linux, xgboost brings NVIDIA's NCCL library, a 305 MB wheel), even while the lab is off, and its dependency layer is new each time because the build has no cache. The registry has no retention policy, Basic includes 10 GiB, and storage beyond that costs $0.10 per GB a month, so about twenty releases pass it. Keep the newest three (the job runs the newest once `LAB_ENABLED` is on; before that, also keep the `lab_image` digest) and delete the rest:

   ```sh
   az acr manifest list-metadata -r crtownwise2d2c15bf -n townwise-lab --orderby time_desc --query '[3:].digest' -o tsv \
     | while read -r d; do az acr manifest delete -r crtownwise2d2c15bf -n "townwise-lab@$d" --yes; done
   ```
9. **Add only the worker, if the lab was applied before it.** When step 3 ran from a commit without the worker, `terraform plan` shows the worker's ten resources (eleven with `enable_chat`), and nothing else should change. With `api_image` set as in step 3, apply exactly those from `infra/terraform/production`:

   ```sh
   terraform apply \
     -target='azurerm_user_assigned_identity.job["forecasts"]' \
     -target='azurerm_role_assignment.job_acr_pull["forecasts"]' \
     -target='azurerm_role_assignment.job_secret_read["forecasts/mongodb-uri"]' \
     -target='azurerm_role_assignment.job_secret_read["forecasts/anthropic-api-key"]' \
     -target='azurerm_role_assignment.forecasts_lab_start[0]' \
     -target='azapi_resource.job_forecasts[0]' \
     -target='azurerm_role_assignment.deployer_forecasts_job[0]' \
     -target='azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0]' \
     -target='azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing[0]' \
     -target='azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0]' \
     -target='azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0]'
   ```

   Then run a plain `terraform plan`, which should show no change. The worker exists only with `enable_lab = true`, so with the lab off these addresses plan nothing; the `anthropic-api-key` read exists only with `enable_chat = true` as well.
10. **Stop the weekly refresh.** There are three ways, and none cancels a live calibration. To stop it for everyone, staff pause it in the console (any organization's Forecasts section, Pause weekly refresh). The pause is audited and takes effect at the next hourly pass, which logs `state` `paused`. To stop one organization, switch its forecasts off in the console. That takes effect at once: no new start, and its drafts are held `forecasts_off`. To stop it at the deploy level, set `TOWNWISE_WEEKLY_FORECASTS=false` in `api/production.env` and release; the next pass logs `state` `off`. Setting `enable_lab = false` removes the worker, its identity, its grants and its alerts with the lab. Published runs stay (spec G3), and staff can withdraw any.

### 21. Calendar links

A location keeps its own calendars, each an imported file or a link (`api/README.md`, Owner calendars). Links are off until the API has `TOWNWISE_CALENDAR_KEY`, the AES-256-GCM key that seals each link's address in the database; off, adding a link answers 503 `calendar_links_unavailable` and no refresh runs, while calendar files still import. With it, the API fetches the addresses owners paste, from its own egress, which reaches the virtual network: the guards against request forgery are in code (`api/src/calendar/fetch.ts`).

`townwise-calendar-key` joins `api_secrets` only when `enable_calendar_links` is true (default false), so a release that carries this code deploys with links off. Seed the secret before turning it on: a Key Vault reference to a missing secret fails the new revision. A fresh build seeds it in step 5.

1. **Create and seed the key**, without it reaching argv, history or the terminal (`openssl` writes it to the pipe, and `set-secret.sh` hands it to `az keyvault secret set` on stdin):

   ```sh
   cd "$(git rev-parse --show-toplevel)"
   openssl rand -base64 32 | infra/scripts/set-secret.sh kv-townwise-2d2c15bf townwise-calendar-key
   ```

2. **Turn it on.** Add `enable_calendar_links = true` to `infra/terraform/production/terraform.tfvars`, then `terraform plan` and `terraform apply` from `infra/terraform/production`. The plan adds one role assignment (the app's identity reads `townwise-calendar-key` only) and changes the Container App (the `townwise-calendar-key` Key Vault reference and the `TOWNWISE_CALENDAR_KEY` env var), which starts a new revision. A value that is not 32 bytes of base64 stops the revision at boot with a `ConfigError` naming `TOWNWISE_CALENDAR_KEY`: seed it again and restart.
3. **Check.** Signed in as a member of a test organization, add a public test calendar's `.ics` link to a location (`POST /api/org/locations/<id>/owner-calendars` with `kind: 'link'`): it answers 201 with the link's host and event count, and no answer shows the address. About 6 hours later, `ContainerAppConsoleLogs | where Log has "townwise.calendar_refreshed"` shows its refresh, with the calendar id, the status code, counts and the duration only.

**Use it locally.** Developers use production's key (owner decision, 2026-11-16): `townwise-developers` has Key Vault Secrets User on `townwise-calendar-key` (only that secret, never the vault), granted by `infra/terraform/bootstrap`. The key unseals every stored link's address in production's database and, with Google calendars on, every Google connection's refresh token, so a laptop's `api/.env.local` holding it is as sensitive as that database: never copy it anywhere else, and treat a lost laptop as a leaked key (below). Each developer, signed in with `az login`, removes any earlier `TOWNWISE_CALENDAR_KEY` line from `api/.env.local`, writes the key there without it reaching the terminal, and restarts the API:

```sh
printf 'TOWNWISE_CALENDAR_KEY=%s\n' "$(az keyvault secret show --vault-name kv-townwise-2d2c15bf --name townwise-calendar-key --query value -o tsv)" >> api/.env.local
```

A local link or Google calendar sealed under a different key fails its next refresh with `key_mismatch` until it is added again.

**Never change the key.** A link sealed under one key opens under no other, so a new key makes every stored calendar link unreadable: each fails its next refresh with status `key_mismatch` until its owner adds it again (the events already stored stay). The key also seals every Google connection's refresh token and every Google calendar's id (step 22), so a new key breaks those too: each Google calendar fails with `key_mismatch` until its person removes it and adds it again, and a token the old key sealed can no longer be revoked from Townwise (the person can remove Townwise at myaccount.google.com/connections). Change it only if it leaks: seed a new one with the same command, run `az containerapp revision restart`, and ask the owners to add their links and Google calendars again.

### 22. Google calendars

An owner connects a location's Google calendars by signing in with Google, with read-only access (`api/README.md`, Owner calendars; openspec change `connect-google-calendar`). The API exchanges Google's code as a confidential client with the web client's secret, keeps Google's refresh token and each calendar's id sealed under `TOWNWISE_CALENDAR_KEY` (step 21), and reads only each event's id, status, title, start and end. Google calendars are on only when `TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID` (public, in `api/production.env`), `TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET` (the Key Vault secret `townwise-google-calendar-secret`) and `TOWNWISE_CALENDAR_KEY` are all set. With any of them unset the Calendar offers no Google action and the Google routes answer 503 `google_calendar_unavailable`, so the release that adds the id and the apply that adds the secret can land in either order. `townwise-google-calendar-secret` joins `api_secrets` only when `enable_google_calendar` is true (default false), and Terraform refuses that unless `enable_calendar_links` is true.

Calendar read scopes are sensitive, so Google reviews them. Until Google verifies the app (item 7), every connecting owner sees Google's "Google hasn't verified this app" screen and must choose to continue, and at most 100 people in total can grant it.

1. **Enable the Calendar API.** In Google Cloud console, in the project that holds the OAuth clients (step 11), enable **Google Calendar API**.
2. **Add the scopes, and keep the project in production.** In Google Auth Platform (the OAuth consent screen), Data Access, add `https://www.googleapis.com/auth/calendar.calendarlist.readonly` and `https://www.googleapis.com/auth/calendar.events.readonly` (Townwise also asks for `openid`, which is not sensitive). Under Audience, confirm the publishing status is **In production**. Never change the production project's publishing status: it is the whole project's, so Testing would block sign-in for everyone who is not a listed test user (and a Testing screen's refresh tokens end after 7 days). Try the flow locally with a separate development project, never by switching this one.
3. **Seed the client secret.** On the web client's page (Clients, the web client from step 11), press **Add Secret**. Google keeps at most two secrets per client and shows a new one in full only once, so the original secret most likely can't be copied now. Paste the new secret straight into the hidden prompt, so it never reaches argv, history or the terminal:

   ```sh
   cd "$(git rev-parse --show-toplevel)"
   infra/scripts/set-secret.sh kv-townwise-2d2c15bf townwise-google-calendar-secret
   ```

   Seed it **before** item 5: a Key Vault reference to a missing secret fails the new revision. **Rotate** by adding a new secret on the same page and seeding it the same way. Google accepts both secrets while both are enabled, and Container Apps picks up the new version within about 30 minutes on its own (step 5), so a restart sooner can still run on the old one. Wait those 30 minutes (then `az containerapp revision restart` if you like), confirm a Google call works ("Refresh now" on a Google calendar, `POST .../owner-calendars/<id>/refresh`, answers 200 with `status` `ok`, and no `townwise.google_calendar_failed` line has code `invalid_client`), and only then disable the old one in Google Cloud. Disabled sooner, every exchange and refresh fails with `invalid_client` until the app has the new one.
4. **Set the client id, in a release.** Uncomment `TOWNWISE_GOOGLE_CALENDAR_CLIENT_ID` in `api/production.env`: the web client's id, which must be one of `AUTH_GOOGLE_CLIENT_IDS` (any other stops the revision at boot with a `ConfigError` naming the variable). Google calendars stay off after this release, since the app has no secret yet.
5. **Turn it on.** With `enable_calendar_links = true` already applied (step 21), add `enable_google_calendar = true` to `infra/terraform/production/terraform.tfvars`, then `terraform plan` and `terraform apply` from `infra/terraform/production`. The plan adds one role assignment (the app's identity reads `townwise-google-calendar-secret` only) and changes the Container App (the `townwise-google-calendar-secret` Key Vault reference and the `TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET` env var), which starts a new revision with Google calendars on.
6. **Check** on `https://townwise.tech` with the browser console open, signed in as a member of a test organization, with a Google account that has never granted Townwise calendar access:
   - **The exchange.** On the Calendar, open Your calendars, Add a Google calendar, then Continue to Google: after Google's consent the picker lists the account's calendars. That answer means Google accepted `redirect_uri=postmessage` (`POPUP_REDIRECT_URI` in `api/src/calendar/google.ts`) and returned a refresh token; with none, the connect would have answered 409 `google_connect_again`. A 503 `google_unavailable` logs `townwise.google_calendar_failed` with `op` `token`: code `invalid_client` means the id or the secret is wrong, and code `unavailable` with status 400 most likely means Google refused the `redirect_uri`, so try the page's origin, `https://townwise.tech`, there in a release. Record which value Google accepted.
   - **The refresh.** Add one calendar: it answers 201 with its event count, and no answer shows its Google calendar id. About 6 hours later, `ContainerAppConsoleLogs | where Log has "townwise.calendar_refreshed"` shows its refresh, with the calendar id, the status code, counts and the duration only.
   - **The CSP.** No CSP violation in the browser console through the whole flow. A new Google origin updates `client/MODULE.md` (Security), `infra/web/staticwebapp.config.json` and the tftest's CSP assertion together.
7. **Submit verification** in Google Auth Platform, Verification Center. Google says it can take up to 10 days.
   - **Domain.** Verify `townwise.tech` in Google Search Console. Verified by DNS, its TXT value goes in `azurerm_dns_txt_record.apex` (`infra/terraform/production/dns.tf`), applied with Terraform: Terraform owns that record set, so a record added by hand is removed by the next apply. The same change adds the `google-site-verification=...` value to the `dns_and_email` run's apex assertion (and its error message) in `infra/terraform/production/tests/production.tftest.hcl`, which pins that record set exactly, or `terraform test` fails. The value is a public verification token, so it can be committed.
   - **Pages.** The home page `https://townwise.tech` and the privacy policy `https://townwise.tech/privacy`, both on the verified domain and linked from the consent screen's Branding. The privacy page must already say what Townwise reads from Google and carry Google's Limited Use statement.
   - **Scope justifications**, one for each calendar scope: "show the restaurant's own bookings and events on its forecast calendar; read-only".
   - **A demo video**, unlisted: the connect flow, where the data appears (the Calendar and TownwiseAI), and a view-as showing a Google calendar without its names and titles.

   The justifications and the video both say how staff view-as treats Google data: under view-as a Google calendar shows as "Google calendar" and its events as "Google calendar event", staff never see the person's list of Google calendars, and the person agrees at connect that staff may read TownwiseAI replies that mention an event.

**Turn it off** with `enable_google_calendar = false` and apply: the secret leaves the app, Google calendars fail their refreshes with `google_unavailable` and keep their events, and removing one still revokes its access, since revoking needs only the stored token and `TOWNWISE_CALENDAR_KEY`. **Before rolling back across this change** (redeploying an image older than it, step 13), remove every Google calendar, which revokes its access: an older image never refreshes a Google calendar or revokes a grant, and its client refuses a location that holds one ("Couldn’t load your calendars"). **To abandon the feature**, remove every Google calendar while this image runs with `TOWNWISE_CALENDAR_KEY` set, confirm `tw_google_connections` is empty (for example in a dump restored beside the live data, step 14), then turn the flag off; the empty collection can then be dropped.

## Releases

A release is a release PR merging `develop` into `main`. The merge deploys through `deploy.yml`; while hosted Actions is blocked, the release is deployed by hand instead (as `v2026.11.11` was). Once the new revision is confirmed live, the release gets an annotated tag and a GitHub Release (owner decision, 2026-11-12; every release since `v2026.11.04` has one).

- **Name:** `v` plus the merge commit's date in Hanover (America/New_York), `vYYYY.MM.DD`. A second release that day ends in `.2`, then `.3` (2026-11-05 ran from `v2026.11.05` to `v2026.11.05.9`).
- **Target:** the release PR's merge commit on `main`.
- **Notes:** the release PR and how it deployed (a link to the deploy run, or "deployed by hand"), then GitHub's generated list of the PRs since the previous release.

```sh
git fetch origin --tags
sha=$(git rev-parse origin/main)    # the release PR's merge commit
day=v$(TZ=America/New_York git show -s --format=%cd --date=format-local:%Y.%m.%d "$sha")
n=$(git ls-remote --tags --refs origin "$day" "$day.*" | wc -l | tr -d ' ')
tag=$day; [ "$n" -gt 0 ] && tag="$day.$((n + 1))"
prev=$(gh release view --json tagName --jq .tagName)    # the latest release
git tag -a "$tag" "$sha" -m "$tag: <release PR title> (#<PR>)"
git push origin "refs/tags/$tag"
gh release create "$tag" --verify-tag --title "$tag: <what shipped>" --notes-start-tag "$prev" \
  --notes "Release PR: #<PR>. Deployed by the [deploy workflow](<run URL>)." --generate-notes
```

A tag push starts no workflow: `ci.yml` and `deploy.yml` run on branch pushes only.

## CI on the laptop runner

GitHub-hosted runners are blocked for this private repository: every job fails at once with "The job was not started because recent account payments have failed or your spending limit needs to be increased". Self-hosted runners are free, so the owner decided (2026-11-11) to run the checks on the owner's Mac (Apple Silicon, Docker Desktop) until hosted runners are back. The pieces are in `infra/ci-runner/`.

**What runs there:** every job of `ci.yml` (verify, terraform, id-token-guard, lab), `security.yml` (osv-scanner, semgrep, checkov) and `gitleaks.yml` (gitleaks), while the `CI_RUNS_ON` repository variable points there. On an ARM64 runner the workflows download the arm64 builds of tflint, osv-scanner and gitleaks, each checked against its release's published SHA-256.

**What never runs there: `deploy.yml`.** Its build jobs run npm and repository code with no id-token, and its deploy job holds the OIDC token. On fresh GitHub-hosted VMs they cannot reach each other; on one Docker host a build job could reach the deploy job's container. `deploy.yml` keeps a literal `runs-on: ubuntu-24.04` and never reads `CI_RUNS_ON`, and `id-token-guard` fails unless every job in it has exactly `runs-on: ubuntu-24.04` (an allowlist: no expression, no `self-hosted`, no list, no other `ubuntu-*` name). Never give a self-hosted runner an `ubuntu-*` label: GitHub does not document whether a job asking for a hosted label can land on a self-hosted runner that carries it. `run-runners.sh` registers only `self-hosted` and `townwise-laptop`. While hosted runners are blocked, `deploy.yml` cannot run, so deploys stay manual.

**How it works.** `infra/ci-runner/run-runners.sh` keeps N slots (default 2). Each slot asks GitHub for a just-in-time runner config (`generate-jitconfig`, labels `self-hosted` and `townwise-laptop`, runner group 1, named `townwise-laptop-<session>-<slot>-<n>`) and starts a fresh container from the image built from `infra/ci-runner/Dockerfile` (Ubuntu 24.04 for arm64, the Actions runner, the Docker CLI and buildx, and what the jobs call), by the image ID the session resolved at start, so a job that retags `townwise-ci-runner:local` does not change what later runners run. Each container gets:

- the config in an environment variable: never on a command line, in the terminal or in a file the script writes;
- the Docker socket, for testcontainers, the lab job's `docker build`, and semgrep and checkov (`docker run`);
- a fresh folder under `~/.townwise-ci/jobs` (`~/.townwise-ci` is mode 700: the folders hold checkouts and runner credentials), mounted at the same path. The runner runs from there, so `GITHUB_WORKSPACE` is a real Mac path. That matters because the Docker daemon resolves `docker run -v "$GITHUB_WORKSPACE:/src"` (semgrep, checkov) on the Mac, not inside the runner's container; a path that exists only in the container is refused ("mounts denied");
- `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal`, so the integration tests reach Mongo and Valkey on their mapped ports.

The runner takes one job and exits, and GitHub removes its registration. The script then removes the container and the folder and starts the slot's next runner.

**Start** it in a terminal. You need Docker Desktop running with File sharing set to `~/.townwise-ci` only (see Security), and `gh` signed in as a repository admin (`generate-jitconfig` requires admin):

```sh
infra/ci-runner/run-runners.sh                              # builds townwise-ci-runner:local, 2 slots
infra/ci-runner/run-runners.sh -n 1                         # one job at a time
infra/ci-runner/run-runners.sh -i townwise-ci-runner:local  # skip the build
caffeinate -i infra/ci-runner/run-runners.sh                # keep the Mac awake while it runs
```

One session runs at a time: a second start refuses while one is running (a lock in `~/.townwise-ci`). At start the script removes what earlier sessions left behind (job folders, runner containers, offline `townwise-laptop-*` registrations), which only a second Ctrl-C, a crash or a reboot leaves. It warns when 127.0.0.1 answers on 27017, 6379, 10000 or 8080 (see Security). Then it prints a line when each runner starts waiting, the runner's own console lines (the job it took and the result), and a line when each finishes. Job logs stay on GitHub.

**Point CI at it, and switch back:**

```sh
gh variable set CI_RUNS_ON -R engg-119/engg-119-mvp --body '["self-hosted","townwise-laptop"]'
gh variable delete CI_RUNS_ON -R engg-119/engg-119-mvp    # back to ubuntu-24.04
```

Every job in the three workflows has `runs-on: ${{ fromJSON(vars.CI_RUNS_ON || '"ubuntu-24.04"') }}` (GitHub allows the `vars` context in `runs-on`), so the value must be JSON: a list of labels or a quoted string. A change applies to workflow runs started after it. A job waiting for a laptop runner that never comes is canceled after 24 hours in the queue.

**Stop** with Ctrl-C. It removes every runner container (a job still running fails; re-run it), the job folders, and every registration of the session still on GitHub, then exits with status 130. A second Ctrl-C exits at once, and the next start removes what is left. Delete `CI_RUNS_ON` too if the runner stays off, or new runs queue for it. To check nothing is left:

```sh
gh api repos/engg-119/engg-119-mvp/actions/runners --jq '.runners[] | "\(.id) \(.name) \(.status)"'
docker ps -a --filter label=townwise-ci-session
```

Remove a leftover registration with `gh api -X DELETE repos/engg-119/engg-119-mvp/actions/runners/<id>`.

**Security:**

- The repository is private and only the owner has write access, so only the owner's pushes and pull requests run here. Pull requests from forks are the exception. Variables are not sent to them (step 12 keeps "Send secrets and variables to workflows from fork pull requests" off), so their jobs fall back to `ubuntu-24.04`; but a fork's pull request runs its own copy of the workflows and can set `runs-on` to the laptop's labels. Step 12 keeps "Require approval for fork pull request workflows" on, so a fork's workflows run only once the owner approves them. Approving one while the runner is in use runs its code on this Mac with the reach described below: read the whole diff, not only the workflows, first.
- Each job gets a fresh container from the image, a fresh folder, and a just-in-time registration that takes exactly one job. A job can read its own runner's config and credentials (they are in its container and folder, as on any self-hosted runner); they register only that one runner.
- **The Docker socket is root on Docker Desktop's VM, and Docker Desktop shares `/Users` with that VM** (by default also `/Volumes`, `/private`, `/tmp` and `/var/folders`). So any job can start a privileged container, read every container's environment and files (the other slot's runner config included), and read and write your home folder: SSH keys, Azure CLI and other tokens, other checkouts. That is the trust you give a branch when you run its tests on the Mac, except that here it runs without you starting it. So `run-runners.sh` refuses to start unless Docker Desktop shares only `~/.townwise-ci` (Settings, Resources, File sharing, then Apply & restart; the checks need nothing else). It reads the saved list (`FilesharingDirectories` in `~/Library/Group Containers/group.com.docker/settings-store.json`; unset means the defaults), then checks with throwaway containers that the change is applied: one that mounts `~/.townwise-ci` must see the job folders, and one that mounts the home folder must be refused. While the list is narrowed, `docker run -v` of any other Mac folder is refused too (the dev stack's `compose.yaml` uses named volumes only, so it is unaffected); restore the defaults when the runner is off for good.
- What Docker keeps outlives the job: pulled images, build cache, and containers a job leaves running (CI turns testcontainers' Ryuk off, so a canceled run can leave Mongo or Valkey up: `docker ps --filter label=org.testcontainers=true`). One job can tamper with what later jobs on the laptop see, so a result from the laptop is only as trustworthy as every job that ran there before it. The same holds for anything else built on this Docker Desktop: it shares the image store and build cache with every job, and a job is root in the VM that holds them. That includes a release image built here by hand, as step 6's laptop fallback does, while the runner is or has been in use; such an image is only as trustworthy as every job that ran on the laptop. [DECISION NEEDED: where release images are built while the laptop runner is or has been in use.] Each session runs its runner image by ID, so retagging `townwise-ci-runner:local` does not reach later runners, but root in the VM could still change the image itself.
- Every job reaches every service listening on the Mac's loopback through `host.docker.internal` (testcontainers needs that name, and a job holding the socket can pick any network): the dev stack's Mongo on 27017 (no authentication), Valkey on 6379 and Azurite on 10000, the local API on 8080, and anything else running. Stop the dev stack (`docker compose down`), the local API and other local services while the runner runs; `run-runners.sh` warns at start when 27017, 6379, 10000 or 8080 answers on 127.0.0.1.
- Testcontainers publish their ports on all of the Mac's interfaces (0.0.0.0), so while a job runs, and after a canceled one, its test Mongo and Valkey (no authentication, test data only) are reachable from the local network unless the macOS firewall blocks incoming connections. Keep the firewall on (System Settings, Network, Firewall) while the runner runs.
- The script creates and deletes registrations with your `gh` session; that token never enters a container.
- `deploy.yml` never runs here (above), and the deploy identity trusts only `deploy.yml` on `main` (step 12).

**Resources.** Each slot gets its own four of the VM's CPUs, so Jest and Vitest start as many workers as on a 4-vCPU runner (with all 16, one verify job peaked near 14 GiB and the VM killed a Jest worker). Measured on 2026-11-11 with two verify jobs at once, the heaviest case: about 10.5 minutes each, up to 6.3 GiB each plus their Mongo and Valkey, 12.4 GiB together of the VM's 15.6 GiB. A verify job's folder holds about 1 GB (mostly `node_modules`) until the job ends. The other jobs take under two minutes each. If Docker Desktop runs other containers, or the Mac needs its memory, use `-n 1` or give Docker Desktop more memory. The image is about 1.2 GB. Docker keeps the images the jobs pull (semgrep 1.6 GB, Mongo 1.3 GB, checkov 0.8 GB, Azurite 0.6 GB, and smaller ones) and the lab job's build cache; `docker image prune` and `docker builder prune` reclaim space.

## Logs

Container Apps and Key Vault `AuditEvent` logs go to `log-townwise`, capped at 0.1 GB a day to stay inside the 5 GB monthly free ingestion. `AuditEvent` also goes to `sttwaudit2d2c15bf`, which has no cap, keeps it for a year, and admits only Azure Monitor, so spending the cap cannot blind the audit trail. When the cap is reached, ingestion stops until the daily reset, and the alert `townwise-log-daily-cap-reached` emails `alert_email`. A flood of rate-limited requests logs one line per `429`, which can spend the cap; excluding 429s from the request log is an upstream suggestion for the kit's `server-core`, not changed here.

The forecast lab's callback logs `townwise.lab_callback_refused { route, reason }` for each refused call (never an id or a token). `not_live` (a signed-in caller named no live calibration, or one whose input was already fetched) and `result_token` (a result whose token is missing or not that calibration's) come after a good sign-in. A job whose calibration timed out gets one; an unexplained run of them means something signed in as the lab identity may be probing calibrations (known risks). `/lab` has no limiter of its own, only the app-wide ceiling of 2,000 requests a minute per IP (`app:api-ceiling`), so refused calls can add log volume toward the daily cap. On a calibration that should have worked, the sign-in reason points at the setting: `issuer` (a v1 token: the lab callback app's `requested_access_token_version` is not 2, or `TOWNWISE_LAB_TENANT_ID` is wrong), `audience` (`TOWNWISE_LAB_AUDIENCE` is not the app's client id, or the job's `TOWNWISE_LAB_TOKEN_RESOURCE` names another app), `tenant` (`TOWNWISE_LAB_TENANT_ID`), `caller` (`TOWNWISE_LAB_CALLER_ID` is not the lab identity's principal id, or the job asked as another identity: `AZURE_CLIENT_ID`), `expired` (clock), `signature` (a token not from Entra), `missing` or `malformed` (not the job). `townwise.lab_callback_unavailable` (a warning) means the API could not fetch Entra's signing keys from `login.microsoftonline.com`; both routes answer 503 meanwhile. Entra caches managed identity tokens for about 24 hours per resource, so a change to the app registration or to `TOWNWISE_LAB_TOKEN_RESOURCE` can take that long to reach the job's tokens.

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
| Weekly forecast worker, when on (step 20): 730 executions a month, about 25 seconds each at 0.25 vCPU and 0.5 GiB (measured locally, step 20, 5) | active rates | about $0.14 |
| Scheduled calibrations, when on (step 20): at most one a week per location whose data changed, roughly 200 a week at most | the lab's, above | about $0.13 a location; at most about $26 at the cap |
| Backup storage, Hot LRS, 30 dumps kept | $0.0208 per GB a month, writes $0.05 per 10,000 | about $0.03 at 50 MB a dump |
| Container Registry Basic, 10 GiB included | $0.1666 a day; storage beyond 10 GiB $0.10 per GB a month | $5.07, while old lab images are deleted (step 20) |
| Azure DNS zone | $0.50 per zone (queries $0.40 per million) | $0.50 |
| Key Vault | $0.03 per 10,000 operations | about $0.02 |
| Log Analytics | first 5 GB a month free; the 0.1 GB daily cap keeps ingestion under it | $0 |
| Daily-cap alert, a log search rule every 15 minutes | $0.50 a rule | $0.50 |
| Backup-missing alert, a log search rule every 6 hours | $0.50 a rule | $0.50 |
| Weekly forecast worker alerts, when on (step 20): four log search rules, three hourly and one every 6 hours | $0.50 a rule | $2.00 |
| Key Vault audit archive, Hot LRS, a year kept | $0.0208 per GB a month | under $0.05 |
| Static Web Apps Free | | $0 |
| Communication Services email | $0.00025 per message plus $0.00012 per MB | about $0.25 per 1,000 emails |
| State storage | | under $0.05 |
| **Total** | | **about $58.40 at low traffic** |

The lines marked "when on (step 20)" are not in the total. With the lab on and a handful of locations, they add about $2.15 for the worker and its alerts plus about $0.13 a location.

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
- **The laptop runner** (CI on the laptop runner): while `CI_RUNS_ON` points at it, code a CI job runs has root on Docker Desktop's VM and, through Docker's file sharing, the owner's home folder. Only the owner's code runs there, unless the owner approves a fork pull request's workflows (step 12 requires approval).
- **Client files behind a private endpoint.** With public network access disabled, any provider call that touched the files account's data plane from a laptop or runner would fail. azurerm 5.11 manages the containers and the lifecycle rule through Resource Manager (`data_plane_available = false`), but CI's mocked plan cannot prove it; the first real apply in step 18 does.
- **Platform-managed group.** `rg-townwise-prod-infra` holds the environment's load balancer and public IPs. Do not edit it; it goes with the environment.
- **The lab identity's token is not tied to one calibration** (step 20). It lives about 24 hours, and the callback accepts it for any live calibration. The input is fetched once, and a result needs the result token the input answer hands whoever fetched it. So code running as the lab identity (a compromised lab image, or anyone who can start or update the job) that fetches a sibling calibration's input first, in its unfetched window before that calibration's own job does, can read that input and post a forged result for it: the result is stored as a draft run for that calibration's location, in whichever organization it belongs to, and becomes a published forecast if its scorecard passes the gate and that organization's forecasts are switched on. The calibration's own job then finds its fetch refused (`not_live` in the log, see Logs). It cannot fetch an input twice, or post a result for a calibration whose input it did not fetch. The exposure is no worse than before this change: a compromised lab image already runs every calibration and can forge any result it computes. Binding each fetch to its Container Apps execution (the job sends `CONTAINER_APP_JOB_EXECUTION_NAME`, and the API checks that execution through Resource Manager, which needs `Microsoft.App/jobs/executions/read` for the API identity) is deferred: the owner decided so on 2026-11-10 and re-confirmed it on 2026-11-11. Revoke with step 20.6.
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
