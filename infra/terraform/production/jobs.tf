# Container Apps jobs in the same environment as the API, so they reach the private database and the backup
# account's subnet-only blob endpoint. Secrets are Key Vault references, as for the API.
#
# Microsoft: "Treat permission to start a job as permission to use the job's secrets and available managed
# identities" (learn.microsoft.com/azure/container-apps/manage-secrets), because a start request can replace
# the job's containers. So every job has its own identity, holding only what that job needs, and
# identitySettings limits which containers can obtain a token for it ("None": only image pull and Key Vault
# references). azurerm has no identitySettings, so the jobs are azapi resources.
#
# | Job                      | Trigger  | Secrets                                       | Blob access          | Token in |
# | caj-townwise-backup      | 07:17 UTC| mongodb-backup-uri                            | create new blobs only| upload   |
# | caj-townwise-db-users    | manual   | db-admin-password and the three user URIs     | none                 | nothing  |
# | caj-townwise-db-restore  | manual   | mongodb-restore-uri                           | read                 | download |
# | caj-townwise-db-smoke    | manual   | mongodb-uri                                   | none                 | nothing  |
# | caj-townwise-lab         | manual   | none (lab.tf, enable_lab)                     | none                 | main     |
# | caj-townwise-forecasts   | hourly   | mongodb-uri, anthropic-api-key (enable_chat)  | none                 | main     |

locals {
  mongo_image = "${azurerm_container_registry.main.login_server}/mongo@${var.mongo_image_digest}"
  kv_secrets  = "${azurerm_key_vault.main.vault_uri}secrets/"

  # Key Vault secrets per job. Only db-users reads the admin password.
  # The weekly forecast worker (below) exists only with the lab, which it starts; with the chat on it also reads the
  # Anthropic key, for TownwiseAI's weekly suggestions.
  job_secrets = merge({
    backup   = ["mongodb-backup-uri"]
    db-users = ["db-admin-password", "mongodb-uri", "mongodb-backup-uri", "mongodb-restore-uri"]
    restore  = ["mongodb-restore-uri"]
    smoke    = ["mongodb-uri"]
  }, var.enable_lab ? { forecasts = concat(["mongodb-uri"], var.enable_chat ? ["anthropic-api-key"] : []) } : {})
  # Which containers may obtain a token for the job's identity.
  job_identity_lifecycle = {
    backup    = "Main" # the upload container; mongodump (init) gets none
    db-users  = "None"
    restore   = "Init" # the download container; mongorestore (main) gets none
    smoke     = "None"
    forecasts = "Main" # the worker signs in to Resource Manager to start the lab job
  }

  job_secret_reads = toset(flatten([for job, secrets in local.job_secrets : [for secret in secrets : "${job}/${secret}"]]))

  # The configuration every job shares: its own identity for the registry, the Key Vault references, and
  # the identity's availability inside the containers.
  job_configuration = {
    for job, secrets in local.job_secrets : job => {
      registries       = [{ server = azurerm_container_registry.main.login_server, identity = azurerm_user_assigned_identity.job[job].id }]
      secrets          = [for secret in secrets : { name = secret, keyVaultUrl = "${local.kv_secrets}${secret}", identity = azurerm_user_assigned_identity.job[job].id }]
      identitySettings = [{ identity = azurerm_user_assigned_identity.job[job].id, lifecycle = local.job_identity_lifecycle[job] }]
    }
  }
}

resource "azurerm_user_assigned_identity" "job" {
  for_each            = local.job_secrets
  name                = "id-townwise-job-${each.key}"
  resource_group_name = local.rg
  location            = local.location
}

resource "azurerm_role_assignment" "job_acr_pull" {
  for_each             = local.job_secrets
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.job[each.key].principal_id
  principal_type       = "ServicePrincipal"
}

# One assignment per job and secret, each scoped to that one secret.
resource "azurerm_role_assignment" "job_secret_read" {
  for_each = local.job_secret_reads
  scope = (
    split("/", each.key)[1] == "db-admin-password"
    ? azurerm_key_vault_secret.db_admin_password.resource_versionless_id
    : "${azurerm_key_vault.main.id}/secrets/${split("/", each.key)[1]}"
  )
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.job[split("/", each.key)[0]].principal_id
  principal_type       = "ServicePrincipal"
}

