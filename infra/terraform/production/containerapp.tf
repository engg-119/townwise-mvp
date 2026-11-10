# The API on Container Apps (Consumption profile of a workload-profiles environment in vnet-townwise, so it
# reaches the private database), with Valkey as a sidecar for the rate limiter's counters. Sessions live in
# the database, so Valkey keeps no data (no snapshots, no append-only file).
#
# The kit's redis module requires rediss: when NODE_ENV is production, with normal certificate checks.
# Valkey therefore listens only with TLS, on 127.0.0.1, which only the containers of the same replica share.
# An init container generates a per-replica CA and server certificate into an ephemeral EmptyDir; the API
# trusts that CA through NODE_EXTRA_CA_CERTS. No key material is stored anywhere or leaves the replica,
# and nothing needs rotating. There is no Valkey password: nothing outside the replica can reach the port,
# and TLS on it also stops plain-HTTP request forgery against localhost.

resource "azurerm_user_assigned_identity" "api" {
  name                = "id-townwise-api"
  resource_group_name = local.rg
  location            = local.location
}

# External ingress, Consumption profile only: no Dedicated plan management fee. Joining a virtual network adds
# platform-managed resources in rg-townwise-prod-infra (one Standard load balancer, a static public IP for
# ingress and one for egress, about $25.55 a month; infra/README.md). The network type cannot change after
# creation. bootstrap/budget.tf covers the managed group by name.
resource "azurerm_container_app_environment" "main" {
  name                               = "cae-townwise"
  resource_group_name                = local.rg
  location                           = local.location
  logs_destination                   = "azure-monitor"
  infrastructure_subnet_id           = azurerm_subnet.apps.id
  infrastructure_resource_group_name = "rg-townwise-prod-infra"
  internal_load_balancer_enabled     = false

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

locals {
  valkey_image = "${azurerm_container_registry.main.login_server}/valkey/valkey@${var.valkey_image_digest}"
}

resource "azurerm_container_app" "api" {
  name                         = "ca-townwise-api"
  resource_group_name          = local.rg
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.api.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.api.id
  }

  # Key Vault references: the platform resolves them with the app's identity; no value is in Terraform.
  dynamic "secret" {
    for_each = local.api_secrets
    content {
      name                = secret.key
      key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/${secret.key}"
      identity            = azurerm_user_assigned_identity.api.id
    }
  }

  ingress {
    external_enabled           = true
    target_port                = 8080
    transport                  = "http"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = 2

    init_container {
      name    = "valkey-tls"
      image   = local.valkey_image
      cpu     = 0.25
      memory  = "0.5Gi"
      command = ["/bin/sh", "-c"]
      args    = [file("${path.module}/files/valkey-tls-init.sh")]

      volume_mounts {
        name = "valkey-tls"
        path = "/tls"
      }
    }

    container {
      name   = "api"
      image  = var.api_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "NODE_EXTRA_CA_CERTS"
        value = "/tls/ca.crt"
      }

      env {
        name  = "REDIS_URL"
        value = "rediss://127.0.0.1:6379/0"
      }

      # The user-assigned identity the API asks for tokens as (api/src/azure-identity.ts), for its emails.
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.api.client_id
      }

      # Calibrations run in the lab job (lab.tf) only when enable_lab is true; otherwise the runner stays off.
      dynamic "env" {
        for_each = var.enable_lab ? { TOWNWISE_LAB_RUNNER = "azure", TOWNWISE_LAB_JOB_ID = local.lab_job_id } : {}
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.api_secrets
        content {
          name        = env.value
          secret_name = env.key
        }
      }

      volume_mounts {
        name = "valkey-tls"
        path = "/tls"
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/healthz"
        interval_seconds        = 3
        failure_count_threshold = 20
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/healthz"
        interval_seconds        = 10
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/healthz"
        interval_seconds        = 5
        failure_count_threshold = 3
      }
    }

    container {
      name   = "valkey"
      image  = local.valkey_image
      cpu    = 0.25
      memory = "0.5Gi"
      args = [
        "valkey-server",
        "--bind", "127.0.0.1",
        "--protected-mode", "yes",
        "--port", "0",
        "--tls-port", "6379",
        "--tls-cert-file", "/tls/server.crt",
        "--tls-key-file", "/tls/server.key",
        "--tls-ca-cert-file", "/tls/ca.crt",
        "--tls-auth-clients", "no",
        # A bare --save followed by another option is save "" (no snapshots). An empty-string arg cannot be
        # used: the azurerm provider reads "" in this list as null and refuses the app before creating it.
        "--save",
        "--appendonly", "no",
        "--maxmemory", "64mb",
        # Rate-limit keys all carry a TTL; eviction would silently reset counters (api/kit/redis/MODULE.md).
        "--maxmemory-policy", "noeviction",
      ]

      volume_mounts {
        name = "valkey-tls"
        path = "/tls"
      }
    }

    volume {
      name         = "valkey-tls"
      storage_type = "EmptyDir"
    }
  }

  lifecycle {
    # The deploy workflow sets the API image (pinned by digest) on every release.
    ignore_changes = [template[0].container[0].image]

    precondition {
      condition     = var.api_image != null
      error_message = "Set api_image to the first API image's digest (infra/README.md, step 6)."
    }
  }

  depends_on = [azurerm_role_assignment.api_acr_pull, azurerm_role_assignment.api_secret_read]
}

# api.townwise.tech: an A record to the environment's static IP (dns.tf), never a CNAME to another
# domain, because WebKit caps cookies set by a CNAME-cloaked API host at 7 days (api/kit/auth/MODULE.md).
resource "azurerm_container_app_custom_domain" "api" {
  name             = local.api_domain
  container_app_id = azurerm_container_app.api.id

  lifecycle {
    # Azure binds the managed certificate asynchronously.
    ignore_changes = [certificate_binding_type, container_app_environment_certificate_id]
  }

  depends_on = [azurerm_dns_a_record.api, azurerm_dns_txt_record.api_verification]
}

resource "azurerm_container_app_environment_managed_certificate" "api" {
  name                         = "api-townwise-tech"
  container_app_environment_id = azurerm_container_app_environment.main.id
  subject_name                 = local.api_domain
  domain_control_validation    = "HTTP"

  depends_on = [azurerm_container_app_custom_domain.api]
}
