mock_provider "azurerm" {
  override_during = plan
}

mock_provider "azapi" {
  override_during = plan
}

# random is not mocked: its ephemeral password runs locally and never reaches plan or state.

variables {
  api_image   = "crtownwise2d2c15bf.azurecr.io/townwise-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  alert_email = "ops@example.invalid"
}

override_data {
  target          = data.azurerm_client_config.current
  override_during = plan
  values = {
    tenant_id       = "37acb94f-e2d9-41d9-a697-1bd7a1d60bf1"
    subscription_id = "2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999"
  }
}

override_data {
  target          = data.azurerm_resource_group.prod
  override_during = plan
  values = {
    id       = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod"
    name     = "rg-townwise-prod"
    location = "eastus"
  }
}

override_data {
  target          = data.azurerm_user_assigned_identity.deploy
  override_during = plan
  values = {
    principal_id = "00000000-0000-0000-0000-0000000000aa"
  }
}

override_resource {
  target          = azurerm_user_assigned_identity.api
  override_during = plan
  values = {
    id           = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-townwise-api"
    principal_id = "00000000-0000-0000-0000-0000000000ee"
    client_id    = "00000000-0000-0000-0000-0000000000ef"
  }
}

override_resource {
  target          = azurerm_log_analytics_workspace.main
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.OperationalInsights/workspaces/log-townwise"
  }
}

override_resource {
  target          = azurerm_container_app_environment.main
  override_during = plan
  values = {
    id                = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.App/managedEnvironments/cae-townwise"
    static_ip_address = "203.0.113.20"
  }
}

override_resource {
  target          = azurerm_container_registry.main
  override_during = plan
  values = {
    id           = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.ContainerRegistry/registries/crtownwise2d2c15bf"
    login_server = "crtownwise2d2c15bf.azurecr.io"
  }
}

override_resource {
  target          = azurerm_key_vault.main
  override_during = plan
  values = {
    id        = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf"
    vault_uri = "https://kv-townwise-2d2c15bf.vault.azure.net/"
  }
}

override_resource {
  target          = azurerm_container_app.api
  override_during = plan
  values = {
    id                            = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.App/containerApps/ca-townwise-api"
    custom_domain_verification_id = "MOCKVERIFICATIONID"
  }
}

override_resource {
  target          = azurerm_static_web_app.web
  override_during = plan
  values = {
    id                = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Web/staticSites/swa-townwise"
    default_host_name = "mock-host.azurestaticapps.net"
  }
}

override_resource {
  target          = azurerm_dns_zone.main
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Network/dnsZones/townwise.tech"
  }
}

override_resource {
  target          = azurerm_email_communication_service.main
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Communication/emailServices/acse-townwise-2d2c15bf"
  }
}

override_resource {
  target          = azurerm_email_communication_service_domain.main
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Communication/emailServices/acse-townwise-2d2c15bf/domains/townwise.tech"
    verification_records = [{
      domain = [{ name = "townwise.tech", ttl = 3600, type = "TXT", value = "ms-domain-verification=mock" }]
      spf    = [{ name = "townwise.tech", ttl = 3600, type = "TXT", value = "v=spf1 include:spf.protection.outlook.com -all" }]
      dkim   = [{ name = "selector1-azurecomm-prod-net._domainkey", ttl = 3600, type = "CNAME", value = "selector1-azurecomm-prod-net._domainkey.azurecomm.net" }]
      dkim2  = [{ name = "selector2-azurecomm-prod-net._domainkey", ttl = 3600, type = "CNAME", value = "selector2-azurecomm-prod-net._domainkey.azurecomm.net" }]
      dmarc  = [{ name = "_dmarc.townwise.tech", ttl = 3600, type = "TXT", value = "v=DMARC1; p=none;" }]
    }]
  }
}

override_resource {
  target          = azurerm_communication_service.main
  override_during = plan
  values = {
    id       = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Communication/communicationServices/acs-townwise-2d2c15bf"
    hostname = "acs-townwise-2d2c15bf.unitedstates.communication.azure.com"
  }
}

override_resource {
  target          = azurerm_virtual_network.main
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Network/virtualNetworks/vnet-townwise"
  }
}

override_resource {
  target          = azurerm_subnet.apps
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Network/virtualNetworks/vnet-townwise/subnets/snet-apps"
  }
}

override_resource {
  target          = azurerm_subnet.endpoints
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Network/virtualNetworks/vnet-townwise/subnets/snet-endpoints"
  }
}

override_resource {
  target          = azurerm_network_security_group.endpoints
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Network/networkSecurityGroups/nsg-townwise-endpoints"
  }
}

override_resource {
  target          = azurerm_private_dns_zone.docdb
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Network/privateDnsZones/privatelink.mongocluster.cosmos.azure.com"
  }
}

override_resource {
  target          = azapi_resource.docdb
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.DocumentDB/mongoClusters/docdb-townwise-2d2c15bf"
  }
}

override_resource {
  target          = azurerm_key_vault_secret.db_admin_password
  override_during = plan
  values = {
    resource_versionless_id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/db-admin-password"
  }
}

override_resource {
  target          = azurerm_user_assigned_identity.job["backup"]
  override_during = plan
  values = {
    id           = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-townwise-job-backup"
    principal_id = "00000000-0000-0000-0000-0000000000b1"
    client_id    = "00000000-0000-0000-0000-0000000001b1"
  }
}

override_resource {
  target          = azurerm_user_assigned_identity.job["db-users"]
  override_during = plan
  values = {
    id           = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-townwise-job-db-users"
    principal_id = "00000000-0000-0000-0000-0000000000c1"
    client_id    = "00000000-0000-0000-0000-0000000001c1"
  }
}

override_resource {
  target          = azurerm_user_assigned_identity.job["restore"]
  override_during = plan
  values = {
    id           = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-townwise-job-restore"
    principal_id = "00000000-0000-0000-0000-0000000000e1"
    client_id    = "00000000-0000-0000-0000-0000000001e1"
  }
}

override_resource {
  target          = azurerm_user_assigned_identity.job["smoke"]
  override_during = plan
  values = {
    id           = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-townwise-job-smoke"
    principal_id = "00000000-0000-0000-0000-0000000000f1"
    client_id    = "00000000-0000-0000-0000-0000000001f1"
  }
}

override_resource {
  target          = azurerm_role_definition.backup_writer
  override_during = plan
  values = {
    role_definition_resource_id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-00000000bb01"
  }
}

override_resource {
  target          = azurerm_storage_account.audit
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Storage/storageAccounts/sttwaudit2d2c15bf"
  }
}

override_resource {
  target          = azurerm_storage_account.backup
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Storage/storageAccounts/sttwbackup2d2c15bf"
  }
}

override_resource {
  target          = azurerm_storage_container.backup
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Storage/storageAccounts/sttwbackup2d2c15bf/blobServices/default/containers/mongodump"
  }
}

override_resource {
  target          = azurerm_storage_account.files
  override_during = plan
  values = {
    id                    = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Storage/storageAccounts/sttwfiles2d2c15bf"
    primary_blob_endpoint = "https://sttwfiles2d2c15bf.blob.core.windows.net/"
  }
}

override_resource {
  target          = azurerm_storage_container.client_raw
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Storage/storageAccounts/sttwfiles2d2c15bf/blobServices/default/containers/client-raw"
  }
}

override_resource {
  target          = azurerm_storage_container.client_clean
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Storage/storageAccounts/sttwfiles2d2c15bf/blobServices/default/containers/client-clean"
  }
}

override_resource {
  target          = azurerm_role_definition.client_files
  override_during = plan
  values = {
    role_definition_resource_id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-00000000f101"
  }
}

override_resource {
  target          = azurerm_private_dns_zone.blob
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net"
  }
}

override_resource {
  target          = azurerm_monitor_action_group.ops
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Insights/actionGroups/ag-townwise-ops"
  }
}

override_resource {
  target          = azurerm_role_definition.deployer
  override_during = plan
  values = {
    role_definition_resource_id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-00000000de01"
  }
}

override_resource {
  target          = azurerm_role_definition.email_sender
  override_during = plan
  values = {
    role_definition_resource_id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-00000000e301"
  }
}

override_resource {
  target          = azurerm_user_assigned_identity.lab[0]
  override_during = plan
  values = {
    id           = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-townwise-job-lab"
    principal_id = "00000000-0000-0000-0000-0000000000d1"
    client_id    = "00000000-0000-0000-0000-0000000001d1"
  }
}

override_resource {
  target          = azurerm_user_assigned_identity.job["forecasts"]
  override_during = plan
  values = {
    id           = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-townwise-job-forecasts"
    principal_id = "00000000-0000-0000-0000-0000000000a2"
    client_id    = "00000000-0000-0000-0000-0000000001a2"
  }
}

override_resource {
  target          = azapi_resource.job_lab[0]
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.App/jobs/caj-townwise-lab"
  }
}

override_resource {
  target          = azapi_resource.job_forecasts[0]
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.App/jobs/caj-townwise-forecasts"
  }
}

override_resource {
  target          = azurerm_role_definition.lab_starter[0]
  override_during = plan
  values = {
    role_definition_resource_id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-0000000000f3"
  }
}

