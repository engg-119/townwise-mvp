# What the deploy identity (bootstrap/github.tf) may do, each grant scoped to one resource:
# push to the registry, update the one Container App, and read the Static Web App deployment token.
# No subscription or resource-group scope, no Key Vault, no listSecrets on the Container App.

resource "azurerm_role_definition" "deployer" {
  name              = "Townwise deployer"
  scope             = data.azurerm_resource_group.prod.id
  description       = "Update the Townwise API image and read the Static Web App deployment token."
  assignable_scopes = [data.azurerm_resource_group.prod.id]

  permissions {
    actions = [
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/write",
      "Microsoft.App/containerApps/revisions/read",
      "Microsoft.App/managedEnvironments/read",
      "Microsoft.App/managedEnvironments/join/action",
      "Microsoft.ContainerRegistry/registries/read",
      "Microsoft.Web/staticSites/read",
      "Microsoft.Web/staticSites/listSecrets/action",
    ]
  }
}

# Assigned at each resource, so each action applies only where it belongs (for example containerApps/write
# only on the API, join only on its environment).
resource "azurerm_role_assignment" "deployer" {
  for_each = {
    container_app = azurerm_container_app.api.id
    environment   = azurerm_container_app_environment.main.id
    registry      = azurerm_container_registry.main.id
    static_web    = azurerm_static_web_app.web.id
  }
  scope              = each.value
  role_definition_id = azurerm_role_definition.deployer.role_definition_resource_id
  principal_id       = data.azurerm_user_assigned_identity.deploy.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "deploy_acr_push" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = data.azurerm_user_assigned_identity.deploy.principal_id
  principal_type       = "ServicePrincipal"
}
