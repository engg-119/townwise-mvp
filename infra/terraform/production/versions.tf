terraform {
  # 1.11 or later for write-only arguments (the database admin password never reaches plan or state).
  required_version = ">= 1.11.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.11.0" # 5.12.0 is inside the 7-day release-age window
    }
    # The DocumentDB cluster: azurerm_mongo_cluster has no write-only password, azapi_resource has
    # sensitive_body. Also sets disableLocalAuth on Communication Services, which azurerm does not expose.
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.13.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9.1"
    }
  }

  # Created by bootstrap. Entra ID auth only.
  backend "azurerm" {
    resource_group_name  = "rg-townwise-bootstrap"
    storage_account_name = "sttwtfstate2d2c15bf"
    container_name       = "tfstate"
    key                  = "production.tfstate"
    use_azuread_auth     = true
  }
}

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  # Bootstrap registered the resource providers; this stack needs no subscription-level rights.
  resource_provider_registrations = "none"

  features {
    key_vault {
      # Never purge on destroy: the vault has purge protection.
      purge_soft_delete_on_destroy = false
    }
    storage {
      # Manage storage through Resource Manager only: the backup account's blob endpoint admits only the apps
      # subnet, so data-plane calls from a laptop or runner would fail.
      data_plane_available = false
    }
  }
}

provider "azapi" {
  subscription_id = var.subscription_id
}