# Create new blobs only (Put Blob of a new name). No read, no overwrite, no delete: Put Block and Put Block List
# need blobs/write, so files/backup-upload.sh sends each dump as one Put Blob, with If-None-Match: *.
resource "azurerm_role_definition" "backup_writer" {
  name              = "Townwise backup writer"
  scope             = data.azurerm_resource_group.prod.id
  description       = "Create new blobs in the Townwise backup container; no read, overwrite or delete."
  assignable_scopes = [data.azurerm_resource_group.prod.id]

  permissions {
    data_actions = ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action"]
  }
}

resource "azurerm_role_assignment" "backup_blob_create" {
  scope              = azurerm_storage_container.backup.id
  role_definition_id = azurerm_role_definition.backup_writer.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.job["backup"].principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "restore_blob_read" {
  scope                = azurerm_storage_container.backup.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.job["restore"].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azapi_resource" "job_backup" {
  type      = "Microsoft.App/jobs@2025-07-01"
  name      = "caj-townwise-backup"
  parent_id = data.azurerm_resource_group.prod.id
  location  = local.location

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.job["backup"].id]
  }

  body = {
    properties = {
      environmentId       = azurerm_container_app_environment.main.id
      workloadProfileName = "Consumption"
      configuration = merge(local.job_configuration["backup"], {
        triggerType           = "Schedule"
        scheduleTriggerConfig = { cronExpression = "17 7 * * *", parallelism = 1, replicaCompletionCount = 1 }
        replicaTimeout        = 1800
        replicaRetryLimit     = 1
      })
      template = {
        initContainers = [{
          name         = "mongodump"
          image        = local.mongo_image
          command      = ["/bin/sh", "-c"]
          args         = [file("${path.module}/files/backup-dump.sh")]
          resources    = { cpu = 0.25, memory = "0.5Gi" }
          env          = [{ name = "MONGODB_BACKUP_URI", secretRef = "mongodb-backup-uri" }]
          volumeMounts = [{ volumeName = "backup", mountPath = "/backup" }]
        }]
        containers = [{
          name      = "upload"
          image     = var.azure_cli_image
          command   = ["/bin/sh", "-c"]
          args      = [file("${path.module}/files/backup-upload.sh")]
          resources = { cpu = 0.25, memory = "0.5Gi" }
          env = [
            { name = "AZURE_CLIENT_ID", value = azurerm_user_assigned_identity.job["backup"].client_id },
            { name = "BACKUP_ACCOUNT", value = azurerm_storage_account.backup.name },
            { name = "BACKUP_CONTAINER", value = azurerm_storage_container.backup.name },
          ]
          volumeMounts = [{ volumeName = "backup", mountPath = "/backup" }]
        }]
        # Ephemeral storage per replica is 2 GiB at 0.5 vCPU (infra/README.md, backups: dump size limit).
        volumes = [{ name = "backup", storageType = "EmptyDir" }]
      }
    }
  }

  depends_on = [azurerm_role_assignment.job_acr_pull, azurerm_role_assignment.job_secret_read]
}

resource "azapi_resource" "job_db_users" {
  type      = "Microsoft.App/jobs@2025-07-01"
  name      = "caj-townwise-db-users"
  parent_id = data.azurerm_resource_group.prod.id
  location  = local.location

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.job["db-users"].id]
  }

  body = {
    properties = {
      environmentId       = azurerm_container_app_environment.main.id
      workloadProfileName = "Consumption"
      configuration = merge(local.job_configuration["db-users"], {
        triggerType         = "Manual"
        manualTriggerConfig = { parallelism = 1, replicaCompletionCount = 1 }
        replicaTimeout      = 300
        replicaRetryLimit   = 0
      })
      template = {
        containers = [{
          name      = "db-users"
          image     = local.mongo_image
          command   = ["mongosh"]
          args      = ["--nodb", "--quiet", "--eval", file("${path.module}/files/db-users.js")]
          resources = { cpu = 0.25, memory = "0.5Gi" }
          env = [
            { name = "DB_ADMIN_USER", value = local.db_admin_user },
            { name = "DB_ADMIN_PASSWORD", secretRef = "db-admin-password" },
            { name = "MONGODB_URI", secretRef = "mongodb-uri" },
            { name = "MONGODB_BACKUP_URI", secretRef = "mongodb-backup-uri" },
            { name = "MONGODB_RESTORE_URI", secretRef = "mongodb-restore-uri" },
          ]
        }]
      }
    }
  }

  depends_on = [azurerm_role_assignment.job_acr_pull, azurerm_role_assignment.job_secret_read]
}

