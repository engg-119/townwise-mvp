# Team access through Entra groups, scoped to the Townwise resource groups only (never the subscription).
# Teammates are invited as B2B guests and added to a group by hand (infra/README.md); no addresses here.

resource "azuread_group" "team" {
  for_each = {
    admins         = "Townwise administrators: Owner on the Townwise resource groups and the Terraform state"
    developers     = "Townwise developers: read-only on production, plus logs"
    secrets-admins = "Townwise secrets admins: set and rotate Key Vault secret values"
  }
  display_name            = "townwise-${each.key}"
  description             = each.value
  security_enabled        = true
  prevent_duplicate_names = true
  owners                  = [data.azuread_client_config.current.object_id]
}

# The applier administers Townwise.
resource "azuread_group_member" "applier_admin" {
  group_object_id  = azuread_group.team["admins"].object_id
  member_object_id = data.azuread_client_config.current.object_id
}

locals {
  team_roles = {
    admins_bootstrap_owner = { group = "admins", scope = azurerm_resource_group.bootstrap.id, role = "Owner" }
    admins_prod_owner      = { group = "admins", scope = azurerm_resource_group.prod.id, role = "Owner" }
    admins_state_data      = { group = "admins", scope = azurerm_storage_account.state.id, role = "Storage Blob Data Contributor" }
    # Admins read the nightly database dumps, so infra/scripts/db-pull-prod.sh can restore one into a local copy
    # (owner, 2026-11-18). Read only, on the dump container alone; the dumps stay write-once. Production creates the
    # account and container (backup.tf), so apply this after production's first apply.
    admins_backup_reader = { group = "admins", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.Storage/storageAccounts/sttwbackup${local.suffix}/blobServices/default/containers/mongodump", role = "Storage Blob Data Reader" }
    # Developers read configuration and logs. Reader includes no Key Vault data actions, no listSecrets on
    # the Container App and no listKeys on Communication Services, and cannot change secrets or identities.
    developers_prod_reader = { group = "developers", scope = azurerm_resource_group.prod.id, role = "Reader" }
    developers_prod_logs   = { group = "developers", scope = azurerm_resource_group.prod.id, role = "Log Analytics Reader" }
    # One secret: the shared Anthropic key for local development, capped by its own Anthropic workspace
    # (infra/README.md, step 16). Seed it before applying; the assignment is scoped to the secret.
    developers_dev_key = { group = "developers", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.KeyVault/vaults/kv-townwise-${local.suffix}/secrets/anthropic-dev-key", role = "Key Vault Secrets User" }
    # The Places search's three secrets, shared with production (infra/README.md, step 17), so developers can run the
    # search and its map locally. Seed them before applying; each assignment is scoped to its secret.
    developers_maps_signing_secret = { group = "developers", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.KeyVault/vaults/kv-townwise-${local.suffix}/secrets/google-maps-signing-secret", role = "Key Vault Secrets User" }
    developers_maps_static_key     = { group = "developers", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.KeyVault/vaults/kv-townwise-${local.suffix}/secrets/google-maps-static-key", role = "Key Vault Secrets User" }
    developers_places_key          = { group = "developers", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.KeyVault/vaults/kv-townwise-${local.suffix}/secrets/google-places-api-key", role = "Key Vault Secrets User" }
    # Production's calendar key, shared by the owner's decision (2026-11-16) so local calendar links and Google
    # calendars use the same key as production (infra/README.md, step 21). It unseals every stored link and Google
    # token in production's database, so a laptop holding it is as sensitive as that database. Scoped to the secret.
    developers_calendar_key = { group = "developers", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.KeyVault/vaults/kv-townwise-${local.suffix}/secrets/townwise-calendar-key", role = "Key Vault Secrets User" }
    # The public Google web client id and the calendar client secret. Local `npm run dev` and `npm start` read
    # these (and the secrets above) from Key Vault when .env.local left them empty, and do not write them back.
    # Seed google-web-client-id before applying; the calendar secret is the one step 22 of the runbook seeds.
    developers_google_web_client_id = { group = "developers", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.KeyVault/vaults/kv-townwise-${local.suffix}/secrets/google-web-client-id", role = "Key Vault Secrets User" }
    developers_google_calendar_secret = { group = "developers", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.KeyVault/vaults/kv-townwise-${local.suffix}/secrets/townwise-google-calendar-secret", role = "Key Vault Secrets User" }
    # The event scout's search service (production/search.tf): read and write documents in its indexes, on that
    # service alone; no control-plane role, so developers cannot change or delete the service or its indexes. Apply
    # after production creates the service with enable_event_search.
    developers_event_search = { group = "developers", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.Search/searchServices/srch-townwise-${local.suffix}", role = "Search Index Data Contributor" }
    # The production group holds one vault, so this is that vault's secrets.
    secrets_admins_reader  = { group = "secrets-admins", scope = azurerm_resource_group.prod.id, role = "Reader" }
    secrets_admins_officer = { group = "secrets-admins", scope = azurerm_resource_group.prod.id, role = "Key Vault Secrets Officer" }
  }
}

resource "azurerm_role_assignment" "team" {
  for_each             = local.team_roles
  scope                = each.value.scope
  role_definition_name = each.value.role
  principal_id         = azuread_group.team[each.value.group].object_id
  principal_type       = "Group"
}
