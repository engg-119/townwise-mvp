# One virtual network so the database can be private. The Container Apps environment gets a delegated subnet
# (its apps and jobs are the only clients); private endpoints get their own small subnet. Address space is
# free, and an environment's subnet cannot be resized later, so the environment subnet is a /24 (about
# 1,200 consumption replicas); a /27 is the minimum.
resource "azurerm_virtual_network" "main" {
  name                = "vnet-townwise"
  resource_group_name = local.rg
  location            = local.location
  address_space       = ["10.40.0.0/22"]
}

# External environment: inbound traffic arrives through the platform's public IP, not this subnet, so an NSG
# here cannot filter it (learn.microsoft.com/azure/container-apps/firewall-integration). Outbound is managed by
# the platform (delegated subnets are not private subnets).
resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = local.rg
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.40.0.0/24"]
  #checkov:skip=CKV2_AZURE_31:inbound to an external workload-profiles environment bypasses the subnet, so an NSG cannot filter it; the database side is filtered by nsg-townwise-endpoints

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }

  # The backup storage account admits only this subnet (backup.tf).
  service_endpoint {
    service = "Microsoft.Storage"
  }
}

resource "azurerm_subnet" "endpoints" {
  name                              = "snet-endpoints"
  resource_group_name               = local.rg
  virtual_network_name              = azurerm_virtual_network.main.name
  address_prefixes                  = ["10.40.1.0/27"]
  default_outbound_access_enabled   = false
  private_endpoint_network_policies = "NetworkSecurityGroupEnabled"
}

# The database's private endpoint accepts only the DocumentDB port, only from the apps subnet.
resource "azurerm_network_security_group" "endpoints" {
  name                = "nsg-townwise-endpoints"
  resource_group_name = local.rg
  location            = local.location

  security_rule {
    name                       = "allow-apps-to-documentdb"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_address_prefix      = one(azurerm_subnet.apps.address_prefixes)
    source_port_range          = "*"
    destination_address_prefix = one(azurerm_subnet.endpoints.address_prefixes)
    destination_port_range     = "10260"
  }

  security_rule {
    name                       = "deny-other-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_address_prefix      = "*"
    source_port_range          = "*"
    destination_address_prefix = "*"
    destination_port_range     = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "endpoints" {
  subnet_id                 = azurerm_subnet.endpoints.id
  network_security_group_id = azurerm_network_security_group.endpoints.id
}