run "key_vault" {
  command = plan

  assert {
    condition = (
      azurerm_key_vault.main.rbac_authorization_enabled &&
      azurerm_key_vault.main.purge_protection_enabled &&
      azurerm_key_vault.main.soft_delete_retention_days >= 7
    )
    error_message = "Key Vault in RBAC mode with purge protection."
  }

  assert {
    condition = toset([for key, assignment in azurerm_role_assignment.api_secret_read : assignment.scope]) == toset([
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/mongodb-uri",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-jwt-keys",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-encryption-keys",
    ])
    error_message = "The app's secret role is scoped to each of its three secrets, never to the vault."
  }

  assert {
    condition = alltrue([
      for key, assignment in azurerm_role_assignment.api_secret_read :
      assignment.role_definition_name == "Key Vault Secrets User" && assignment.principal_id == "00000000-0000-0000-0000-0000000000ee"
    ])
    error_message = "Only the app's identity, with Key Vault Secrets User."
  }

  assert {
    condition = alltrue([
      for secret in azurerm_container_app.api.secret :
      secret.value == null && startswith(secret.key_vault_secret_id, "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/")
    ])
    error_message = "Every Container App secret is a Key Vault reference with no value in Terraform."
  }

  assert {
    condition = toset([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${coalesce(env.secret_name, "-")}" if env.secret_name != null]) == toset([
      "MONGODB_URI=mongodb-uri", "AUTH_JWT_KEYS=auth-jwt-keys", "AUTH_ENCRYPTION_KEYS=auth-encryption-keys",
    ])
    error_message = "The secrets map to the env vars the API's schema reads."
  }

  assert {
    condition = (
      !var.enable_calendar_links &&
      !contains([for secret in azurerm_container_app.api.secret : secret.name], "townwise-calendar-key") &&
      !contains([for env in azurerm_container_app.api.template[0].container[0].env : env.name], "TOWNWISE_CALENDAR_KEY")
    )
    error_message = "By default calendar links are off: no calendar key secret, no TOWNWISE_CALENDAR_KEY, no role on it."
  }

  assert {
    condition = (
      !var.enable_google_calendar &&
      !contains([for secret in azurerm_container_app.api.secret : secret.name], "townwise-google-calendar-secret") &&
      !contains([for env in azurerm_container_app.api.template[0].container[0].env : env.name], "TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET") &&
      !contains(keys(azurerm_role_assignment.api_secret_read), "townwise-google-calendar-secret")
    )
    error_message = "By default Google calendars are off: no Google client secret, no TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET, no role on it."
  }

  assert {
    condition = (
      !var.enable_chat &&
      !contains([for secret in azurerm_container_app.api.secret : secret.name], "anthropic-api-key") &&
      !contains([for env in azurerm_container_app.api.template[0].container[0].env : env.name], "ANTHROPIC_API_KEY")
    )
    error_message = "By default the tuning chat is off: no Anthropic key secret, no ANTHROPIC_API_KEY, no role on it."
  }

  assert {
    condition = (
      !var.enable_places &&
      length(setintersection(
        toset([for secret in azurerm_container_app.api.secret : secret.name]),
        toset(["google-places-api-key", "google-maps-static-key", "google-maps-signing-secret"]),
      )) == 0 &&
      length(setintersection(
        toset([for env in azurerm_container_app.api.template[0].container[0].env : env.name]),
        toset(["GOOGLE_PLACES_API_KEY", "GOOGLE_MAPS_STATIC_KEY", "GOOGLE_MAPS_SIGNING_SECRET"]),
      )) == 0
    )
    error_message = "By default the Places search and its map are off: no Google Places key, Maps Static key or signing secret, none of GOOGLE_PLACES_API_KEY, GOOGLE_MAPS_STATIC_KEY or GOOGLE_MAPS_SIGNING_SECRET, no role on any of them."
  }

  assert {
    condition = toset([for key, assignment in azurerm_role_assignment.job_secret_read : "${assignment.principal_id} ${element(split("/", assignment.scope), length(split("/", assignment.scope)) - 1)}"]) == toset([
      "00000000-0000-0000-0000-0000000000b1 mongodb-backup-uri",
      "00000000-0000-0000-0000-0000000000c1 db-admin-password",
      "00000000-0000-0000-0000-0000000000c1 mongodb-uri",
      "00000000-0000-0000-0000-0000000000c1 mongodb-backup-uri",
      "00000000-0000-0000-0000-0000000000c1 mongodb-restore-uri",
      "00000000-0000-0000-0000-0000000000e1 mongodb-restore-uri",
      "00000000-0000-0000-0000-0000000000f1 mongodb-uri",
      ]) && alltrue([
      for key, assignment in azurerm_role_assignment.job_secret_read :
      assignment.role_definition_name == "Key Vault Secrets User" && strcontains(assignment.scope, "/vaults/kv-townwise-2d2c15bf/secrets/")
    ])
    error_message = "Each job identity reads only its own secrets, each by a secret-scoped assignment: backup the read-only URI, db-users the admin password and the user URIs, restore the restore URI, smoke the app URI."
  }

  assert {
    condition = (
      [for key, assignment in azurerm_role_assignment.job_secret_read : key if endswith(key, "/db-admin-password")] == ["db-users/db-admin-password"] &&
      [for job in [azapi_resource.job_backup, azapi_resource.job_db_users, azapi_resource.job_restore, azapi_resource.job_smoke] : job.name
      if contains([for secret in job.body.properties.configuration.secrets : secret.name], "db-admin-password")] == ["caj-townwise-db-users"]
    )
    error_message = "Only the db-users job and its identity can read the database admin password."
  }
}

run "chat_enabled" {
  command = plan

  variables {
    enable_chat = true
  }

  assert {
    condition = toset([for key, assignment in azurerm_role_assignment.api_secret_read : assignment.scope]) == toset([
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/mongodb-uri",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-jwt-keys",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-encryption-keys",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/anthropic-api-key",
      ]) && alltrue([
      for key, assignment in azurerm_role_assignment.api_secret_read :
      assignment.role_definition_name == "Key Vault Secrets User" && assignment.principal_id == "00000000-0000-0000-0000-0000000000ee"
    ])
    error_message = "With the chat on, the app's identity reads the Anthropic key by one more secret-scoped assignment, and nothing wider."
  }

  assert {
    condition = (
      toset([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${coalesce(env.secret_name, "-")}" if env.secret_name != null]) == toset([
        "MONGODB_URI=mongodb-uri", "AUTH_JWT_KEYS=auth-jwt-keys", "AUTH_ENCRYPTION_KEYS=auth-encryption-keys", "ANTHROPIC_API_KEY=anthropic-api-key",
      ]) &&
      contains([for secret in azurerm_container_app.api.secret : secret.key_vault_secret_id], "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/anthropic-api-key") &&
      alltrue([for secret in azurerm_container_app.api.secret : secret.value == null])
    )
    error_message = "With the chat on, ANTHROPIC_API_KEY is a Key Vault reference to anthropic-api-key, with no value in Terraform."
  }
}

run "calendar_links_enabled" {
  command = plan

  variables {
    enable_calendar_links = true
  }

  assert {
    condition = toset([for key, assignment in azurerm_role_assignment.api_secret_read : assignment.scope]) == toset([
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/mongodb-uri",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-jwt-keys",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-encryption-keys",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/townwise-calendar-key",
      ]) && alltrue([
      for key, assignment in azurerm_role_assignment.api_secret_read :
      assignment.role_definition_name == "Key Vault Secrets User" && assignment.principal_id == "00000000-0000-0000-0000-0000000000ee"
    ])
    error_message = "With calendar links on, the app's identity reads the calendar key by one more secret-scoped assignment, and nothing wider."
  }

  assert {
    condition = (
      toset([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${coalesce(env.secret_name, "-")}" if env.secret_name != null]) == toset([
        "MONGODB_URI=mongodb-uri", "AUTH_JWT_KEYS=auth-jwt-keys", "AUTH_ENCRYPTION_KEYS=auth-encryption-keys", "TOWNWISE_CALENDAR_KEY=townwise-calendar-key",
      ]) &&
      contains([for secret in azurerm_container_app.api.secret : secret.key_vault_secret_id], "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/townwise-calendar-key") &&
      alltrue([for secret in azurerm_container_app.api.secret : secret.value == null])
    )
    error_message = "With calendar links on, TOWNWISE_CALENDAR_KEY is a Key Vault reference to townwise-calendar-key, with no value in Terraform."
  }
}

run "google_calendar_enabled" {
  command = plan

  variables {
    enable_calendar_links  = true
    enable_google_calendar = true
  }

  assert {
    condition = toset([for key, assignment in azurerm_role_assignment.api_secret_read : assignment.scope]) == toset([
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/mongodb-uri",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-jwt-keys",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-encryption-keys",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/townwise-calendar-key",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/townwise-google-calendar-secret",
      ]) && alltrue([
      for key, assignment in azurerm_role_assignment.api_secret_read :
      assignment.role_definition_name == "Key Vault Secrets User" && assignment.principal_id == "00000000-0000-0000-0000-0000000000ee"
    ])
    error_message = "With Google calendars on, the app's identity reads the Google client secret by one more secret-scoped assignment than calendar links alone, and nothing wider."
  }

  assert {
    condition = (
      toset([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${coalesce(env.secret_name, "-")}" if env.secret_name != null]) == toset([
        "MONGODB_URI=mongodb-uri", "AUTH_JWT_KEYS=auth-jwt-keys", "AUTH_ENCRYPTION_KEYS=auth-encryption-keys", "TOWNWISE_CALENDAR_KEY=townwise-calendar-key",
        "TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET=townwise-google-calendar-secret",
      ]) &&
      contains([for secret in azurerm_container_app.api.secret : secret.key_vault_secret_id], "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/townwise-google-calendar-secret") &&
      alltrue([for secret in azurerm_container_app.api.secret : secret.value == null])
    )
    error_message = "With Google calendars on, TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET is a Key Vault reference to townwise-google-calendar-secret, with no value in Terraform."
  }
}

