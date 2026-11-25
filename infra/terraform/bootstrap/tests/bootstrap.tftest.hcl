mock_provider "azurerm" {
  override_during = plan
}

mock_provider "azuread" {
  override_during = plan

  mock_data "azuread_client_config" {
    defaults = {
      object_id = "00000000-0000-0000-0000-0000000000cc"
    }
  }
  mock_resource "azuread_group" {
    defaults = {
      object_id = "00000000-0000-0000-0000-0000000000dd"
    }
  }
  mock_resource "azuread_application" {
    defaults = {
      id        = "/applications/00000000-0000-0000-0000-0000000000e1"
      object_id = "00000000-0000-0000-0000-0000000000e1"
      client_id = "00000000-0000-0000-0000-0000000000e2"
    }
  }
  mock_resource "azuread_service_principal" {
    defaults = {
      object_id = "00000000-0000-0000-0000-0000000000e3"
    }
  }
}

override_resource {
  target          = azurerm_user_assigned_identity.deploy
  override_during = plan
  values = {
    id           = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-bootstrap/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-townwise-gha-deploy"
    principal_id = "00000000-0000-0000-0000-0000000000aa"
    client_id    = "00000000-0000-0000-0000-0000000000bb"
  }
}

override_resource {
  target          = azurerm_resource_group.bootstrap
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-bootstrap"
  }
}

override_resource {
  target          = azurerm_resource_group.prod
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod"
  }
}

override_resource {
  target          = azurerm_storage_account.state
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-bootstrap/providers/Microsoft.Storage/storageAccounts/sttwtfstate2d2c15bf"
  }
}

override_resource {
  target          = azurerm_storage_container.state["tfstate"]
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-bootstrap/providers/Microsoft.Storage/storageAccounts/sttwtfstate2d2c15bf/blobServices/default/containers/tfstate"
  }
}

override_resource {
  target          = azurerm_storage_container.state["tfstate-admin"]
  override_during = plan
  values = {
    id = "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-bootstrap/providers/Microsoft.Storage/storageAccounts/sttwtfstate2d2c15bf/blobServices/default/containers/tfstate-admin"
  }
}

variables {
  budget_email = "budget@example.invalid"
}

run "rejects_bad_inputs" {
  command = plan

  variables {
    budget_email          = "not-an-email"
    github_subject_prefix = "repo:engg-119/townwise-mvp"
    budget_start_date     = "2026-11-15T00:00:00Z"
  }

  expect_failures = [
    var.budget_email,
    var.github_subject_prefix,
    var.budget_start_date,
  ]
}

run "github_oidc_exact_subjects" {
  command = plan

  assert {
    condition = (
      keys(azurerm_federated_identity_credential.github) == ["github-main"] &&
      azurerm_federated_identity_credential.github["github-main"].subject == "repo:engg-119@343069214/townwise-mvp@1427161209:ref:refs/heads/main:job_workflow_ref:engg-119/townwise-mvp/.github/workflows/deploy.yml@refs/heads/main" &&
      azurerm_federated_identity_credential.github["github-main"].issuer == "https://token.actions.githubusercontent.com" &&
      azurerm_federated_identity_credential.github["github-main"].audience == tolist(["api://AzureADTokenExchange"])
    )
    error_message = "Exactly one GitHub trust: deploy.yml on refs/heads/main of this repository (job_workflow_ref), GitHub's issuer and the Entra token-exchange audience."
  }

  assert {
    condition = alltrue([
      for credential in values(azurerm_federated_identity_credential.github) :
      credential.user_assigned_identity_id == azurerm_user_assigned_identity.deploy.id && strcontains(credential.subject, ":ref:refs/heads/main")
    ])
    error_message = "No plan identity and no pull_request subject: until a plan job exists, only main can obtain an Azure token."
  }
}

run "github_oidc_unbound_fallback" {
  command = plan

  variables {
    github_bind_deploy_workflow = false
  }

  assert {
    condition     = azurerm_federated_identity_credential.github["github-main"].subject == "repo:engg-119@343069214/townwise-mvp@1427161209:ref:refs/heads/main"
    error_message = "Without the subject customization, the credential falls back to any workflow on main."
  }
}

