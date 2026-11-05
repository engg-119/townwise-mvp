# Nightly mongodump archives (jobs.tf), because the free tier has no backups. One container, write-once for
# 30 days (container-level time-based retention: blobs can be added and read, not changed or deleted), then
# deleted by lifecycle management on day 31. Entra ID only, and the blob endpoint admits only the apps subnet
# (service endpoint), where the backup and restore jobs run.
#
# The retention policy starts unlocked: it already blocks data-plane deletes and overwrites, including by the
# backup identity, but any townwise-admin (guests included) can remove it and then delete every dump. After a
# week of clean backups, set lock_backup_retention = true (infra/README.md, step 14). Locking is irreversible:
# the policy can then only be lengthened, and the account cannot be deleted until its newest dump is 30 days
# old, so a teardown starts by stopping the backup job 30 days ahead.
# The queue service is unused, so queue logging records nothing. bypass is exactly ["AzureServices"]; the
# bypass rule's pattern only matches lists with a second element.
# nosemgrep: terraform.azure.security.storage.storage-queue-services-logging.storage-queue-services-logging, terraform.azure.security.storage.storage-allow-microsoft-service-bypass.storage-allow-microsoft-service-bypass
resource "azurerm_storage_account" "backup" {
  name                              = "sttwbackup${local.suffix}"
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
  public_network_access             = "Enabled"
  #checkov:skip=CKV_AZURE_43:the name is computed from a local (sttwbackup2d2c15bf), which checkov cannot evaluate; it is 18 lowercase letters and digits
  #checkov:skip=CKV_AZURE_33:queue service is unused; only blobs hold dumps
  #checkov:skip=CKV_AZURE_206:LRS: the dumps are a second copy of the database, not the only one; GRS doubles the cost
  #checkov:skip=CKV2_AZURE_1:Microsoft-managed keys; a customer-managed key adds a Key Vault dependency for no threat-model gain
  #checkov:skip=CKV_AZURE_59:service endpoints reach the public endpoint, so it stays enabled behind a deny-by-default firewall that admits only the apps subnet
  #checkov:skip=CKV2_AZURE_33:a private endpoint costs $7.30 a month; the firewall admits only the apps subnet through a service endpoint
  #checkov:skip=CKV2_AZURE_41:shared keys are disabled, so no SAS can be signed with them
  #checkov:skip=CKV2_AZURE_38:soft delete is on (7 days); immutability already blocks deletes for 30 days

  network_rules {
    default_action             = "Deny"
    bypass                     = ["AzureServices"]
    virtual_network_subnet_ids = [azurerm_subnet.apps.id]
  }

  blob_properties {
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

resource "azurerm_storage_container" "backup" {
  name                  = "mongodump"
  storage_account_id    = azurerm_storage_account.backup.id
  container_access_type = "private"
  #checkov:skip=CKV2_AZURE_21:blob read logging would spend the 0.1 GB daily log cap; access is Entra RBAC only, from the apps subnet

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container_immutability_policy" "backup" {
  storage_container_resource_manager_id = azurerm_storage_container.backup.id
  immutability_period_in_days           = 30
  protected_append_writes_enabled       = false
  locked                                = var.lock_backup_retention
}

resource "azurerm_storage_management_policy" "backup" {
  storage_account_id = azurerm_storage_account.backup.id

  rule {
    name    = "delete-dumps-on-day-31"
    enabled = true

    filters {
      prefix_match = ["${azurerm_storage_container.backup.name}/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = 30
      }
    }
  }
}