run "google_calendar_without_links" {
  command = plan

  variables {
    enable_google_calendar = true
  }

  expect_failures = [var.enable_google_calendar]
}

run "places_enabled" {
  command = plan

  variables {
    enable_places = true
  }

  assert {
    condition = toset([for key, assignment in azurerm_role_assignment.api_secret_read : assignment.scope]) == toset([
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/mongodb-uri",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-jwt-keys",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/auth-encryption-keys",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/google-places-api-key",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/google-maps-static-key",
      "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/google-maps-signing-secret",
      ]) && alltrue([
      for key, assignment in azurerm_role_assignment.api_secret_read :
      assignment.role_definition_name == "Key Vault Secrets User" && assignment.principal_id == "00000000-0000-0000-0000-0000000000ee"
    ])
    error_message = "With the Places search on, the app's identity reads the Google Places key, the Maps Static key and its signing secret by three more secret-scoped assignments, and nothing wider."
  }

  assert {
    condition = (
      toset([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${coalesce(env.secret_name, "-")}" if env.secret_name != null]) == toset([
        "MONGODB_URI=mongodb-uri", "AUTH_JWT_KEYS=auth-jwt-keys", "AUTH_ENCRYPTION_KEYS=auth-encryption-keys", "GOOGLE_PLACES_API_KEY=google-places-api-key",
        "GOOGLE_MAPS_STATIC_KEY=google-maps-static-key", "GOOGLE_MAPS_SIGNING_SECRET=google-maps-signing-secret",
      ]) &&
      contains([for secret in azurerm_container_app.api.secret : secret.key_vault_secret_id], "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/google-places-api-key") &&
      contains([for secret in azurerm_container_app.api.secret : secret.key_vault_secret_id], "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/google-maps-static-key") &&
      contains([for secret in azurerm_container_app.api.secret : secret.key_vault_secret_id], "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/google-maps-signing-secret") &&
      alltrue([for secret in azurerm_container_app.api.secret : secret.value == null])
    )
    error_message = "With the Places search on, GOOGLE_PLACES_API_KEY, GOOGLE_MAPS_STATIC_KEY and GOOGLE_MAPS_SIGNING_SECRET are Key Vault references to google-places-api-key, google-maps-static-key and google-maps-signing-secret, with no value in Terraform."
  }
}

run "rbac_scopes" {
  command = plan

  assert {
    condition = alltrue([
      for assignment in concat(
        values(azurerm_role_assignment.api_secret_read), values(azurerm_role_assignment.deployer),
        values(azurerm_role_assignment.job_secret_read), values(azurerm_role_assignment.job_acr_pull),
        [azurerm_role_assignment.api_acr_pull, azurerm_role_assignment.api_email, azurerm_role_assignment.deploy_acr_push],
        [azurerm_role_assignment.backup_blob_create, azurerm_role_assignment.restore_blob_read],
        [azurerm_role_assignment.api_files_raw, azurerm_role_assignment.api_files_clean],
      ) : !can(regex("^/subscriptions/[^/]+/?$", assignment.scope)) && !can(regex("^/subscriptions/[^/]+/resourceGroups/[^/]+/?$", assignment.scope))
    ])
    error_message = "Every production role assignment is scoped to a single resource: none at subscription or resource-group scope."
  }

  assert {
    condition = alltrue([
      for assignment in concat(
        values(azurerm_role_assignment.api_secret_read), [azurerm_role_assignment.api_acr_pull, azurerm_role_assignment.deploy_acr_push],
        values(azurerm_role_assignment.job_secret_read), values(azurerm_role_assignment.job_acr_pull),
        [azurerm_role_assignment.restore_blob_read],
      ) : !contains(["Owner", "Contributor"], assignment.role_definition_name)
      ]) && alltrue([
      for assignment in values(azurerm_role_assignment.deployer) :
      assignment.role_definition_id == azurerm_role_definition.deployer.role_definition_resource_id
      ]) && azurerm_role_assignment.api_email.role_definition_id == azurerm_role_definition.email_sender.role_definition_resource_id && alltrue([
      for assignment in [azurerm_role_assignment.api_files_raw, azurerm_role_assignment.api_files_clean] :
      assignment.role_definition_id == azurerm_role_definition.client_files.role_definition_resource_id
    ])
    error_message = "No Owner or Contributor anywhere in production; the deploy, email and client files grants use their custom roles."
  }

  assert {
    condition = (
      toset(azurerm_role_definition.deployer.permissions[0].actions) == toset([
        "Microsoft.App/containerApps/read",
        "Microsoft.App/containerApps/write",
        "Microsoft.App/containerApps/revisions/read",
        "Microsoft.App/jobs/read",
        "Microsoft.App/jobs/write",
        "Microsoft.App/managedEnvironments/read",
        "Microsoft.App/managedEnvironments/join/action",
        "Microsoft.ContainerRegistry/registries/read",
        "Microsoft.Web/staticSites/read",
        "Microsoft.Web/staticSites/listSecrets/action",
      ]) &&
      toset(keys(azurerm_role_assignment.deployer)) == toset(["container_app", "environment", "registry", "static_web"])
    )
    error_message = "The deploy role has exactly its listed actions (no listSecrets on the Container App, no wildcard)."
  }

  assert {
    condition = toset(azurerm_role_definition.email_sender.permissions[0].actions) == toset([
      "Microsoft.Communication/CommunicationServices/Read",
      "Microsoft.Communication/CommunicationServices/Write",
      "Microsoft.Communication/EmailServices/write",
    ]) && azurerm_role_assignment.api_email.scope == azurerm_communication_service.main.id
    error_message = "The app may only send email, on the one Communication Services resource."
  }
}

run "web_headers" {
  command = plan

  assert {
    condition = output.web_headers == {
      "Content-Security-Policy"    = "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data: https://maps.googleapis.com; font-src 'self'; connect-src 'self' https://api.townwise.tech https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      "Cross-Origin-Opener-Policy" = "same-origin-allow-popups"
      "Strict-Transport-Security"  = "max-age=31536000; includeSubDomains"
      "Referrer-Policy"            = "strict-origin-when-cross-origin"
      "X-Content-Type-Options"     = "nosniff"
    }
    error_message = "globalHeaders must be exactly the headers in client/MODULE.md (Security), with the API origin filled in."
  }

  assert {
    condition     = output.web_navigation_fallback == "/index.html"
    error_message = "Every app route falls back to /index.html."
  }

  assert {
    condition     = azurerm_static_web_app.web.sku_tier == "Free" && !azurerm_static_web_app.web.preview_environments_enabled
    error_message = "Static Web Apps Free, with no pull-request preview environments."
  }
}

