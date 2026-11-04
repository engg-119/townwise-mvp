# Townwise production on Azure: the API on Container Apps (Consumption profile, in vnet-townwise), the
# database on Azure DocumentDB (free tier, private endpoint only) with nightly dumps to Blob Storage, the web
# app on Static Web Apps (Free), secrets in Key Vault, DNS in Azure DNS, email through Communication Services.
# This is Townwise-specific code; the camkeith/modules kit is AWS-only.

data "azurerm_client_config" "current" {}

data "azurerm_resource_group" "prod" {
  name = "rg-townwise-prod"
}

data "azurerm_user_assigned_identity" "deploy" {
  name                = "id-townwise-gha-deploy"
  resource_group_name = "rg-townwise-bootstrap"
}

locals {
  rg         = data.azurerm_resource_group.prod.name
  location   = data.azurerm_resource_group.prod.location
  suffix     = substr(replace(var.subscription_id, "-", ""), 0, 8)
  domain     = "townwise.tech"
  api_domain = "api.${local.domain}"

  # Key Vault secret name => the env var the API's schema reads (backend/mongo, backend/auth MODULE.md).
  # Terraform creates no values; infra/scripts/set-secret.sh seeds them.
  api_secrets = {
    "mongodb-uri"          = "MONGODB_URI"
    "auth-jwt-keys"        = "AUTH_JWT_KEYS"
    "auth-encryption-keys" = "AUTH_ENCRYPTION_KEYS"
  }
}
