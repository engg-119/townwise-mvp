terraform {
  required_version = ">= 1.10.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.11.0" # 5.12.0 is inside the 7-day release-age window
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.10"
    }
  }

  # The state account is created by this stack. The first apply runs on local state, then the state moves
  # here (infra/README.md, step 1). Entra ID auth only: the account has shared keys disabled. This
  # container is admin-only; production state is in "tfstate".
  backend "azurerm" {
    resource_group_name  = "rg-townwise-bootstrap"
    storage_account_name = "sttwtfstate2d2c15bf"
    container_name       = "tfstate-admin"
    key                  = "bootstrap.tfstate"
    use_azuread_auth     = true
  }
}

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  # The applier is a subscription Owner; register the providers the production stack needs, once.
  resource_provider_registrations = "core"
  resource_providers_to_register = [
    "Microsoft.AlertsManagement",
    "Microsoft.App",
    "Microsoft.Communication",
    "Microsoft.ContainerRegistry",
    "Microsoft.Consumption",
    "Microsoft.DocumentDB",
    "Microsoft.Insights",
    "Microsoft.KeyVault",
    "Microsoft.ManagedIdentity",
    "Microsoft.Network",
    "Microsoft.OperationalInsights",
    "Microsoft.Storage",
    "Microsoft.Web",
  ]

  features {}
}

provider "azuread" {
  tenant_id = var.tenant_id
}
