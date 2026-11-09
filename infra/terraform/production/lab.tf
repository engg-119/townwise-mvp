# The forecast lab (infra/README.md, step 20): one Container Apps job that retrains a location's forecast model
# from the sales the API hands it (modeling/lab), and the identities and roles around it. Off unless enable_lab.
#
# Same rule as jobs.tf: permission to start a job is permission to use its identity. The lab job therefore has
# its own identity that holds AcrPull and nothing else, no secrets, and identitySettings lifecycle "None", so no
# container can obtain a token for it. It holds no database or storage credential: the API starts it with a
# per-calibration token and the job reads its input and posts its result over HTTPS (api/src/lab).
#
# The API's identity may read the job and start it, at the job's scope only. The image is the one the deploy
# workflow last set (`az containerapp job update`); Terraform keeps it as lab_image until then.

locals {
  lab_job_name = "caj-townwise-lab"
  # Built from names, not read from the job: the API's environment names the job, and the job's environment
  # names the API's host, so a reference each way would be a cycle.
  lab_job_id = "${data.azurerm_resource_group.prod.id}/providers/Microsoft.App/jobs/${local.lab_job_name}"
}

resource "azurerm_user_assigned_identity" "lab" {
  count               = var.enable_lab ? 1 : 0
  name                = "id-townwise-job-lab"
  resource_group_name = local.rg
  location            = local.location
}

resource "azurerm_role_assignment" "lab_acr_pull" {
  count                = var.enable_lab ? 1 : 0
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.lab[0].principal_id
  principal_type       = "ServicePrincipal"
}

# Exactly what api/src/lab/runner.ts calls: read the job's template, then start an execution of it.
resource "azurerm_role_definition" "lab_starter" {
  count             = var.enable_lab ? 1 : 0
  name              = "Townwise lab starter"
  scope             = data.azurerm_resource_group.prod.id
  description       = "Read the Townwise lab job and start an execution of it; nothing else."
  assignable_scopes = [data.azurerm_resource_group.prod.id]

  permissions {
    actions = ["Microsoft.App/jobs/read", "Microsoft.App/jobs/start/action"]
  }
}

resource "azurerm_role_assignment" "lab_start" {
  count              = var.enable_lab ? 1 : 0
  scope              = azapi_resource.job_lab[0].id
  role_definition_id = azurerm_role_definition.lab_starter[0].role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.api.principal_id
  principal_type     = "ServicePrincipal"
}

# What deploy.tf grants the deploy identity on the API app, on the lab job: read it and update its image.
resource "azurerm_role_assignment" "deployer_lab_job" {
  count              = var.enable_lab ? 1 : 0
  scope              = azapi_resource.job_lab[0].id
  role_definition_id = azurerm_role_definition.deployer.role_definition_resource_id
  principal_id       = data.azurerm_user_assigned_identity.deploy.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azapi_resource" "job_lab" {
  count     = var.enable_lab ? 1 : 0
  type      = "Microsoft.App/jobs@2025-07-01"
  name      = local.lab_job_name
  parent_id = data.azurerm_resource_group.prod.id
  location  = local.location

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.lab[0].id]
  }

  body = {
    properties = {
      environmentId       = azurerm_container_app_environment.main.id
      workloadProfileName = "Consumption"
      configuration = {
        triggerType         = "Manual"
        manualTriggerConfig = { parallelism = 1, replicaCompletionCount = 1 }
        replicaTimeout      = 900
        replicaRetryLimit   = 0
        registries          = [{ server = azurerm_container_registry.main.login_server, identity = azurerm_user_assigned_identity.lab[0].id }]
        secrets             = []
        identitySettings    = [{ identity = azurerm_user_assigned_identity.lab[0].id, lifecycle = "None" }]
      }
      template = {
        containers = [{
          name      = "lab"
          image     = coalesce(var.lab_image, "unset")
          resources = { cpu = 1, memory = "2Gi" }
          # The default host works from inside the environment; if the job cannot reach it, point this at
          # https://api.townwise.tech (infra/README.md, step 20).
          env = [{ name = "TOWNWISE_LAB_API_URL", value = "https://${azurerm_container_app.api.ingress[0].fqdn}" }]
        }]
      }
    }
  }

  lifecycle {
    # The deploy workflow sets the image (pinned by digest) on every release.
    ignore_changes = [body.properties.template.containers[0].image]

    precondition {
      condition     = var.lab_image != null
      error_message = "Set lab_image to the townwise-lab digest the deploy pushed (infra/README.md, step 20)."
    }
  }

  depends_on = [azurerm_role_assignment.lab_acr_pull]
}
