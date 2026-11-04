# Azure DocumentDB (vCore; formerly Cosmos DB for MongoDB vCore) on the free tier, reachable only through a
# private endpoint in the apps subnet's virtual network. Public network access is off and there are no
# firewall rules. The free tier has no backups (backup.tf runs mongodump nightly), no HA, no Entra ID auth
# (native users only), 32 GiB, and pauses after 60 days without connections (infra/README.md).
#
# No password or connection string reaches plan or state:
# - an ephemeral random_password goes to Key Vault through the write-only value_wo and to the cluster through
#   azapi's write-only sensitive_body, in the same apply (Key Vault first). A new value is generated on every
#   run but sent only when db_admin_password_version changes. If the cluster create fails after the secret is
#   written, the two differ: bump the version and apply again (infra/README.md);
# - no response property is exported (the ARM connectionString is not read into state);
# - the application and backup users, and their connection strings, are created outside Terraform
#   (files/db-users.js and infra/scripts/set-secret.sh).

locals {
  db_admin_user = "twadmin"
  # Compute tier names in the mongoClusters API. M10 is the documented fallback if the free tier refuses the
  # private endpoint or disabled public access at creation (infra/README.md, step 3).
  db_tiers = {
    free = "Free"
    M10  = "M10"
  }
}

ephemeral "random_password" "db_admin" {
  length      = 40
  special     = false # it goes into a URI; 40 letters and digits are about 238 bits
  min_upper   = 1
  min_lower   = 1
  min_numeric = 1
}

resource "azurerm_key_vault_secret" "db_admin_password" {
  name             = "db-admin-password"
  key_vault_id     = azurerm_key_vault.main.id
  content_type     = "DocumentDB built-in administrator ${local.db_admin_user}"
  value_wo         = ephemeral.random_password.db_admin.result
  value_wo_version = var.db_admin_password_version
  #checkov:skip=CKV_AZURE_41:rotation is a version bump (db_admin_password_version), not a calendar expiry; an expired admin password would only lock out the db-users job

  lifecycle {
    # The only copy of the admin password.
    prevent_destroy = true
  }
}

resource "azapi_resource" "docdb" {
  type      = "Microsoft.DocumentDB/mongoClusters@2025-09-01"
  name      = "docdb-townwise-${local.suffix}"
  parent_id = data.azurerm_resource_group.prod.id
  location  = local.location

  body = {
    properties = {
      administrator       = { userName = local.db_admin_user }
      authConfig          = { allowedModes = ["NativeAuth"] }
      compute             = { tier = local.db_tiers[var.db_tier] }
      storage             = { sizeGb = 32 }
      sharding            = { shardCount = 1 }
      highAvailability    = { targetMode = "Disabled" }
      publicNetworkAccess = "Disabled"
    }
  }

  sensitive_body = {
    properties = { administrator = { password = ephemeral.random_password.db_admin.result } }
  }
  # Sent on create, and again only when the version changes (rotation: bump db_admin_password_version).
  sensitive_body_version = {
    "properties.administrator.password" = tostring(var.db_admin_password_version)
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [azurerm_key_vault_secret.db_admin_password]
}

resource "azurerm_private_dns_zone" "docdb" {
  name                = "privatelink.mongocluster.cosmos.azure.com"
  resource_group_name = local.rg
}

resource "azurerm_private_dns_zone_virtual_network_link" "docdb" {
  name                 = "vnet-townwise"
  private_dns_zone_id  = azurerm_private_dns_zone.docdb.id
  virtual_network_id   = azurerm_virtual_network.main.id
  registration_enabled = false
}

resource "azurerm_private_endpoint" "docdb" {
  name                          = "pe-townwise-docdb"
  resource_group_name           = local.rg
  location                      = local.location
  subnet_id                     = azurerm_subnet.endpoints.id
  custom_network_interface_name = "nic-pe-townwise-docdb"

  private_service_connection {
    name                           = "docdb"
    private_connection_resource_id = azapi_resource.docdb.id
    subresource_names              = ["MongoCluster"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "mongocluster"
    private_dns_zone_ids = [azurerm_private_dns_zone.docdb.id]
  }

  depends_on = [azurerm_subnet_network_security_group_association.endpoints]
}
