variable "subscription_id" {
  description = "Azure Sponsorship subscription that holds every Townwise resource."
  type        = string
  default     = "2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999"
}

variable "api_image" {
  description = "API image for the first full apply, pinned by digest (<registry>/townwise-api@sha256:...). Not needed for the first targeted apply. Afterwards the deploy workflow owns the image, and Terraform ignores it."
  type        = string
  default     = null

  validation {
    condition     = var.api_image == null || can(regex("^[a-z0-9.-]+/townwise-api@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be <registry>/townwise-api@sha256:<64 hex>."
  }
}

variable "valkey_image_digest" {
  description = "Digest of valkey/valkey:8.1.10-alpine (the compose.yaml pin), imported into the registry."
  type        = string
  default     = "sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507"

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.valkey_image_digest))
    error_message = "valkey_image_digest must be sha256:<64 hex>."
  }
}

variable "acs_domain_verified" {
  description = "Set true after townwise.tech is verified in Communication Services (infra/README.md); the domain can be linked only once verified."
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Address that receives operational alerts (the Log Analytics daily cap)."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "db_tier" {
  description = "DocumentDB compute tier: free, or M10 if the free tier refuses the private endpoint or disabled public access at creation (infra/README.md, step 3). Free to M10 upgrades in place; M10 back to free is not supported."
  type        = string
  default     = "free"

  validation {
    condition     = contains(["free", "M10"], var.db_tier)
    error_message = "db_tier must be free or M10."
  }
}

variable "db_admin_password_version" {
  description = "Bump to rotate the DocumentDB admin password: a new random value goes to Key Vault and to the cluster in the same apply."
  type        = number
  default     = 1
}

variable "mongo_image_digest" {
  description = "Digest of mongo:8.0.32 (the kit's test pin, api/kit/mongo/test/images.ts), imported into the registry; the jobs run mongodump, mongorestore and mongosh from it."
  type        = string
  default     = "sha256:d0d926f94df099bff534b7ee5b5986458131a22489dfff8664509af0c1e2ca9c"

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.mongo_image_digest))
    error_message = "mongo_image_digest must be sha256:<64 hex>."
  }
}

variable "azure_cli_image" {
  description = "Azure CLI image for the backup upload and restore download, pinned by digest (mcr.microsoft.com/azure-cli:2.92.0)."
  type        = string
  default     = "mcr.microsoft.com/azure-cli@sha256:a4e2660b4099b76f02001a9316a0eb0dc56e330b5f7d1d1312c932200645bf26"

  validation {
    condition     = can(regex("^mcr\\.microsoft\\.com/azure-cli@sha256:[0-9a-f]{64}$", var.azure_cli_image))
    error_message = "azure_cli_image must be mcr.microsoft.com/azure-cli@sha256:<64 hex>."
  }
}

variable "lock_backup_retention" {
  description = "Lock the backup container's 30-day retention policy. Irreversible: no admin can then remove it, and the account cannot be deleted until its newest dump is 30 days old (infra/README.md, step 14)."
  type        = bool
  default     = false
}

variable "enable_chat" {
  description = "Turn on the tuning chat: the API gets ANTHROPIC_API_KEY from the Key Vault secret anthropic-api-key, which must be seeded first (infra/README.md, Enable the tuning chat). False leaves the chat off."
  type        = bool
  default     = false
}

variable "enable_places" {
  description = "Turn on the Places search: the API gets GOOGLE_PLACES_API_KEY from the Key Vault secret google-places-api-key, which must be seeded first (infra/README.md, Enable the Places search). False leaves it off."
  type        = bool
  default     = false
}