run "rbac_scopes" {
  command = plan

  assert {
    condition = alltrue([
      for assignment in concat(
        values(azurerm_role_assignment.team), [azurerm_role_assignment.state_applier],
      ) : !(contains(["Owner", "Contributor"], assignment.role_definition_name) && can(regex("^/subscriptions/[^/]+/?$", assignment.scope)))
    ])
    error_message = "No Owner or Contributor at subscription scope."
  }

  assert {
    condition = alltrue([
      for assignment in concat(
        values(azurerm_role_assignment.team), [azurerm_role_assignment.state_applier],
      ) : can(regex("^/subscriptions/[^/]+/resourceGroups/rg-townwise-(bootstrap|prod)(/|$)", assignment.scope))
    ])
    error_message = "Every role assignment is scoped inside a Townwise resource group."
  }

  assert {
    condition = (
      toset([for key, role in local.team_roles : role.scope if role.group == "developers" && role.role == "Key Vault Secrets User"]) == toset([
        for name in ["anthropic-dev-key", "google-places-api-key", "google-maps-static-key", "google-maps-signing-secret", "townwise-calendar-key", "google-web-client-id", "townwise-google-calendar-secret"] :
        "/subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.KeyVault/vaults/kv-townwise-2d2c15bf/secrets/${name}"
      ]) &&
      !contains([for key, role in local.team_roles : role.role if role.group == "developers"], "Key Vault Secrets Officer") &&
      !contains([for key, role in local.team_roles : role.role if role.group == "developers"], "Contributor")
    )
    error_message = "Developers read seven secrets (the shared dev Anthropic key, the Places search's three, the calendar key, the Google web client id and the calendar client secret), and cannot change resources."
  }

  assert {
    condition = (
      [for key, role in local.team_roles : "${role.group} ${role.role} ${role.scope}" if can(regex("Microsoft.Search", role.scope))] == [
        "developers Search Index Data Contributor /subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Search/searchServices/srch-townwise-2d2c15bf",
      ]
    )
    error_message = "Developers read and write the event search service's documents, on that service alone, and hold no control-plane role on it."
  }

  assert {
    condition = (
      [for key, role in local.team_roles : "${role.group} ${role.scope}" if role.role == "Storage Blob Data Reader"] == [
        "admins /subscriptions/2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999/resourceGroups/rg-townwise-prod/providers/Microsoft.Storage/storageAccounts/sttwbackup2d2c15bf/blobServices/default/containers/mongodump",
      ]
    )
    error_message = "Only admins read the database dumps, on the dump container alone."
  }
}

run "state_and_budget" {
  command = plan

  assert {
    condition = (
      !azurerm_storage_account.state.shared_access_key_enabled &&
      azurerm_storage_account.state.min_tls_version == "TLS1_2" &&
      !azurerm_storage_account.state.allow_nested_items_to_be_public &&
      azurerm_storage_account.state.blob_properties[0].versioning_enabled &&
      azurerm_storage_account.state.blob_properties[0].delete_retention_policy[0].days >= 7
    )
    error_message = "State storage: Entra-only, TLS 1.2, private, versioned with soft delete."
  }

  assert {
    condition = (
      azurerm_consumption_budget_subscription.townwise.amount == 60 &&
      toset([for n in azurerm_consumption_budget_subscription.townwise.notification : "${n.threshold_type} ${n.threshold}"]) == toset(["Actual 80", "Forecasted 100"]) &&
      toset(one(one(azurerm_consumption_budget_subscription.townwise.filter).dimension).values) == toset(["rg-townwise-bootstrap", "rg-townwise-prod", "rg-townwise-prod-infra"])
    )
    error_message = "A $60 monthly budget over every Townwise group, the Container Apps managed group included, alerting at 80% actual and 100% forecast."
  }
}

run "lab_callback_app" {
  command = plan

  assert {
    condition = (
      azuread_application.lab_callback.display_name == "townwise-lab-callback" &&
      azuread_application.lab_callback.sign_in_audience == "AzureADMyOrg" &&
      one(azuread_application.lab_callback.api).requested_access_token_version == 2 &&
      azuread_application.lab_callback.owners == toset(["00000000-0000-0000-0000-0000000000cc"])
    )
    error_message = "The lab callback app is single tenant, issues v2 access tokens (aud is its client id), and is owned by the applier."
  }

  assert {
    condition = (
      azuread_application_identifier_uri.lab_callback.application_id == azuread_application.lab_callback.id &&
      azuread_application_identifier_uri.lab_callback.identifier_uri == "api://00000000-0000-0000-0000-0000000000e2" &&
      azuread_service_principal.lab_callback.client_id == "00000000-0000-0000-0000-0000000000e2" &&
      !azuread_service_principal.lab_callback.app_role_assignment_required
    )
    error_message = "The app's identifier URI is api://<client id>, the one resource the lab job asks a token for, and its service principal exists so Entra issues tokens for it."
  }

  assert {
    condition = (
      length(azuread_application.lab_callback.password) == 0 &&
      length(azuread_application.lab_callback.app_role) == 0 &&
      length(azuread_application.lab_callback.required_resource_access) == 0 &&
      length(azuread_application.lab_callback.web) == 0 &&
      length(azuread_application.lab_callback.public_client) == 0 &&
      length(azuread_application.lab_callback.single_page_application) == 0
    )
    error_message = "The lab callback app is only an audience: no secret, no app role, no permission, no redirect URI."
  }

  assert {
    condition     = output.lab_callback_client_id == "00000000-0000-0000-0000-0000000000e2"
    error_message = "lab_callback_client_id outputs the app's client id, for production's lab_callback_client_id."
  }
}
