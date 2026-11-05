# Container Apps and Key Vault logs, capped near zero cost: 0.1 GB a day stays inside the 5 GB monthly free
# ingestion. Shared-key ingestion is off, so resources send logs through diagnostic settings. When the cap is
# reached, ingestion stops until the daily reset, so an alert says so (below).
resource "azurerm_log_analytics_workspace" "main" {
  name                         = "log-townwise"
  resource_group_name          = local.rg
  location                     = local.location
  sku                          = "PerGB2018"
  retention_in_days            = 30
  daily_quota_gb               = 0.1
  local_authentication_enabled = false
}

resource "azurerm_monitor_diagnostic_setting" "environment" {
  name                       = "to-log-analytics"
  target_resource_id         = azurerm_container_app_environment.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }
}

# Every Key Vault data-plane request (secret reads by the app and jobs, set-secret.sh writes) with caller, to
# two destinations: the workspace, for queries, and an uncapped storage account, so a flood that spends the
# workspace's daily cap cannot blind the audit trail.
resource "azurerm_monitor_diagnostic_setting" "key_vault" {
  name                       = "audit"
  target_resource_id         = azurerm_key_vault.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  storage_account_id         = azurerm_storage_account.audit.id

  enabled_log {
    category = "AuditEvent"
  }
}

# Audit log archive: append blobs written by Azure Monitor (a trusted service, so the firewall and the disabled
# shared keys do not stop it), kept for a year. A few MB a month: under $0.05.
# The queue service is unused, so queue logging records nothing; bypass is exactly ["AzureServices"], which
# the bypass rule's pattern does not match.
# nosemgrep: terraform.azure.security.storage.storage-queue-services-logging.storage-queue-services-logging, terraform.azure.security.storage.storage-allow-microsoft-service-bypass.storage-allow-microsoft-service-bypass
resource "azurerm_storage_account" "audit" {
  name                              = "sttwaudit${local.suffix}"
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
  #checkov:skip=CKV_AZURE_43:the name is computed from a local (sttwaudit2d2c15bf), which checkov cannot evaluate; it is 17 lowercase letters and digits
  #checkov:skip=CKV_AZURE_33:queue service is unused; only blobs hold audit logs
  #checkov:skip=CKV_AZURE_59:deny-by-default firewall with no IP or subnet rules; only trusted Azure services (Azure Monitor) write
  #checkov:skip=CKV_AZURE_206:LRS: the workspace holds a second copy for 30 days; GRS doubles the cost
  #checkov:skip=CKV2_AZURE_1:Microsoft-managed keys; a customer-managed key adds a Key Vault dependency for no threat-model gain
  #checkov:skip=CKV2_AZURE_33:a private endpoint costs $7.30 a month; nothing but Azure Monitor writes here
  #checkov:skip=CKV2_AZURE_41:shared keys are disabled, so no SAS can be signed with them
  #checkov:skip=CKV2_AZURE_38:soft delete is on (7 days)

  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
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

resource "azurerm_storage_management_policy" "audit" {
  storage_account_id = azurerm_storage_account.audit.id

  rule {
    name    = "delete-audit-logs-after-a-year"
    enabled = true

    filters {
      blob_types = ["appendBlob", "blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = 365
      }
    }
  }
}

resource "azurerm_monitor_action_group" "ops" {
  name                = "ag-townwise-ops"
  resource_group_name = local.rg
  short_name          = "townwise"

  email_receiver {
    name                    = "ops"
    email_address           = var.alert_email
    use_common_alert_schema = true
  }
}

# The query and settings Microsoft documents for "daily cap reached"
# (learn.microsoft.com/azure/azure-monitor/logs/daily-cap#alert-when-daily-cap-is-reached), evaluated every
# 15 minutes ($0.50 a month) instead of 5 ($1.50).
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "daily_cap" {
  name                 = "townwise-log-daily-cap-reached"
  resource_group_name  = local.rg
  location             = local.location
  description          = "Log Analytics stopped ingesting for the day: the 0.1 GB daily cap was reached."
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 2
  evaluation_frequency = "PT15M"
  window_duration      = "PT15M"

  criteria {
    query                   = "_LogOperation | where Category =~ \"Ingestion\" | where Detail contains \"OverQuota\""
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }
}

# A nightly backup that did not upload. files/backup-upload.sh prints "uploaded townwise-..." only after the
# upload succeeds; ContainerAppConsoleLogs (Log column) holds job stdout
# (learn.microsoft.com/azure/azure-monitor/reference/tables/containerappconsolelogs). Fires when no such line
# arrived in the last day, checked every 6 hours. It also fires if the daily cap stopped ingestion, which is
# worth knowing too. $0.50 a month.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "backup_missing" {
  name                 = "townwise-backup-missing"
  resource_group_name  = local.rg
  location             = local.location
  description          = "No successful nightly database backup upload in the last 24 hours."
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 1
  evaluation_frequency = "PT6H"
  window_duration      = "P1D"

  criteria {
    query                   = "ContainerAppConsoleLogs | where Log has \"uploaded townwise-\""
    time_aggregation_method = "Count"
    operator                = "LessThan"
    threshold               = 1
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }
}
