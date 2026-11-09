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
    # Developers read configuration and logs. Reader includes no Key Vault data actions, no listSecrets on
    # the Container App and no listKeys on Communication Services, and cannot change secrets or identities.
    developers_prod_reader = { group = "developers", scope = azurerm_resource_group.prod.id, role = "Reader" }
    developers_prod_logs   = { group = "developers", scope = azurerm_resource_group.prod.id, role = "Log Analytics Reader" }
    # One secret: the shared Anthropic key for local development, capped by its own Anthropic workspace
    # (infra/README.md, step 16). Seed it before applying; the assignment is scoped to the secret.
    developers_dev_key = { group = "developers", scope = "${azurerm_resource_group.prod.id}/providers/Microsoft.KeyVault/vaults/kv-townwise-${local.suffix}/secrets/anthropic-dev-key", role = "Key Vault Secrets User" }
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
