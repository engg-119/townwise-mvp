# The forecast lab callback's audience (infra/README.md, step 20). The lab job signs in to the API with its managed
# identity: it asks Entra for a token for this app, and the API accepts only tokens for this app from that one identity
# (by its object id, oid; api/src/lab/caller.ts). The app is only an audience: no secret, certificate or federated
# credential, no app role and no permission, so it grants nothing and nobody can sign in as it. Any principal in the
# tenant can get a token for it ("assignment required" stays off), which the API refuses unless the oid is the lab
# identity's. Creating it needs Application Administrator or Global Administrator, so it lives here, applied by the
# subscription owner; production reads its client id as the variable lab_callback_client_id.
resource "azuread_application" "lab_callback" {
  display_name     = "townwise-lab-callback"
  sign_in_audience = "AzureADMyOrg"
  owners           = [data.azuread_client_config.current.object_id]

  # v2 access tokens, even through the v1-style resource= request the identity endpoint makes: aud is the client id
  # and iss is https://login.microsoftonline.com/<tenant>/v2.0, what the API checks.
  api {
    requested_access_token_version = 2
  }

  lifecycle {
    # azuread_application_identifier_uri manages it (the provider's documented pairing).
    ignore_changes = [identifier_uris]
  }
}

# api://<client id>, Microsoft's recommended form; the lab job asks for a token for this resource.
resource "azuread_application_identifier_uri" "lab_callback" {
  application_id = azuread_application.lab_callback.id
  identifier_uri = "api://${azuread_application.lab_callback.client_id}"
}

# Entra issues tokens only for an app with a service principal in the tenant.
resource "azuread_service_principal" "lab_callback" {
  client_id                    = azuread_application.lab_callback.client_id
  owners                       = [data.azuread_client_config.current.object_id]
  app_role_assignment_required = false
}