run "container_app" {
  command = plan

  assert {
    condition = (
      azurerm_container_app.api.template[0].min_replicas == 1 && azurerm_container_app.api.template[0].max_replicas == 2 &&
      azurerm_container_app.api.ingress[0].target_port == 8080 && !azurerm_container_app.api.ingress[0].allow_insecure_connections
    )
    error_message = "One to two replicas, HTTPS-only ingress to port 8080."
  }

  assert {
    condition = alltrue([
      for probe in concat(
        azurerm_container_app.api.template[0].container[0].startup_probe,
        azurerm_container_app.api.template[0].container[0].liveness_probe,
        azurerm_container_app.api.template[0].container[0].readiness_probe,
      ) : probe.path == "/healthz" && probe.port == 8080
    ])
    error_message = "Startup, liveness and readiness probes on /healthz."
  }

  assert {
    condition = (
      azurerm_container_app.api.template[0].container[1].image == "crtownwise2d2c15bf.azurecr.io/valkey/valkey@sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507" &&
      azurerm_container_app.api.template[0].init_container[0].image == azurerm_container_app.api.template[0].container[1].image &&
      join(" ", azurerm_container_app.api.template[0].container[1].args) == "valkey-server --bind 127.0.0.1 --protected-mode yes --port 0 --tls-port 6379 --tls-cert-file /tls/server.crt --tls-key-file /tls/server.key --tls-ca-cert-file /tls/ca.crt --tls-auth-clients no --save --appendonly no --maxmemory 64mb --maxmemory-policy noeviction"
    )
    error_message = "Valkey: digest-pinned from the private registry, loopback and TLS only, no saved data, noeviction."
  }

  assert {
    condition = contains([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${env.value}" if env.value != null], "REDIS_URL=rediss://127.0.0.1:6379/0") && contains(
      [for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${env.value}" if env.value != null], "NODE_EXTRA_CA_CERTS=/tls/ca.crt"
    )
    error_message = "The API reaches Valkey over rediss: and trusts the per-replica CA."
  }

  assert {
    condition = (
      azurerm_container_registry.main.sku == "Basic" && !azurerm_container_registry.main.admin_enabled && !azurerm_container_registry.main.anonymous_pull_enabled &&
      !azurerm_log_analytics_workspace.main.local_authentication_enabled && azurerm_log_analytics_workspace.main.daily_quota_gb <= 0.5
    )
    error_message = "Registry: no admin user, no anonymous pull. Logs: no shared keys, low daily cap."
  }
}

run "dns_and_email" {
  command = plan

  assert {
    condition = (
      azurerm_dns_a_record.api.records == toset(["203.0.113.20"]) &&
      azurerm_dns_txt_record.api_verification.name == "asuid.api" &&
      azurerm_dns_a_record.apex.target_resource_id == azurerm_static_web_app.web.id &&
      azurerm_dns_cname_record.www.record == "mock-host.azurestaticapps.net"
    )
    error_message = "api is an A record (never a CNAME, for WebKit cookies) with its asuid TXT; the apex aliases the Static Web App; www is a CNAME."
  }

  assert {
    condition = (
      toset([for key, record in azurerm_dns_cname_record.acs_dkim : "${record.name} ${record.record}"]) == toset([
        "selector1-azurecomm-prod-net._domainkey selector1-azurecomm-prod-net._domainkey.azurecomm.net",
        "selector2-azurecomm-prod-net._domainkey selector2-azurecomm-prod-net._domainkey.azurecomm.net",
      ]) &&
      toset([for record in azurerm_dns_txt_record.apex.record : record.value]) == toset(["ms-domain-verification=mock", "v=spf1 include:spf.protection.outlook.com -all"]) &&
      toset([for record in azurerm_dns_txt_record.dmarc.record : record.value]) == toset(["v=DMARC1; p=reject; sp=reject; adkim=s;"])
    )
    error_message = "Both DKIM CNAMEs, domain verification and SPF at the apex, DMARC reject for the apex and subdomains with strict DKIM alignment."
  }

  assert {
    condition     = length(azurerm_communication_service_email_domain_association.main) == 0 && azurerm_email_communication_service_domain_sender_username.no_reply.name == "no-reply"
    error_message = "The sender is no-reply, and the domain is linked only after verification."
  }
}

run "rejects_bad_inputs" {
  command = plan

  variables {
    db_tier     = "M30"
    alert_email = "not-an-email"
  }

  expect_failures = [
    var.db_tier,
    var.alert_email,
  ]
}

run "database_private_and_passwordless_in_state" {
  command = plan

  assert {
    condition = (
      azapi_resource.docdb.type == "Microsoft.DocumentDB/mongoClusters@2025-09-01" &&
      azapi_resource.docdb.body.properties.publicNetworkAccess == "Disabled" &&
      azapi_resource.docdb.body.properties.compute.tier == "Free" &&
      azapi_resource.docdb.body.properties.authConfig.allowedModes == ["NativeAuth"] &&
      azapi_resource.docdb.body.properties.highAvailability.targetMode == "Disabled"
    )
    error_message = "DocumentDB on the free tier with public network access disabled."
  }

  assert {
    condition = (
      !strcontains(lower(jsonencode(azapi_resource.docdb.body)), "password") &&
      azapi_resource.docdb.sensitive_body == null &&
      azapi_resource.docdb.response_export_values == null &&
      azurerm_key_vault_secret.db_admin_password.value == null &&
      azurerm_key_vault_secret.db_admin_password.value_wo == null
    )
    error_message = "The admin password is only in write-only arguments (sensitive_body, value_wo), and no response property (such as connectionString) is exported to state."
  }

  assert {
    condition = (
      azurerm_private_endpoint.docdb.subnet_id == azurerm_subnet.endpoints.id &&
      azurerm_private_endpoint.docdb.private_service_connection[0].private_connection_resource_id == azapi_resource.docdb.id &&
      azurerm_private_endpoint.docdb.private_service_connection[0].subresource_names == tolist(["MongoCluster"]) &&
      azurerm_private_dns_zone.docdb.name == "privatelink.mongocluster.cosmos.azure.com" &&
      azurerm_private_endpoint.docdb.private_dns_zone_group[0].private_dns_zone_ids == tolist([azurerm_private_dns_zone.docdb.id]) &&
      azurerm_private_dns_zone_virtual_network_link.docdb.virtual_network_id == azurerm_virtual_network.main.id
    )
    error_message = "One private endpoint (MongoCluster) in the endpoints subnet, resolved through the privatelink zone linked to the VNet."
  }

  assert {
    condition = (
      toset([for rule in azurerm_network_security_group.endpoints.security_rule : "${rule.access} ${rule.direction} ${rule.source_address_prefix} ${rule.destination_port_range}"]) == toset([
        "Allow Inbound 10.40.0.0/24 10260", "Allow Inbound 10.40.0.0/24 443", "Deny Inbound * *",
      ]) &&
      azurerm_subnet.endpoints.private_endpoint_network_policies == "NetworkSecurityGroupEnabled" &&
      azurerm_subnet_network_security_group_association.endpoints.subnet_id == azurerm_subnet.endpoints.id
    )
    error_message = "The endpoint subnet's NSG admits only the apps subnet, only on 10260 (the database) and 443 (client files), and is enforced on private endpoints."
  }

  assert {
    condition = (
      azurerm_container_app_environment.main.infrastructure_subnet_id == azurerm_subnet.apps.id &&
      [for profile in azurerm_container_app_environment.main.workload_profile : "${profile.name}/${profile.workload_profile_type}"] == ["Consumption/Consumption"] &&
      !azurerm_container_app_environment.main.internal_load_balancer_enabled &&
      azurerm_container_app_environment.main.infrastructure_resource_group_name == "rg-townwise-prod-infra" &&
      one(azurerm_subnet.apps.delegation).service_delegation[0].name == "Microsoft.App/environments"
    )
    error_message = "The environment joins the delegated apps subnet with the Consumption profile only (no Dedicated management fee); its managed group matches the budget filter."
  }
}

run "database_fallback_tier" {
  command = plan

  variables {
    db_tier = "M10"
  }

  assert {
    condition     = azapi_resource.docdb.body.properties.compute.tier == "M10" && azapi_resource.docdb.body.properties.publicNetworkAccess == "Disabled"
    error_message = "db_tier = M10 is the documented fallback, still private."
  }
}

run "backups" {
  command = plan

  assert {
    condition = (
      !azurerm_storage_account.backup.shared_access_key_enabled &&
      azurerm_storage_account.backup.min_tls_version == "TLS1_2" &&
      !azurerm_storage_account.backup.allow_nested_items_to_be_public &&
      azurerm_storage_account.backup.network_rules[0].default_action == "Deny" &&
      azurerm_storage_account.backup.network_rules[0].virtual_network_subnet_ids == toset([azurerm_subnet.apps.id]) &&
      length(azurerm_storage_account.backup.network_rules[0].ip_rules) == 0
    )
    error_message = "Backup storage: Entra ID only, TLS 1.2, private, reachable only from the apps subnet."
  }

  assert {
    condition = (
      azurerm_storage_container_immutability_policy.backup.immutability_period_in_days == 30 &&
      !azurerm_storage_container_immutability_policy.backup.locked &&
      azurerm_storage_container_immutability_policy.backup.storage_container_resource_manager_id == azurerm_storage_container.backup.id &&
      azurerm_storage_management_policy.backup.rule[0].actions[0].base_blob[0].delete_after_days_since_creation_greater_than == 30 &&
      azurerm_storage_management_policy.backup.rule[0].filters[0].prefix_match == toset(["mongodump/"])
    )
    error_message = "Dumps are write-once for 30 days (unlocked until lock_backup_retention) and deleted on day 31."
  }

  assert {
    condition = (
      azapi_resource.job_backup.body.properties.configuration.scheduleTriggerConfig.cronExpression == "17 7 * * *" &&
      azapi_resource.job_backup.body.properties.template.initContainers[0].image == "crtownwise2d2c15bf.azurecr.io/mongo@sha256:d0d926f94df099bff534b7ee5b5986458131a22489dfff8664509af0c1e2ca9c" &&
      azapi_resource.job_backup.body.properties.template.containers[0].image == "mcr.microsoft.com/azure-cli@sha256:a4e2660b4099b76f02001a9316a0eb0dc56e330b5f7d1d1312c932200645bf26" &&
      azapi_resource.job_backup.body.properties.template.volumes[0].storageType == "EmptyDir"
    )
    error_message = "Nightly job: mongodump (digest-pinned, from the private registry) into an EmptyDir, uploaded by the digest-pinned Azure CLI."
  }

  assert {
    condition = (
      azurerm_role_assignment.backup_blob_create.scope == azurerm_storage_container.backup.id &&
      azurerm_role_assignment.backup_blob_create.principal_id == "00000000-0000-0000-0000-0000000000b1" &&
      azurerm_role_assignment.backup_blob_create.role_definition_id == azurerm_role_definition.backup_writer.role_definition_resource_id &&
      azurerm_role_definition.backup_writer.permissions[0].data_actions == toset(["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action"]) &&
      try(length(azurerm_role_definition.backup_writer.permissions[0].actions), 0) == 0 &&
      azurerm_role_assignment.restore_blob_read.scope == azurerm_storage_container.backup.id &&
      azurerm_role_assignment.restore_blob_read.principal_id == "00000000-0000-0000-0000-0000000000e1" &&
      azurerm_role_assignment.restore_blob_read.role_definition_name == "Storage Blob Data Reader"
    )
    error_message = "The backup identity can only create new blobs in the one container; the restore identity can only read it."
  }

  assert {
    condition = alltrue([
      for env in concat(azapi_resource.job_restore.body.properties.template.initContainers[0].env, azapi_resource.job_restore.body.properties.template.containers[0].env) :
      env.name != "BACKUP_BLOB"
    ])
    error_message = "The restore job names no dump by default; each execution must (infra/scripts/db-restore.sh)."
  }
}

run "client_files" {
  command = plan

  assert {
    condition = (
      !azurerm_storage_account.files.shared_access_key_enabled &&
      azurerm_storage_account.files.min_tls_version == "TLS1_2" &&
      !azurerm_storage_account.files.allow_nested_items_to_be_public &&
      azurerm_storage_account.files.default_to_oauth_authentication &&
      azurerm_storage_account.files.public_network_access == "Disabled" &&
      azurerm_storage_account.files.network_rules[0].default_action == "Deny" &&
      azurerm_storage_account.files.network_rules[0].bypass == toset(["None"]) &&
      length(azurerm_storage_account.files.network_rules[0].virtual_network_subnet_ids) == 0 &&
      length(azurerm_storage_account.files.network_rules[0].ip_rules) == 0 &&
      !azurerm_storage_account.files.blob_properties[0].versioning_enabled &&
      !azurerm_storage_account.files.blob_properties[0].change_feed_enabled &&
      azurerm_storage_account.files.blob_properties[0].delete_retention_policy[0].days == 7
    )
    error_message = "Client files: Entra ID only, TLS 1.2, public network access disabled, a deny-all firewall with no rules or bypass, no versions, soft delete 7 days."
  }

  assert {
    condition = (
      azurerm_private_endpoint.files.subnet_id == azurerm_subnet.endpoints.id &&
      azurerm_private_endpoint.files.private_service_connection[0].private_connection_resource_id == azurerm_storage_account.files.id &&
      azurerm_private_endpoint.files.private_service_connection[0].subresource_names == tolist(["blob"]) &&
      azurerm_private_dns_zone.blob.name == "privatelink.blob.core.windows.net" &&
      azurerm_private_endpoint.files.private_dns_zone_group[0].private_dns_zone_ids == tolist([azurerm_private_dns_zone.blob.id]) &&
      azurerm_private_dns_zone_virtual_network_link.blob.virtual_network_id == azurerm_virtual_network.main.id &&
      !azurerm_private_dns_zone_virtual_network_link.blob.registration_enabled
    )
    error_message = "One private endpoint (blob) in the endpoints subnet, resolved through privatelink.blob.core.windows.net linked to the VNet."
  }

  assert {
    condition = (
      azurerm_storage_container.client_raw.name == "client-raw" && azurerm_storage_container.client_raw.container_access_type == "private" &&
      azurerm_storage_container.client_clean.name == "client-clean" && azurerm_storage_container.client_clean.container_access_type == "private"
    )
    error_message = "Two private containers: client-raw (originals) and client-clean (cleaned copies)."
  }

  assert {
    condition = (
      azurerm_role_definition.client_files.permissions[0].data_actions == toset([
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete",
      ]) &&
      try(length(azurerm_role_definition.client_files.permissions[0].actions), 0) == 0
    )
    error_message = "The client files role has exactly four blob data actions and no actions: no container changes, no user delegation key, so no SAS."
  }

  assert {
    condition = (
      toset([for assignment in [azurerm_role_assignment.api_files_raw, azurerm_role_assignment.api_files_clean] : assignment.scope]) == toset([
        azurerm_storage_container.client_raw.id, azurerm_storage_container.client_clean.id,
      ]) &&
      alltrue([
        for assignment in [azurerm_role_assignment.api_files_raw, azurerm_role_assignment.api_files_clean] :
        assignment.principal_id == "00000000-0000-0000-0000-0000000000ee" &&
        assignment.role_definition_id == azurerm_role_definition.client_files.role_definition_resource_id
      ])
    )
    error_message = "The API identity holds the client files role on each container, never on the account."
  }

  assert {
    condition = toset([
      for assignment in [
        azurerm_role_assignment.api_acr_pull, azurerm_role_assignment.api_email,
        azurerm_role_assignment.api_files_raw, azurerm_role_assignment.api_files_clean,
      ] : assignment.scope if strcontains(assignment.scope, "/providers/Microsoft.Storage/")
      ]) == toset([azurerm_storage_container.client_raw.id, azurerm_storage_container.client_clean.id]) && alltrue([
      for assignment in concat(
        values(azurerm_role_assignment.job_secret_read), values(azurerm_role_assignment.job_acr_pull),
        [azurerm_role_assignment.backup_blob_create, azurerm_role_assignment.restore_blob_read],
      ) : !strcontains(assignment.scope, "/storageAccounts/sttwfiles")
    ])
    error_message = "The API identity's only storage roles are on the two client file containers (never the backup, audit or a models account), and no job identity has one on client files."
  }

  assert {
    condition = (
      azurerm_storage_management_policy.files.storage_account_id == azurerm_storage_account.files.id &&
      azurerm_storage_management_policy.files.rule[0].filters[0].prefix_match == toset(["client-raw/"]) &&
      azurerm_storage_management_policy.files.rule[0].actions[0].base_blob[0].delete_after_days_since_creation_greater_than == 400 &&
      length(azurerm_storage_management_policy.files.rule) == 1
    )
    error_message = "Originals are deleted by lifecycle after 400 days as a backstop; nothing deletes cleaned copies."
  }

  assert {
    condition = (
      azurerm_monitor_diagnostic_setting.files_blob.target_resource_id == "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Storage/storageAccounts/sttwfiles2d2c15bf/blobServices/default" &&
      azurerm_monitor_diagnostic_setting.files_blob.storage_account_id == azurerm_storage_account.audit.id &&
      azurerm_monitor_diagnostic_setting.files_blob.log_analytics_workspace_id == null &&
      toset([for log in azurerm_monitor_diagnostic_setting.files_blob.enabled_log : log.category]) == toset(["StorageRead", "StorageWrite", "StorageDelete"])
    )
    error_message = "Every blob read, write and delete is logged to the audit account only, never to the capped workspace."
  }

  assert {
    condition     = output.files_blob_endpoint == "https://sttwfiles2d2c15bf.blob.core.windows.net/"
    error_message = "The files account's blob endpoint is an output for api/production.env."
  }
}

run "backup_retention_locked" {
  command = plan

  variables {
    lock_backup_retention = true
  }

  assert {
    condition     = azurerm_storage_container_immutability_policy.backup.locked
    error_message = "lock_backup_retention locks the 30-day policy."
  }
}

run "one_identity_per_job" {
  command = plan

  assert {
    condition = (
      length(distinct([for job in [azapi_resource.job_backup, azapi_resource.job_db_users, azapi_resource.job_restore, azapi_resource.job_smoke] : one(job.identity).identity_ids[0]])) == 4 &&
      alltrue([
        for job, resource in {
          backup  = azapi_resource.job_backup, db-users = azapi_resource.job_db_users,
          restore = azapi_resource.job_restore, smoke = azapi_resource.job_smoke,
        } :
        tolist(one(resource.identity).identity_ids) == tolist([azurerm_user_assigned_identity.job[job].id]) &&
        alltrue([for secret in resource.body.properties.configuration.secrets : secret.identity == azurerm_user_assigned_identity.job[job].id]) &&
        alltrue([for registry in resource.body.properties.configuration.registries : registry.identity == azurerm_user_assigned_identity.job[job].id]) &&
        [for setting in resource.body.properties.configuration.identitySettings : setting.identity] == [azurerm_user_assigned_identity.job[job].id]
      ])
    )
    error_message = "Every job has its own identity, used for its own registry pull and secrets only."
  }

  assert {
    condition = (
      azapi_resource.job_backup.body.properties.configuration.identitySettings[0].lifecycle == "Main" &&
      azapi_resource.job_db_users.body.properties.configuration.identitySettings[0].lifecycle == "None" &&
      azapi_resource.job_restore.body.properties.configuration.identitySettings[0].lifecycle == "Init" &&
      azapi_resource.job_smoke.body.properties.configuration.identitySettings[0].lifecycle == "None"
    )
    error_message = "Only the upload (backup) and download (restore) containers can obtain a token; mongosh, mongodump, mongorestore and the smoke test cannot."
  }

  assert {
    condition = (
      [for secret in azapi_resource.job_smoke.body.properties.configuration.secrets : secret.name] == ["mongodb-uri"] &&
      [for secret in azapi_resource.job_restore.body.properties.configuration.secrets : secret.name] == ["mongodb-restore-uri"] &&
      [for secret in azapi_resource.job_backup.body.properties.configuration.secrets : secret.name] == ["mongodb-backup-uri"] &&
      alltrue([
        for job in [azapi_resource.job_backup, azapi_resource.job_db_users, azapi_resource.job_restore, azapi_resource.job_smoke] :
        job.body.properties.environmentId == azurerm_container_app_environment.main.id && alltrue([
          for secret in job.body.properties.configuration.secrets : startswith(secret.keyVaultUrl, "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/")
        ])
      ])
    )
    error_message = "The smoke test has only the app URI, restore only the restore URI, backup only the read-only URI; all are Key Vault references in the VNet environment."
  }
}

run "email_and_monitoring" {
  command = plan

  assert {
    condition = (
      azapi_update_resource.communication_local_auth.resource_id == azurerm_communication_service.main.id &&
      azapi_update_resource.communication_local_auth.body.properties.disableLocalAuth == true
    )
    error_message = "Communication Services access keys are disabled; the app sends with its managed identity."
  }

  assert {
    condition = (
      azurerm_monitor_diagnostic_setting.key_vault.target_resource_id == azurerm_key_vault.main.id &&
      azurerm_monitor_diagnostic_setting.key_vault.log_analytics_workspace_id == azurerm_log_analytics_workspace.main.id &&
      azurerm_monitor_diagnostic_setting.key_vault.storage_account_id == azurerm_storage_account.audit.id &&
      azurerm_storage_management_policy.audit.rule[0].actions[0].base_blob[0].delete_after_days_since_creation_greater_than == 365 &&
      tolist([for log in azurerm_monitor_diagnostic_setting.key_vault.enabled_log : log.category]) == tolist(["AuditEvent"]) &&
      azurerm_monitor_scheduled_query_rules_alert_v2.daily_cap.scopes == tolist([azurerm_log_analytics_workspace.main.id]) &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.daily_cap.criteria[0].query, "OverQuota") &&
      azurerm_monitor_scheduled_query_rules_alert_v2.daily_cap.action[0].action_groups == tolist([azurerm_monitor_action_group.ops.id])
    )
    error_message = "Key Vault audit events go to Log Analytics and to an uncapped archive kept a year, and reaching the daily cap sends an email."
  }

  assert {
    condition = (
      azurerm_monitor_scheduled_query_rules_alert_v2.backup_missing.scopes == tolist([azurerm_log_analytics_workspace.main.id]) &&
      azurerm_monitor_scheduled_query_rules_alert_v2.backup_missing.evaluation_frequency == "PT6H" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.backup_missing.window_duration == "P1D" &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.backup_missing.criteria[0].query, "ContainerAppConsoleLogs") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.backup_missing.criteria[0].query, "uploaded townwise-") &&
      strcontains(file("files/backup-upload.sh"), "echo \"uploaded $name") &&
      azurerm_monitor_scheduled_query_rules_alert_v2.backup_missing.criteria[0].operator == "LessThan" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.backup_missing.criteria[0].threshold == 1 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.backup_missing.action[0].action_groups == tolist([azurerm_monitor_action_group.ops.id])
    )
    error_message = "A day without the backup job's upload line emails the ops address."
  }
}

