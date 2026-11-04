# Secrets for the API and the database jobs. RBAC mode, purge protection on. Terraform writes one value, the
# database admin password, through the write-only value_wo (database.tf), so no value reaches state;
# infra/scripts/set-secret.sh seeds the rest. Those secrets must exist before the full apply, because each
# role assignment below is scoped to one secret (infra/README.md).
# Default action Allow: Container Apps resolves Key Vault references from the platform, not from the virtual
# network, and is not a trusted Microsoft service, so a deny-by-default firewall would break the references.
# Access is RBAC only, and every data-plane call is audited to Log Analytics (monitoring.tf).
# nosemgrep: terraform.azure.security.keyvault.keyvault-specify-network-acl.keyvault-specify-network-acl
resource "azurerm_key_vault" "main" {
  name                          = "kv-townwise-${local.suffix}"
  resource_group_name           = local.rg
  location                      = local.location
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = true
  #checkov:skip=CKV_AZURE_109:Container Apps resolves Key Vault references from the platform, not the virtual network, and set-secret.sh runs from laptops; access is RBAC only and audited
  #checkov:skip=CKV_AZURE_189:see CKV_AZURE_109
  #checkov:skip=CKV2_AZURE_32:see CKV_AZURE_109

  network_acls {
    default_action = "Allow"
    bypass         = "AzureServices"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# The app's identity reads only the secrets it needs, each by its own assignment.
resource "azurerm_role_assignment" "api_secret_read" {
  for_each             = local.api_secrets
  scope                = "${azurerm_key_vault.main.id}/secrets/${each.key}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.api.principal_id
  principal_type       = "ServicePrincipal"
}

# The jobs' identities read theirs the same way (jobs.tf, job_secret_read).
