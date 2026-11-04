# Townwise owns two resource groups and touches nothing else in the subscription (the existing
# "Dartmouth" and "cameronkeith" groups are unrelated). This stack holds the Terraform state account,
# the CI identities and the team's access; production/ holds the app.

data "azuread_client_config" "current" {}

locals {
  suffix        = substr(replace(var.subscription_id, "-", ""), 0, 8)
  state_account = "sttwtfstate${local.suffix}"
  # Production state in "tfstate". Bootstrap state, which names the team groups and the applier, in
  # "tfstate-admin", so a future read-only plan identity can be given "tfstate" alone.
  state_containers = ["tfstate", "tfstate-admin"]
}

resource "azurerm_resource_group" "bootstrap" {
  name     = "rg-townwise-bootstrap"
  location = var.location
}

resource "azurerm_resource_group" "prod" {
  name     = "rg-townwise-prod"
  location = var.location
}

# The queue service is unused (only blobs hold state), so queue logging records nothing.
# nosemgrep: terraform.azure.security.storage.storage-queue-services-logging.storage-queue-services-logging
resource "azurerm_storage_account" "state" {
  name                              = local.state_account
  resource_group_name               = azurerm_resource_group.bootstrap.name
  location                          = azurerm_resource_group.bootstrap.location
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "LRS"
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  allow_nested_items_to_be_public   = false
  shared_access_key_enabled         = false
  default_to_oauth_authentication   = true
  local_user_enabled                = false
  sftp_enabled                      = false
  cross_tenant_replication_enabled  = false
  infrastructure_encryption_enabled = true
  #checkov:skip=CKV_AZURE_43:the name is computed from a local (sttwtfstate2d2c15bf), which checkov cannot evaluate; it is 19 lowercase letters and digits
  #checkov:skip=CKV_AZURE_33:queue service is unused; only blobs hold state
  #checkov:skip=CKV_AZURE_59:Terraform runs from laptops and GitHub-hosted runners with no fixed IPs; access is Entra RBAC only (shared keys disabled)
  #checkov:skip=CKV_AZURE_206:LRS is enough for state, which is versioned with soft delete; GRS doubles the cost
  #checkov:skip=CKV2_AZURE_1:Microsoft-managed keys; a customer-managed key adds a Key Vault dependency to the bootstrap for no threat-model gain
  #checkov:skip=CKV2_AZURE_33:no private endpoint (see CKV_AZURE_59)
  #checkov:skip=CKV2_AZURE_41:shared keys are disabled, so no SAS can be signed with them

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = 30
    }

    container_delete_retention_policy {
      days = 30
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "state" {
  for_each              = toset(local.state_containers)
  name                  = each.key
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
  #checkov:skip=CKV2_AZURE_21:blob read logging needs a Log Analytics workspace in bootstrap; state access is Entra RBAC only and recorded in the Azure activity log

  lifecycle {
    prevent_destroy = true
  }
}

# The applier needs data-plane access to migrate and use the state; the admins group gets the same.
resource "azurerm_role_assignment" "state_applier" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azuread_client_config.current.object_id
}
