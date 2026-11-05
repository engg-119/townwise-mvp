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
      !var.enable_chat &&
      !contains([for secret in azurerm_container_app.api.secret : secret.name], "anthropic-api-key") &&
      !contains([for env in azurerm_container_app.api.template[0].container[0].env : env.name], "ANTHROPIC_API_KEY")
    )
    error_message = "By default the tuning chat is off: no Anthropic key secret, no ANTHROPIC_API_KEY, no role on it."
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

run "rbac_scopes" {
  command = plan

  assert {
    condition = alltrue([
      for assignment in concat(
        values(azurerm_role_assignment.api_secret_read), values(azurerm_role_assignment.deployer),
        values(azurerm_role_assignment.job_secret_read), values(azurerm_role_assignment.job_acr_pull),
        [azurerm_role_assignment.api_acr_pull, azurerm_role_assignment.api_email, azurerm_role_assignment.deploy_acr_push],
        [azurerm_role_assignment.backup_blob_create, azurerm_role_assignment.restore_blob_read],
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
    ]) && azurerm_role_assignment.api_email.role_definition_id == azurerm_role_definition.email_sender.role_definition_resource_id
    error_message = "No Owner or Contributor anywhere in production; the deploy and email grants use their custom roles."
  }

  assert {
    condition = (
      toset(azurerm_role_definition.deployer.permissions[0].actions) == toset([
        "Microsoft.App/containerApps/read",
        "Microsoft.App/containerApps/write",
        "Microsoft.App/containerApps/revisions/read",
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
      "Content-Security-Policy"    = "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.townwise.tech https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
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
        "Allow Inbound 10.40.0.0/24 10260", "Deny Inbound * *",
      ]) &&
      azurerm_subnet.endpoints.private_endpoint_network_policies == "NetworkSecurityGroupEnabled" &&
      azurerm_subnet_network_security_group_association.endpoints.subnet_id == azurerm_subnet.endpoints.id
    )
    error_message = "The endpoint subnet's NSG admits only the apps subnet, only on 10260, and is enforced on private endpoints."
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
