# Outbound email from no-reply@townwise.tech through Azure Communication Services. Verification of the
# custom domain is started by hand once its DNS records resolve (infra/README.md); the domain can be linked
# to the Communication Services resource only after that, so the link waits for acs_domain_verified.

resource "azurerm_email_communication_service" "main" {
  name                = "acse-townwise-${local.suffix}"
  resource_group_name = local.rg
  data_location       = "United States"
}

resource "azurerm_email_communication_service_domain" "main" {
  name                             = local.domain
  email_service_id                 = azurerm_email_communication_service.main.id
  domain_management                = "CustomerManaged"
  user_engagement_tracking_enabled = false
}

resource "azurerm_email_communication_service_domain_sender_username" "no_reply" {
  name                    = "no-reply"
  email_service_domain_id = azurerm_email_communication_service_domain.main.id
  display_name            = "Townwise"
}

resource "azurerm_communication_service" "main" {
  name                = "acs-townwise-${local.suffix}"
  resource_group_name = local.rg
  data_location       = "United States"
}

resource "azurerm_communication_service_email_domain_association" "main" {
  count                    = var.acs_domain_verified ? 1 : 0
  communication_service_id = azurerm_communication_service.main.id
  email_service_domain_id  = azurerm_email_communication_service_domain.main.id
}

# Access keys off: the app sends with its managed identity (Entra ID, the role below), so keys are never needed.
# azurerm still reads the keys into state (primary_key and the connection strings); with local auth disabled
# they authenticate nothing. azurerm has no argument for this property. The update reads the resource and
# writes it back, so it runs after the domain link to keep linkedDomains.
resource "azapi_update_resource" "communication_local_auth" {
  type        = "Microsoft.Communication/communicationServices@2025-05-01"
  resource_id = azurerm_communication_service.main.id

  body = {
    properties = { disableLocalAuth = true }
  }

  depends_on = [azurerm_communication_service_email_domain_association.main]
}

# Communication Services has no email data action. This is the minimal set Microsoft documents for sending
# with Entra ID, assigned only on this one Communication Services resource. It includes
# CommunicationServices/Write, which also lets the identity change that resource's settings; there is no
# narrower option.
resource "azurerm_role_definition" "email_sender" {
  name              = "Townwise email sender"
  scope             = data.azurerm_resource_group.prod.id
  description       = "Send email through the Townwise Communication Services resource with Entra ID."
  assignable_scopes = [data.azurerm_resource_group.prod.id]

  permissions {
    actions = [
      "Microsoft.Communication/CommunicationServices/Read",
      "Microsoft.Communication/CommunicationServices/Write",
      "Microsoft.Communication/EmailServices/write",
    ]
  }
}

resource "azurerm_role_assignment" "api_email" {
  scope              = azurerm_communication_service.main.id
  role_definition_id = azurerm_role_definition.email_sender.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.api.principal_id
  principal_type     = "ServicePrincipal"
}
