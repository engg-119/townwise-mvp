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

  # Key Vault secret name => the env var the API's schema reads (api/kit/mongo, api/kit/auth MODULE.md).
  # Terraform creates no values; infra/scripts/set-secret.sh seeds them. The tuning chat's key joins the map only
  # when enable_chat is true (infra/README.md, "Enable the tuning chat"), and the Google Places key, the Maps Static
  # key and its URL signing secret only when enable_places is true ("Enable the Places search"), the calendar key,
  # which seals owner calendar links and Google's access (api/src/calendar/secret.ts), only when enable_calendar_links
  # is true ("Calendar links"), and the Google OAuth web client's secret only when enable_google_calendar is true
  # ("Google calendars"); without its key, each feature is off.
  api_secrets = merge(
    {
      "mongodb-uri"          = "MONGODB_URI"
      "auth-jwt-keys"        = "AUTH_JWT_KEYS"
      "auth-encryption-keys" = "AUTH_ENCRYPTION_KEYS"
    },
    { for name, env in { "anthropic-api-key" = "ANTHROPIC_API_KEY" } : name => env if var.enable_chat },
    { for name, env in { "townwise-calendar-key" = "TOWNWISE_CALENDAR_KEY" } : name => env if var.enable_calendar_links },
    { for name, env in { "townwise-google-calendar-secret" = "TOWNWISE_GOOGLE_CALENDAR_CLIENT_SECRET" } : name => env if var.enable_google_calendar },
    { for name, env in {
      "google-places-api-key"      = "GOOGLE_PLACES_API_KEY"
      "google-maps-static-key"     = "GOOGLE_MAPS_STATIC_KEY"
      "google-maps-signing-secret" = "GOOGLE_MAPS_SIGNING_SECRET"
    } : name => env if var.enable_places },
  )
}
