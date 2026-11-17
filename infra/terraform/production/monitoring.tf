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

# The weekly forecast worker (jobs.tf, caj-townwise-forecasts), only with the lab. Its pass logs one line an hour,
# townwise.weekly_refresh_pass, even while it is switched off or paused, and its failures log their own lines
# (api/src/lab/schedule.ts, api/src/workers/weekly-forecasts.ts). Each line is pino JSON in the Log column.
#
# A pass that failed a start, a location or a weekly suggestions call, a worker that stopped on an error, or a pass
# on a Sunday (UTC) still holding locations back at a cap, checked every hour. A location the live cap holds back is
# caught up later in its week (api/src/lab/schedule.ts), so one still held on Sunday may miss the week. $0.50 a month.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "forecasts_failed" {
  count                = var.enable_lab ? 1 : 0
  name                 = "townwise-forecasts-failed"
  resource_group_name  = local.rg
  location             = local.location
  description          = "The weekly forecast worker failed a start, a location or a suggestions call, stopped on an error, or still held locations back on a Sunday."
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 2
  evaluation_frequency = "PT1H"
  window_duration      = "PT1H"

  criteria {
    query                   = <<-KQL
      ContainerAppConsoleLogs
      | where Log has "townwise.weekly_"
      | extend line = parse_json(Log)
      | extend msg = tostring(line.msg)
      | where msg in (
            "townwise.weekly_worker_failed", "townwise.weekly_worker_refused", "townwise.weekly_refresh_location_failed",
            "townwise.weekly_suggestions_location_failed"
          )
          or (msg in ("townwise.weekly_refresh_pass", "townwise.weekly_suggestions_pass") and toint(line.failed) > 0)
          or (msg == "townwise.weekly_refresh_pass" and toint(line.capped) > 0 and dayofweek(TimeGenerated) == 0d)
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }
}

# No pass line for a day: the job is not running, or every execution died before its pass finished (a bad
# environment, the image, the timeout). Log search windows stop at two days, and a pass runs every hour, so a day
# is the tighter check. It also fires if the daily cap stopped ingestion. $0.50 a month.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "forecasts_missing" {
  count                = var.enable_lab ? 1 : 0
  name                 = "townwise-forecasts-missing"
  resource_group_name  = local.rg
  location             = local.location
  description          = "No weekly forecast worker pass in the last 24 hours."
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 2
  evaluation_frequency = "PT6H"
  window_duration      = "P1D"

  criteria {
    query                   = "ContainerAppConsoleLogs | where Log has \"townwise.weekly_refresh_pass\""
    time_aggregation_method = "Count"
    operator                = "LessThan"
    threshold               = 1
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }
}

# An execution that logged its start and never its end: killed by the job's 600-second replica timeout (jobs.tf), or
# crashed, after its first line. The worker logs townwise.weekly_worker_started first, then its pass line or its error
# line, from one replica, whose name is pino's hostname, so a start older than 15 minutes (past the timeout) with no
# end from the same host is one that died. forecasts_missing sees only a whole day of dead executions; this sees one.
# Each start is in two hourly windows, so one death can email twice. $0.50 a month.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "forecasts_killed" {
  count                = var.enable_lab ? 1 : 0
  name                 = "townwise-forecasts-killed"
  resource_group_name  = local.rg
  location             = local.location
  description          = "A weekly forecast worker execution started and never logged its pass: killed by the timeout or crashed."
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 2
  evaluation_frequency = "PT1H"
  window_duration      = "PT2H"

  criteria {
    query                   = <<-KQL
      let lines = ContainerAppConsoleLogs
      | where Log has "townwise.weekly_"
      | extend line = parse_json(Log)
      | extend msg = tostring(line.msg), host = tostring(line.hostname);
      lines
      | where msg == "townwise.weekly_worker_started" and TimeGenerated < ago(15m)
      | join kind=leftanti (
          lines
          | where msg in ("townwise.weekly_refresh_pass", "townwise.weekly_worker_failed", "townwise.weekly_worker_refused")
        ) on host
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }
}