run "lab_disabled" {
  command = plan

  assert {
    condition = (
      length(azapi_resource.job_lab) == 0 && length(azurerm_user_assigned_identity.lab) == 0 &&
      length(azurerm_role_assignment.lab_acr_pull) == 0 && length(azurerm_role_definition.lab_starter) == 0 &&
      length(azurerm_role_assignment.lab_start) == 0 && length(azurerm_role_assignment.deployer_lab_job) == 0 &&
      output.lab_job_id == null
    )
    error_message = "With enable_lab false (the default), no lab resource exists and lab_job_id is null."
  }

  assert {
    condition = (
      length(azapi_resource.job_forecasts) == 0 && !contains(keys(azurerm_user_assigned_identity.job), "forecasts") &&
      length(azurerm_role_assignment.forecasts_lab_start) == 0 && length(azurerm_role_assignment.deployer_forecasts_job) == 0 &&
      length(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed) == 0 &&
      length(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing) == 0 &&
      length(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed) == 0 &&
      length(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held) == 0
    )
    error_message = "With enable_lab false, the weekly forecast worker, its identity, its grants and its alerts do not exist."
  }

  assert {
    condition     = !anytrue([for env in azurerm_container_app.api.template[0].container[0].env : startswith(env.name, "TOWNWISE_LAB_")])
    error_message = "With enable_lab false, the API has no TOWNWISE_LAB_ variable."
  }
}