resource "azapi_resource" "job_restore" {
  type      = "Microsoft.App/jobs@2025-07-01"
  name      = "caj-townwise-db-restore"
  parent_id = data.azurerm_resource_group.prod.id
  location  = local.location

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.job["restore"].id]
  }

  body = {
    properties = {
      environmentId       = azurerm_container_app_environment.main.id
      workloadProfileName = "Consumption"
      configuration = merge(local.job_configuration["restore"], {
        triggerType         = "Manual"
        manualTriggerConfig = { parallelism = 1, replicaCompletionCount = 1 }
        replicaTimeout      = 3600
        replicaRetryLimit   = 0
      })
      # No BACKUP_BLOB: infra/scripts/db-restore.sh names the dump for each execution, and the download fails
      # without one, so nothing is ever restored by default.
      template = {
        initContainers = [{
          name      = "download"
          image     = var.azure_cli_image
          command   = ["/bin/sh", "-c"]
          args      = [file("${path.module}/files/restore-download.sh")]
          resources = { cpu = 0.25, memory = "0.5Gi" }
          env = [
            { name = "AZURE_CLIENT_ID", value = azurerm_user_assigned_identity.job["restore"].client_id },
            { name = "BACKUP_ACCOUNT", value = azurerm_storage_account.backup.name },
            { name = "BACKUP_CONTAINER", value = azurerm_storage_container.backup.name },
          ]
          volumeMounts = [{ volumeName = "restore", mountPath = "/restore" }]
        }]
        containers = [{
          name      = "mongorestore"
          image     = local.mongo_image
          command   = ["/bin/sh", "-c"]
          args      = [file("${path.module}/files/restore.sh")]
          resources = { cpu = 0.25, memory = "0.5Gi" }
          env = [
            { name = "RESTORE_DB", value = "townwise_restore" },
            { name = "MONGODB_RESTORE_URI", secretRef = "mongodb-restore-uri" },
          ]
          volumeMounts = [{ volumeName = "restore", mountPath = "/restore" }]
        }]
        volumes = [{ name = "restore", storageType = "EmptyDir" }]
      }
    }
  }

  depends_on = [azurerm_role_assignment.job_acr_pull, azurerm_role_assignment.job_secret_read]
}

# The real-cluster smoke test (infra/README.md, step 10). infra/scripts/db-smoke.sh runs it with the API image
# that is live at the time; the image here is the first one.
resource "azapi_resource" "job_smoke" {
  type      = "Microsoft.App/jobs@2025-07-01"
  name      = "caj-townwise-db-smoke"
  parent_id = data.azurerm_resource_group.prod.id
  location  = local.location

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.job["smoke"].id]
  }

  body = {
    properties = {
      environmentId       = azurerm_container_app_environment.main.id
      workloadProfileName = "Consumption"
      configuration = merge(local.job_configuration["smoke"], {
        triggerType         = "Manual"
        manualTriggerConfig = { parallelism = 1, replicaCompletionCount = 1 }
        replicaTimeout      = 300
        replicaRetryLimit   = 0
      })
      template = {
        containers = [{
          name      = "db-smoke"
          image     = coalesce(var.api_image, "unset")
          command   = ["node", "--input-type=module", "--eval", file("${path.module}/../../smoke/db-smoke.js")]
          resources = { cpu = 0.5, memory = "1Gi" }
          env       = [{ name = "MONGODB_URI", secretRef = "mongodb-uri" }]
        }]
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.api_image != null
      error_message = "Set api_image to the first API image's digest (infra/README.md, step 6)."
    }
  }

  depends_on = [azurerm_role_assignment.job_acr_pull, azurerm_role_assignment.job_secret_read]
}

