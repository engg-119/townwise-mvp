# The Expo web export on Static Web Apps (Free). Headers and the single-page fallback come from
# infra/web/staticwebapp.config.json, which the deploy workflow puts in the uploaded build. Static Web Apps
# is offered in a few regions only (not eastus); eastus2 holds the metadata, and content is served globally.
resource "azurerm_static_web_app" "web" {
  name                               = "swa-townwise"
  resource_group_name                = local.rg
  location                           = "eastus2"
  sku_tier                           = "Free"
  sku_size                           = "Free"
  preview_environments_enabled       = false
  configuration_file_changes_enabled = true
}

# Both custom domains validate with a TXT token at _dnsauth.<host> (dns.tf); the apex must.
resource "azurerm_static_web_app_custom_domain" "apex" {
  static_web_app_id = azurerm_static_web_app.web.id
  domain_name       = local.domain
  validation_type   = "dns-txt-token"
}

resource "azurerm_static_web_app_custom_domain" "www" {
  static_web_app_id = azurerm_static_web_app.web.id
  domain_name       = "www.${local.domain}"
  validation_type   = "dns-txt-token"
}
