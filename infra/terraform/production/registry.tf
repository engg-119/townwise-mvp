# Private registry for the API image and the imported Valkey image. Entra auth only: no admin user, no
# anonymous pull. The app pulls with its own identity (AcrPull); the deploy identity pushes (deploy.tf).
resource "azurerm_container_registry" "main" {
  name                   = "crtownwise${local.suffix}"
  resource_group_name    = local.rg
  location               = local.location
  sku                    = "Basic"
  admin_enabled          = false
  anonymous_pull_enabled = false
  #checkov:skip=CKV_AZURE_139:public network access is needed: GitHub-hosted runners push over the internet, and private endpoints need the Premium SKU
  #checkov:skip=CKV_AZURE_163:vulnerability scanning needs Defender for Containers, a paid plan
  #checkov:skip=CKV_AZURE_164:content trust needs the Premium SKU
  #checkov:skip=CKV_AZURE_165:geo-replication needs the Premium SKU
  #checkov:skip=CKV_AZURE_166:quarantine needs the Premium SKU
  #checkov:skip=CKV_AZURE_167:retention policy needs the Premium SKU
  #checkov:skip=CKV_AZURE_233:zone redundancy needs the Premium SKU
  #checkov:skip=CKV_AZURE_237:dedicated data endpoints need the Premium SKU
}

resource "azurerm_role_assignment" "api_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.api.principal_id
  principal_type       = "ServicePrincipal"
}