# The weekly forecast worker (spec D42, 14.6; infra/README.md, step 20). The owner asked for background workers, so
# the weekly refresh is not a timer in the API: every hour this job runs one pass of api/src/workers/weekly-forecasts.ts
# in the API's own image (the deploy workflow keeps the two on one digest) and exits. A pass starts calibrations in
# the lab job for the locations that are due, under a Mongo lease, so an overlapping execution does nothing.
#
# Its identity holds AcrPull, the mongodb-uri reference (the same database user as the API: the pass reads and
# writes the app's collections), with enable_chat the anthropic-api-key reference (the pass also makes TownwiseAI's
# weekly suggestions, OpenSpec change weekly-forecast-suggestions; without the key they are off), and the lab starter
# role at the lab job, which is what api/src/lab/runner.ts calls with it. It needs no Valkey (the API's sidecar) and
# holds no other secret. Starting this job is permission to use
# that identity (above), and it can start lab executions, which the API identity can already do.
#
# The image's CMD starts node with --env-file=api/production.env, so the override keeps that flag: the worker reads
# the same public config as the API, and the variables below win over it. TOWNWISE_LAB_AUDIENCE, _CALLER_ID and
# _TENANT_ID are the API's values: the worker never checks a callback, but labRunnerOf (api/src/config.ts) requires
# all four with the azure runner, so the worker and the API resolve one configuration.
resource "azurerm_role_assignment" "forecasts_lab_start" {
  count              = var.enable_lab ? 1 : 0
  scope              = azapi_resource.job_lab[0].id
  role_definition_id = azurerm_role_definition.lab_starter[0].role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.job["forecasts"].principal_id
  principal_type     = "ServicePrincipal"
}

# What deploy.tf grants the deploy identity on the API app, on this job: read it and update its image.
resource "azurerm_role_assignment" "deployer_forecasts_job" {
  count              = var.enable_lab ? 1 : 0
  scope              = azapi_resource.job_forecasts[0].id
  role_definition_id = azurerm_role_definition.deployer.role_definition_resource_id
  principal_id       = data.azurerm_user_assigned_identity.deploy.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azapi_resource" "job_forecasts" {
  count     = var.enable_lab ? 1 : 0
  type      = "Microsoft.App/jobs@2025-07-01"
  name      = "caj-townwise-forecasts"
  parent_id = data.azurerm_resource_group.prod.id
  location  = local.location

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.job["forecasts"].id]
  }

  body = {
    properties = {
      environmentId       = azurerm_container_app_environment.main.id
      workloadProfileName = "Consumption"
      configuration = merge(local.job_configuration["forecasts"], {
        triggerType = "Schedule"
        # Hourly, at five past (UTC). A town's week starts at 03:00 on Monday local time, and a blocked or held-back
        # start is tried again each hour until that week ends (api/src/lab/schedule.ts).
        scheduleTriggerConfig = { cronExpression = "5 * * * *", parallelism = 1, replicaCompletionCount = 1 }
        # Inside the pass's 10-minute lease, and above the pass's own 8-minute budget (SCHEDULE_PASS_BUDGET_MS), so a
        # pass ends on its own before it is killed; what it leaves is picked up by the next hour's.
        replicaTimeout    = 600
        replicaRetryLimit = 0
      })
      template = {
        containers = [{
          name      = "weekly-forecasts"
          image     = coalesce(var.api_image, "unset")
          command   = ["node", "--env-file=api/production.env", "api/src/workers/weekly-forecasts.ts"]
          resources = { cpu = 0.25, memory = "0.5Gi" }
          env = concat([
            { name = "MONGODB_URI", secretRef = "mongodb-uri" },
            # The user-assigned identity the worker asks for tokens as (api/src/azure-identity.ts).
            { name = "AZURE_CLIENT_ID", value = azurerm_user_assigned_identity.job["forecasts"].client_id },
            { name = "TOWNWISE_LAB_RUNNER", value = "azure" },
            { name = "TOWNWISE_LAB_JOB_ID", value = local.lab_job_id },
            { name = "TOWNWISE_LAB_AUDIENCE", value = coalesce(var.lab_callback_client_id, "unset") },
            { name = "TOWNWISE_LAB_CALLER_ID", value = azurerm_user_assigned_identity.lab[0].principal_id },
            { name = "TOWNWISE_LAB_TENANT_ID", value = data.azurerm_client_config.current.tenant_id },
          ], var.enable_chat ? [{ name = "ANTHROPIC_API_KEY", secretRef = "anthropic-api-key" }] : [])
        }]
      }
    }
  }

  lifecycle {
    # The deploy workflow sets the image to the API's digest (pinned) on every release.
    ignore_changes = [body.properties.template.containers[0].image]

    precondition {
      condition     = var.api_image != null
      error_message = "Set api_image to the first API image's digest (infra/README.md, step 6)."
    }
  }

  depends_on = [azurerm_role_assignment.job_acr_pull, azurerm_role_assignment.job_secret_read]
}
