locals {
  # The Container Apps environment (production/containerapp.tf) puts its load balancer and public IPs in this
  # platform-managed group, about $25.55 a month, so the budget must cover it as well as the two groups here.
  prod_infra_resource_group = "rg-townwise-prod-infra"
}

# $60 a month across every Townwise resource group. Expected spend is about $50 (infra/README.md), so the
# 80% actual-spend alert fires late in most months; the forecast alert warns before the limit.
resource "azurerm_consumption_budget_subscription" "townwise" {
  name            = "townwise-monthly"
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = 60
  time_grain      = "Monthly"

  time_period {
    start_date = var.budget_start_date
  }

  filter {
    dimension {
      name     = "ResourceGroupName"
      operator = "In"
      values   = [azurerm_resource_group.bootstrap.name, azurerm_resource_group.prod.name, local.prod_infra_resource_group]
    }
  }

  notification {
    enabled        = true
    operator       = "GreaterThan"
    threshold      = 80
    threshold_type = "Actual"
    contact_emails = [var.budget_email]
  }

  notification {
    enabled        = true
    operator       = "GreaterThan"
    threshold      = 100
    threshold_type = "Forecasted"
    contact_emails = [var.budget_email]
  }
}
