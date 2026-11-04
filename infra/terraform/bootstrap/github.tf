# GitHub Actions reaches Azure only through OIDC federated credentials on user-assigned managed identities:
# no app registration, no client secret. Entra matches the subject exactly. GitHub Free with a private
# repository has no branch protection, so the main-only deploy rests on only the owner having write access
# (infra/README.md). The identities live in the bootstrap group, where only admins can add credentials.

locals {
  github_issuer   = "https://token.actions.githubusercontent.com"
  github_audience = "api://AzureADTokenExchange"
  # With the repository's OIDC subject customized to repo, context and job_workflow_ref (infra/README.md,
  # step 12), the subject also names the workflow file, so only deploy.yml on main matches; another workflow
  # pushed to main gets a token Entra refuses. For a job that is not a reusable-workflow call,
  # job_workflow_ref is the running workflow's own path and ref.
  github_deploy_subject = join(":", compact([
    "${var.github_subject_prefix}:ref:refs/heads/main",
    var.github_bind_deploy_workflow ? "job_workflow_ref:${var.github_repository}/.github/workflows/deploy.yml@refs/heads/main" : "",
  ]))
}

# Deploys from main. Its roles are attached in production/deploy.tf, scoped to the resources it touches.
resource "azurerm_user_assigned_identity" "deploy" {
  name                = "id-townwise-gha-deploy"
  resource_group_name = azurerm_resource_group.bootstrap.name
  location            = azurerm_resource_group.bootstrap.location
}

# Every GitHub trust in the subscription, by credential name; tests/bootstrap.tftest.hcl pins this list.
# There is no plan identity: a pull-request credential and its state access return with a plan job.
resource "azurerm_federated_identity_credential" "github" {
  for_each = {
    github-main = local.github_deploy_subject
  }
  name                      = each.key
  user_assigned_identity_id = azurerm_user_assigned_identity.deploy.id
  issuer                    = local.github_issuer
  audience                  = [local.github_audience]
  subject                   = each.value
}