run "lab_requires_image" {
  command = plan

  variables {
    enable_lab             = true
    lab_callback_client_id = "22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [azapi_resource.job_lab]
}

run "lab_requires_callback_app" {
  command = plan

  variables {
    enable_lab = true
    lab_image  = "crtownwise2d2c15bf.azurecr.io/townwise-lab@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  }

  expect_failures = [azapi_resource.job_lab]
}

run "lab_callback_client_id_is_a_guid" {
  command = plan

  variables {
    lab_callback_client_id = "api://22222222-2222-4222-8222-222222222222"
  }

  expect_failures = [var.lab_callback_client_id]
}

# Entra emits lowercase GUIDs and the API compares aud exactly, so an uppercase id would refuse every lab token.
run "lab_callback_client_id_is_lowercase" {
  command = plan

  variables {
    lab_callback_client_id = "2222222A-2222-4222-8222-222222222222"
  }

  expect_failures = [var.lab_callback_client_id]
}

run "lab_enabled" {
  command = plan

  variables {
    enable_lab             = true
    lab_image              = "crtownwise2d2c15bf.azurecr.io/townwise-lab@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    lab_callback_client_id = "22222222-2222-4222-8222-222222222222"
  }

  assert {
    condition = (
      azapi_resource.job_lab[0].name == "caj-townwise-lab" &&
      azapi_resource.job_lab[0].type == "Microsoft.App/jobs@2025-07-01" &&
      azapi_resource.job_lab[0].body.properties.environmentId == azurerm_container_app_environment.main.id &&
      azapi_resource.job_lab[0].body.properties.workloadProfileName == "Consumption" &&
      azapi_resource.job_lab[0].body.properties.configuration.triggerType == "Manual" &&
      azapi_resource.job_lab[0].body.properties.configuration.manualTriggerConfig == { parallelism = 1, replicaCompletionCount = 1 } &&
      azapi_resource.job_lab[0].body.properties.configuration.replicaTimeout == 900 &&
      azapi_resource.job_lab[0].body.properties.configuration.replicaRetryLimit == 0
    )
    error_message = "The lab job is manual, one replica per execution on the Consumption profile, 900 seconds, and never retried."
  }

  assert {
    condition = (
      length(azapi_resource.job_lab[0].body.properties.configuration.secrets) == 0 &&
      [for setting in azapi_resource.job_lab[0].body.properties.configuration.identitySettings : setting.lifecycle] == ["Main"] &&
      [for setting in azapi_resource.job_lab[0].body.properties.configuration.identitySettings : setting.identity] == [azurerm_user_assigned_identity.lab[0].id] &&
      [for registry in azapi_resource.job_lab[0].body.properties.configuration.registries : registry.identity] == [azurerm_user_assigned_identity.lab[0].id] &&
      tolist(one(azapi_resource.job_lab[0].identity).identity_ids) == tolist([azurerm_user_assigned_identity.lab[0].id])
    )
    error_message = "The lab job has no secrets, pulls its image with the lab identity, and only its main container can obtain a token for it (to sign in to the lab callback)."
  }

  assert {
    condition = (
      length(azapi_resource.job_lab[0].body.properties.template.containers) == 1 &&
      azapi_resource.job_lab[0].body.properties.template.containers[0].name == "lab" &&
      azapi_resource.job_lab[0].body.properties.template.containers[0].image == var.lab_image &&
      azapi_resource.job_lab[0].body.properties.template.containers[0].resources.cpu == 1 &&
      azapi_resource.job_lab[0].body.properties.template.containers[0].resources.memory == "2Gi" &&
      azapi_resource.job_lab[0].body.properties.template.containers[0].env == [
        { name = "TOWNWISE_LAB_API_URL", value = "https://${azurerm_container_app.api.ingress[0].fqdn}" },
        { name = "AZURE_CLIENT_ID", value = "00000000-0000-0000-0000-0000000001d1" },
        { name = "TOWNWISE_LAB_TOKEN_RESOURCE", value = "api://22222222-2222-4222-8222-222222222222" },
      ] &&
      !anytrue([for env in azapi_resource.job_lab[0].body.properties.template.containers[0].env : env.name == "TOWNWISE_LAB_TOKEN"])
    )
    error_message = "One container, lab, at lab_image with 1 vCPU and 2Gi; its environment holds the API URL and what it signs in with (the lab identity's client id and the lab callback app's identifier URI), and no secret."
  }

  assert {
    condition = (
      azurerm_role_definition.lab_starter[0].name == "Townwise lab starter" &&
      toset(one(azurerm_role_definition.lab_starter[0].permissions).actions) == toset(["Microsoft.App/jobs/read", "Microsoft.App/jobs/start/action"]) &&
      length(one(azurerm_role_definition.lab_starter[0].permissions).actions) == 2 &&
      try(length(one(azurerm_role_definition.lab_starter[0].permissions).data_actions), 0) == 0 &&
      try(length(one(azurerm_role_definition.lab_starter[0].permissions).not_actions), 0) == 0
    )
    error_message = "The lab starter role reads the job and starts it, with no data actions."
  }

  assert {
    condition = (
      azurerm_role_assignment.lab_start[0].scope == azapi_resource.job_lab[0].id &&
      azurerm_role_assignment.lab_start[0].principal_id == azurerm_user_assigned_identity.api.principal_id &&
      azurerm_role_assignment.lab_start[0].role_definition_id == azurerm_role_definition.lab_starter[0].role_definition_resource_id
    )
    error_message = "The API identity holds the lab starter role at the lab job and nowhere else."
  }

  assert {
    condition = (
      azurerm_role_assignment.lab_acr_pull[0].role_definition_name == "AcrPull" &&
      azurerm_role_assignment.lab_acr_pull[0].scope == azurerm_container_registry.main.id &&
      azurerm_role_assignment.lab_acr_pull[0].principal_id == azurerm_user_assigned_identity.lab[0].principal_id &&
      # Every other role assignment in the module (the list rbac_scopes checks, plus the lab's own).
      !contains([
        for assignment in concat(
          values(azurerm_role_assignment.api_secret_read), values(azurerm_role_assignment.deployer),
          values(azurerm_role_assignment.job_secret_read), values(azurerm_role_assignment.job_acr_pull),
          [azurerm_role_assignment.api_acr_pull, azurerm_role_assignment.api_email, azurerm_role_assignment.deploy_acr_push],
          [azurerm_role_assignment.backup_blob_create, azurerm_role_assignment.restore_blob_read],
          [azurerm_role_assignment.api_files_raw, azurerm_role_assignment.api_files_clean],
          [azurerm_role_assignment.lab_start[0], azurerm_role_assignment.deployer_lab_job[0]],
          [azurerm_role_assignment.forecasts_lab_start[0], azurerm_role_assignment.deployer_forecasts_job[0]],
        ) : assignment.principal_id
      ], azurerm_user_assigned_identity.lab[0].principal_id)
    )
    error_message = "The lab identity holds AcrPull on the registry and nothing else."
  }

  assert {
    condition = (
      azurerm_role_assignment.deployer_lab_job[0].scope == azapi_resource.job_lab[0].id &&
      azurerm_role_assignment.deployer_lab_job[0].role_definition_id == azurerm_role_definition.deployer.role_definition_resource_id &&
      azurerm_role_assignment.deployer_lab_job[0].principal_id == "00000000-0000-0000-0000-0000000000aa"
    )
    error_message = "The deploy identity updates the lab job with the deployer role, scoped to that one job."
  }

  assert {
    condition = (
      contains([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${env.value}" if env.value != null], "TOWNWISE_LAB_RUNNER=azure") &&
      contains([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${env.value}" if env.value != null], "TOWNWISE_LAB_JOB_ID=/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.App/jobs/caj-townwise-lab") &&
      output.lab_job_id == "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.App/jobs/caj-townwise-lab"
    )
    error_message = "With enable_lab, the API runs calibrations in the Azure job and knows its resource id."
  }

  assert {
    condition = (
      contains([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${env.value}" if env.value != null], "TOWNWISE_LAB_AUDIENCE=22222222-2222-4222-8222-222222222222") &&
      contains([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${env.value}" if env.value != null], "TOWNWISE_LAB_CALLER_ID=00000000-0000-0000-0000-0000000000d1") &&
      contains([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${env.value}" if env.value != null], "TOWNWISE_LAB_TENANT_ID=37acb94f-e2d9-41d9-a697-1bd7a1d60bf1") &&
      length([for env in azurerm_container_app.api.template[0].container[0].env : env.name if startswith(env.name, "TOWNWISE_LAB_")]) == 5
    )
    error_message = "The API accepts the lab callback only from the lab identity (its principal id), with a token for the lab callback app (its client id) from this tenant."
  }

  # TOWNWISE_LAB_JOB_ID is built from names (lab.tf, to avoid a cycle). It must name the resource the job
  # itself declares: its parent, its type without the API version, and its name, which is how an ARM id is
  # formed. The mocked plan has no real azapi id (the override above fills it in that same form), so the
  # check against output.lab_job_id only pins that the output and the API's variable carry one value.
  assert {
    condition = (
      one([for env in azurerm_container_app.api.template[0].container[0].env : env.value if env.name == "TOWNWISE_LAB_JOB_ID"]) ==
      "${azapi_resource.job_lab[0].parent_id}/providers/${split("@", azapi_resource.job_lab[0].type)[0]}/${azapi_resource.job_lab[0].name}" &&
      one([for env in azurerm_container_app.api.template[0].container[0].env : env.value if env.name == "TOWNWISE_LAB_JOB_ID"]) == output.lab_job_id
    )
    error_message = "TOWNWISE_LAB_JOB_ID names the lab job Terraform declares (its parent, type and name), the same id lab_job_id outputs."
  }
}

# The weekly forecast worker (D42; jobs.tf): the API image running one pass an hour, created with the lab.
run "forecasts_worker" {
  command = plan

  variables {
    enable_lab             = true
    lab_image              = "crtownwise2d2c15bf.azurecr.io/townwise-lab@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    lab_callback_client_id = "22222222-2222-4222-8222-222222222222"
  }

  assert {
    condition = (
      azapi_resource.job_forecasts[0].name == "caj-townwise-forecasts" &&
      azapi_resource.job_forecasts[0].type == "Microsoft.App/jobs@2025-07-01" &&
      azapi_resource.job_forecasts[0].body.properties.environmentId == azurerm_container_app_environment.main.id &&
      azapi_resource.job_forecasts[0].body.properties.workloadProfileName == "Consumption" &&
      azapi_resource.job_forecasts[0].body.properties.configuration.triggerType == "Schedule" &&
      azapi_resource.job_forecasts[0].body.properties.configuration.scheduleTriggerConfig == { cronExpression = "5 * * * *", parallelism = 1, replicaCompletionCount = 1 } &&
      azapi_resource.job_forecasts[0].body.properties.configuration.replicaTimeout == 600 &&
      azapi_resource.job_forecasts[0].body.properties.configuration.replicaRetryLimit == 0
    )
    error_message = "The worker job runs at five past every hour, one replica on the Consumption profile, 600 seconds, never retried."
  }

  assert {
    condition = (
      length(azapi_resource.job_forecasts[0].body.properties.template.containers) == 1 &&
      azapi_resource.job_forecasts[0].body.properties.template.containers[0].name == "weekly-forecasts" &&
      azapi_resource.job_forecasts[0].body.properties.template.containers[0].image == var.api_image &&
      azapi_resource.job_forecasts[0].body.properties.template.containers[0].command == ["node", "--env-file=api/production.env", "api/src/workers/weekly-forecasts.ts"] &&
      azapi_resource.job_forecasts[0].body.properties.template.containers[0].resources.cpu == 0.25 &&
      azapi_resource.job_forecasts[0].body.properties.template.containers[0].resources.memory == "0.5Gi" &&
      # The override runs from the image's working directory and keeps its --env-file, as the image's CMD does.
      fileexists("../../../api/src/workers/weekly-forecasts.ts") &&
      strcontains(file("../../../api/Dockerfile"), "WORKDIR /app") &&
      strcontains(file("../../../api/Dockerfile"), "CMD [\"node\", \"--env-file=api/production.env\", \"api/src/main.ts\"]")
    )
    error_message = "One container, weekly-forecasts, at the API image with 0.25 vCPU and 0.5Gi, running the worker with the image's production.env."
  }

  assert {
    condition = (
      [for secret in azapi_resource.job_forecasts[0].body.properties.configuration.secrets : secret.name] == ["mongodb-uri"] &&
      [for secret in azapi_resource.job_forecasts[0].body.properties.configuration.secrets : secret.keyVaultUrl] == ["https://kv-townwise-2d2c15bf.vault.azure.net/secrets/mongodb-uri"] &&
      [for secret in azapi_resource.job_forecasts[0].body.properties.configuration.secrets : secret.identity] == [azurerm_user_assigned_identity.job["forecasts"].id] &&
      [for setting in azapi_resource.job_forecasts[0].body.properties.configuration.identitySettings : setting.identity] == [azurerm_user_assigned_identity.job["forecasts"].id] &&
      [for setting in azapi_resource.job_forecasts[0].body.properties.configuration.identitySettings : setting.lifecycle] == ["Main"] &&
      [for registry in azapi_resource.job_forecasts[0].body.properties.configuration.registries : registry.identity] == [azurerm_user_assigned_identity.job["forecasts"].id] &&
      tolist(one(azapi_resource.job_forecasts[0].identity).identity_ids) == tolist([azurerm_user_assigned_identity.job["forecasts"].id]) &&
      azurerm_user_assigned_identity.job["forecasts"].name == "id-townwise-job-forecasts"
    )
    error_message = "The worker has its own identity, used for its image pull and its one secret, mongodb-uri, and its container can obtain a token (to start the lab job)."
  }

  assert {
    condition = azapi_resource.job_forecasts[0].body.properties.template.containers[0].env == [
      { name = "MONGODB_URI", secretRef = "mongodb-uri" },
      { name = "AZURE_CLIENT_ID", value = "00000000-0000-0000-0000-0000000001a2" },
      { name = "TOWNWISE_LAB_RUNNER", value = "azure" },
      { name = "TOWNWISE_LAB_JOB_ID", value = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.App/jobs/caj-townwise-lab" },
      { name = "TOWNWISE_LAB_AUDIENCE", value = "22222222-2222-4222-8222-222222222222" },
      { name = "TOWNWISE_LAB_CALLER_ID", value = "00000000-0000-0000-0000-0000000000d1" },
      { name = "TOWNWISE_LAB_TENANT_ID", value = "37acb94f-e2d9-41d9-a697-1bd7a1d60bf1" },
    ]
    error_message = "The worker gets the database from Key Vault, its own client id, and the lab runner's variables with the API's values (labRunnerOf requires all four)."
  }

  assert {
    condition = (
      toset([for env in azapi_resource.job_forecasts[0].body.properties.template.containers[0].env : "${env.name}=${env.value}" if startswith(env.name, "TOWNWISE_LAB_") && env.name != "TOWNWISE_LAB_RUNNER"]) ==
      toset([for env in azurerm_container_app.api.template[0].container[0].env : "${env.name}=${env.value}" if startswith(env.name, "TOWNWISE_LAB_") && env.name != "TOWNWISE_LAB_RUNNER"])
    )
    error_message = "The worker's lab variables are the API's, so the two resolve one lab configuration."
  }

  assert {
    condition = (
      azurerm_role_assignment.forecasts_lab_start[0].scope == azapi_resource.job_lab[0].id &&
      azurerm_role_assignment.forecasts_lab_start[0].role_definition_id == azurerm_role_definition.lab_starter[0].role_definition_resource_id &&
      azurerm_role_assignment.forecasts_lab_start[0].principal_id == "00000000-0000-0000-0000-0000000000a2" &&
      azurerm_role_assignment.job_acr_pull["forecasts"].role_definition_name == "AcrPull" &&
      azurerm_role_assignment.job_acr_pull["forecasts"].scope == azurerm_container_registry.main.id &&
      azurerm_role_assignment.job_secret_read["forecasts/mongodb-uri"].scope == "${azurerm_key_vault.main.id}/secrets/mongodb-uri" &&
      azurerm_role_assignment.job_secret_read["forecasts/mongodb-uri"].role_definition_name == "Key Vault Secrets User" &&
      # Every role assignment in the module: the worker's identity appears in exactly those three.
      length([
        for assignment in concat(
          values(azurerm_role_assignment.api_secret_read), values(azurerm_role_assignment.deployer),
          values(azurerm_role_assignment.job_secret_read), values(azurerm_role_assignment.job_acr_pull),
          [azurerm_role_assignment.api_acr_pull, azurerm_role_assignment.api_email, azurerm_role_assignment.deploy_acr_push],
          [azurerm_role_assignment.backup_blob_create, azurerm_role_assignment.restore_blob_read],
          [azurerm_role_assignment.api_files_raw, azurerm_role_assignment.api_files_clean],
          [azurerm_role_assignment.lab_start[0], azurerm_role_assignment.deployer_lab_job[0], azurerm_role_assignment.lab_acr_pull[0]],
          [azurerm_role_assignment.forecasts_lab_start[0], azurerm_role_assignment.deployer_forecasts_job[0]],
        ) : assignment if assignment.principal_id == "00000000-0000-0000-0000-0000000000a2"
      ]) == 3
    )
    error_message = "The worker's identity holds AcrPull, the mongodb-uri secret and the lab starter role at the lab job, and nothing else."
  }

  assert {
    condition = (
      azurerm_role_assignment.deployer_forecasts_job[0].scope == azapi_resource.job_forecasts[0].id &&
      azurerm_role_assignment.deployer_forecasts_job[0].role_definition_id == azurerm_role_definition.deployer.role_definition_resource_id &&
      azurerm_role_assignment.deployer_forecasts_job[0].principal_id == "00000000-0000-0000-0000-0000000000aa"
    )
    error_message = "The deploy identity updates the worker job (its image) with the deployer role, scoped to that one job."
  }

  assert {
    condition = (
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].scopes == tolist([azurerm_log_analytics_workspace.main.id]) &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].evaluation_frequency == "PT1H" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].window_duration == "PT1H" &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].query, "ContainerAppConsoleLogs") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].query, "toint(line.failed) > 0") &&
      alltrue([for line in ["townwise.weekly_worker_failed", "townwise.weekly_worker_refused"] :
        strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].query, "\"${line}\"") &&
      strcontains(file("../../../api/src/workers/weekly-forecasts.ts"), "'${line}'")]) &&
      alltrue([for line in [
        "townwise.weekly_refresh_location_failed", "townwise.weekly_refresh_pass", "townwise.weekly_suggestions_location_failed",
        "townwise.weekly_suggestions_pass",
        ] :
        strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].query, "\"${line}\"") &&
      strcontains(file("../../../api/src/lab/schedule.ts"), "'${line}'")]) &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].query, "toint(line.capped) > 0") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].query, "\"townwise.calibration_finished\"") &&
      strcontains(file("../../../api/src/lab/service.ts"), "'townwise.calibration_finished'") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].query, "tostring(line.via) == \"scheduled\"") &&
      strcontains(file("../../../api/src/lab/service.ts"), "via: record.requestedBy.via") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].query, "tostring(line.status) == \"failed\"") &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].operator == "GreaterThan" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].criteria[0].threshold == 0 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_failed[0].action[0].action_groups == tolist([azurerm_monitor_action_group.ops.id])
    )
    error_message = "A pass that failed a start or a location, a scheduled calibration that failed after it started, or a worker that stopped on an error, emails the ops address within the hour; the lines it looks for are the ones the code logs."
  }

  assert {
    condition = (
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing[0].scopes == tolist([azurerm_log_analytics_workspace.main.id]) &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing[0].evaluation_frequency == "PT6H" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing[0].window_duration == "P1D" &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing[0].criteria[0].query, "ContainerAppConsoleLogs") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing[0].criteria[0].query, "\"townwise.weekly_refresh_pass\"") &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing[0].criteria[0].operator == "LessThan" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing[0].criteria[0].threshold == 1 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_missing[0].action[0].action_groups == tolist([azurerm_monitor_action_group.ops.id])
    )
    error_message = "A day without a pass line from the worker emails the ops address."
  }

  assert {
    condition = (
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].scopes == tolist([azurerm_log_analytics_workspace.main.id]) &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].evaluation_frequency == "PT1H" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].window_duration == "PT2H" &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].criteria[0].query, "ContainerAppConsoleLogs") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].criteria[0].query, "leftanti") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].criteria[0].query, "line.hostname") &&
      alltrue([for line in ["townwise.weekly_worker_started", "townwise.weekly_worker_failed", "townwise.weekly_worker_refused"] :
        strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].criteria[0].query, "\"${line}\"") &&
      strcontains(file("../../../api/src/workers/weekly-forecasts.ts"), "'${line}'")]) &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].criteria[0].query, "\"townwise.weekly_refresh_pass\"") &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].criteria[0].operator == "GreaterThan" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].criteria[0].threshold == 0 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_killed[0].action[0].action_groups == tolist([azurerm_monitor_action_group.ops.id])
    )
    error_message = "An execution that logged its start and never its pass (killed by the job's timeout, or crashed) emails the ops address; the lines it pairs are the ones the worker logs."
  }

  assert {
    condition = (
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0].scopes == tolist([azurerm_log_analytics_workspace.main.id]) &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0].evaluation_frequency == "PT1H" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0].window_duration == "PT1H" &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0].criteria[0].query, "ContainerAppConsoleLogs") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0].criteria[0].query, "\"townwise.calibration_finished\"") &&
      strcontains(file("../../../api/src/lab/service.ts"), "'townwise.calibration_finished'") &&
      strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0].criteria[0].query, "tostring(line.gate) == \"jump_held\"") &&
      strcontains(file("../../../api/src/lab/gate.ts"), "'jump_held'") &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0].criteria[0].operator == "GreaterThan" &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0].criteria[0].threshold == 0 &&
      azurerm_monitor_scheduled_query_rules_alert_v2.forecasts_held[0].action[0].action_groups == tolist([azurerm_monitor_action_group.ops.id])
    )
    error_message = "A draft the gate held jump_held emails the ops address within the hour, so staff publish or withdraw it; the line and reason it reads are the ones the API logs."
  }
}

