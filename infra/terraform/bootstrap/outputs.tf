output "state_account" {
  description = "Terraform state storage account (backend storage_account_name in both stacks)."
  value       = azurerm_storage_account.state.name
}

output "prod_resource_group" {
  description = "Resource group for every production resource. GitHub variable AZURE_RESOURCE_GROUP."
  value       = azurerm_resource_group.prod.name
}

output "deploy_client_id" {
  description = "Client ID of the deploy identity. GitHub variable AZURE_DEPLOY_CLIENT_ID."
  value       = azurerm_user_assigned_identity.deploy.client_id
}

output "tenant_id" {
  description = "GitHub variable AZURE_TENANT_ID."
  value       = var.tenant_id
}

output "subscription_id" {
  description = "GitHub variable AZURE_SUBSCRIPTION_ID."
  value       = var.subscription_id
}

output "team_groups" {
  description = "Entra groups to add teammates to (Entra admin center, Groups)."
  value       = { for key, group in azuread_group.team : key => group.display_name }
}
