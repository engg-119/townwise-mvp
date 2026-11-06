# Client files: the sales exports and spreadsheets restaurants drop into Townwise (docs/portal/spec.md 11A). One
# account for every organization; each organization's blobs live under its own id, `{orgId}/{locationId}/{fileId}`,
# and the API builds every name from the caller's OrgScope (api/src/files/blobs.ts). Raw exports hold other people's
# personal data (diner names and phones, server names, card brands), so the account has no public endpoint at all:
# public network access is disabled, the firewall denies everything, and the API reaches it only through a private
# endpoint in the endpoints subnet (443 from the apps subnet, network.tf). Entra ID only: shared keys are off, so no
# account SAS can exist, and the API's role has no generateUserDelegationKey, so no user delegation SAS either.
#
# Models never live here. When forecasts need stored models, they get their own account (sttwmodels{suffix}) that
# the API identity holds no role on and the API image never names; only a dedicated job identity and the
# administrators group may reach it. tests/production.tftest.hcl (client_files) fails the moment the API identity
# holds a storage role on anything but the two containers below.
#
# The queue service is unused, so queue logging records nothing. There is no trusted-service bypass on purpose: only
# the API, through the private endpoint, reaches client files.
# nosemgrep: terraform.azure.security.storage.storage-queue-services-logging.storage-queue-services-logging, terraform.azure.security.storage.storage-allow-microsoft-service-bypass.storage-allow-microsoft-service-bypass
resource "azurerm_storage_account" "files" {
  name                              = "sttwfiles${local.suffix}"
  resource_group_name               = local.rg
  location                          = local.location
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "LRS"
  access_tier                       = "Hot"
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  allow_nested_items_to_be_public   = false
  shared_access_key_enabled         = false
  default_to_oauth_authentication   = true
  local_user_enabled                = false
  sftp_enabled                      = false
  cross_tenant_replication_enabled  = false
  infrastructure_encryption_enabled = true
  public_network_access             = "Disabled"
  #checkov:skip=CKV_AZURE_43:the name is computed from a local (sttwfiles2d2c15bf), which checkov cannot evaluate; it is 17 lowercase letters and digits
  #checkov:skip=CKV_AZURE_33:queue service is unused; only blobs hold client files
  #checkov:skip=CKV_AZURE_206:LRS: originals are the restaurant's own exports, which it keeps; GRS doubles the cost
  #checkov:skip=CKV2_AZURE_1:Microsoft-managed keys; a customer-managed key adds a Key Vault dependency for no threat-model gain
  #checkov:skip=CKV2_AZURE_41:shared keys are disabled, so no SAS can be signed with them
  #checkov:skip=CKV2_AZURE_38:soft delete is on (7 days); versions would keep client data after a deletion request
  #checkov:skip=CKV_AZURE_59:public_network_access is "Disabled" (the azurerm 5 attribute this check does not read); the private endpoint is the only way in
  #checkov:skip=CKV_AZURE_36:no trusted-service bypass on purpose: only the API, through the private endpoint, reaches client files; diagnostic logs need no bypass

  # No subnet or IP rules and no trusted-service bypass: the private endpoint is the only way in. Diagnostic logs are
  # Azure Monitor resource logs and need no data-plane bypass.
  network_rules {
    default_action = "Deny"
    bypass         = ["None"]
  }

  blob_properties {
    # Versions and the change feed would keep deleted client data, so both stay off.
    versioning_enabled  = false
    change_feed_enabled = false

    delete_retention_policy {
      days = 7
    }

    container_delete_retention_policy {
      days = 7
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Two containers, not prefixes, so the lifecycle rule targets originals only and each role assignment covers one.
# Blob names are ids only; no original file name or metadata ever reaches storage.
resource "azurerm_storage_container" "client_raw" {
  name                  = "client-raw"
  storage_account_id    = azurerm_storage_account.files.id
  container_access_type = "private"
  #checkov:skip=CKV2_AZURE_21:blob reads, writes and deletes are logged to the audit account by azurerm_monitor_diagnostic_setting.files_blob

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "client_clean" {
  name                  = "client-clean"
  storage_account_id    = azurerm_storage_account.files.id
  container_access_type = "private"
  #checkov:skip=CKV2_AZURE_21:blob reads, writes and deletes are logged to the audit account by azurerm_monitor_diagnostic_setting.files_blob

  lifecycle {
    prevent_destroy = true
  }
}

# Exactly what the API does with client files: read and list, stage and commit blocks, put, delete. No actions, so
# no container create or delete, and no generateUserDelegationKey, so the API cannot mint a SAS.
resource "azurerm_role_definition" "client_files" {
  name              = "Townwise client files"
  scope             = data.azurerm_resource_group.prod.id
  description       = "Read, write and delete blobs in the Townwise client file containers; no SAS, no container changes."
  assignable_scopes = [data.azurerm_resource_group.prod.id]

  permissions {
    data_actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete",
    ]
  }
}

resource "azurerm_role_assignment" "api_files_raw" {
  scope              = azurerm_storage_container.client_raw.id
  role_definition_id = azurerm_role_definition.client_files.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.api.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "api_files_clean" {
  scope              = azurerm_storage_container.client_clean.id
  role_definition_id = azurerm_role_definition.client_files.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.api.principal_id
  principal_type     = "ServicePrincipal"
}

# A backstop: the API deletes originals after 365 days and records it (api/src/files/sweeper.ts). Cleaned copies
# hold only dates and numbers and stay until their file, location data or organization is deleted.
resource "azurerm_storage_management_policy" "files" {
  storage_account_id = azurerm_storage_account.files.id

  rule {
    name    = "delete-originals-after-400-days"
    enabled = true

    filters {
      prefix_match = ["${azurerm_storage_container.client_raw.name}/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = 400
      }
    }
  }
}

# Every blob read, write and delete, with caller, operation and blob name (ids only, never content), to the audit
# account only: the Log Analytics workspace's 0.1 GB daily cap would otherwise stop the API's own logs.
resource "azurerm_monitor_diagnostic_setting" "files_blob" {
  name               = "audit"
  target_resource_id = "${azurerm_storage_account.files.id}/blobServices/default"
  storage_account_id = azurerm_storage_account.audit.id

  enabled_log {
    category = "StorageRead"
  }

  enabled_log {
    category = "StorageWrite"
  }

  enabled_log {
    category = "StorageDelete"
  }
}

# The account's blob name resolves to the private endpoint inside the VNet. The backup and audit accounts have no
# private endpoint, so their names keep resolving publicly and their service-endpoint and trusted-service paths are
# unchanged.
resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = local.rg
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  name                 = "vnet-townwise"
  private_dns_zone_id  = azurerm_private_dns_zone.blob.id
  virtual_network_id   = azurerm_virtual_network.main.id
  registration_enabled = false
}

# About $7.30 a month plus $0.01 per GB in and out (infra/README.md, "Enable file storage").
resource "azurerm_private_endpoint" "files" {
  name                          = "pe-townwise-files"
  resource_group_name           = local.rg
  location                      = local.location
  subnet_id                     = azurerm_subnet.endpoints.id
  custom_network_interface_name = "nic-pe-townwise-files"

  private_service_connection {
    name                           = "files"
    private_connection_resource_id = azurerm_storage_account.files.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }

  depends_on = [azurerm_subnet_network_security_group_association.endpoints]
}