run "forecasts_worker_with_chat" {
  command = plan

  variables {
    enable_lab             = true
    enable_chat            = true
    lab_image              = "crtownwise2d2c15bf.azurecr.io/townwise-lab@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    lab_callback_client_id = "22222222-2222-4222-8222-222222222222"
  }

  assert {
    condition = (
      [for secret in azapi_resource.job_forecasts[0].body.properties.configuration.secrets : secret.name] == ["mongodb-uri", "anthropic-api-key"] &&
      [for secret in azapi_resource.job_forecasts[0].body.properties.configuration.secrets : secret.keyVaultUrl] == [
        "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/mongodb-uri",
        "https://kv-townwise-2d2c15bf.vault.azure.net/secrets/anthropic-api-key",
      ] &&
      alltrue([for secret in azapi_resource.job_forecasts[0].body.properties.configuration.secrets : secret.identity == azurerm_user_assigned_identity.job["forecasts"].id])
    )
    error_message = "With the chat on, the worker also reads the Anthropic key as a Key Vault reference, with its own identity."
  }

  assert {
    condition = (
      [for env in azapi_resource.job_forecasts[0].body.properties.template.containers[0].env : env if env.name == "ANTHROPIC_API_KEY"] == [{ name = "ANTHROPIC_API_KEY", secretRef = "anthropic-api-key" }] &&
      length(azapi_resource.job_forecasts[0].body.properties.template.containers[0].env) == 8 &&
      strcontains(file("../../../api/src/workers/weekly-forecasts.ts"), "ANTHROPIC_API_KEY")
    )
    error_message = "With the chat on, the worker's ANTHROPIC_API_KEY (which it reads for weekly suggestions) is the anthropic-api-key reference, with no value in Terraform."
  }

  assert {
    condition = (
      azurerm_role_assignment.job_secret_read["forecasts/anthropic-api-key"].scope == "${azurerm_key_vault.main.id}/secrets/anthropic-api-key" &&
      azurerm_role_assignment.job_secret_read["forecasts/anthropic-api-key"].role_definition_name == "Key Vault Secrets User" &&
      length([
        for assignment in values(azurerm_role_assignment.job_secret_read) : assignment
        if assignment.principal_id == azurerm_user_assigned_identity.job["forecasts"].principal_id
      ]) == 2
    )
    error_message = "With the chat on, the worker's identity reads exactly two secrets, mongodb-uri and anthropic-api-key, each by its own secret-scoped assignment."
  }
}
