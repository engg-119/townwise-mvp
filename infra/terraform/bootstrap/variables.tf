variable "subscription_id" {
  description = "Azure Sponsorship subscription that holds every Townwise resource."
  type        = string
  default     = "2d2c15bf-1b72-4e0c-a4cb-52dfc08ca999"
}

variable "tenant_id" {
  description = "Entra ID tenant (Default Directory)."
  type        = string
  default     = "37acb94f-e2d9-41d9-a697-1bd7a1d60bf1"
}

variable "location" {
  description = "Region for every Townwise resource group."
  type        = string
  default     = "eastus"
}

variable "budget_email" {
  description = "Address that receives the monthly budget alerts."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "budget_email must be an email address."
  }
}

variable "budget_start_date" {
  description = "First day of the month the budget starts (RFC 3339, must be the 1st)."
  type        = string
  default     = "2026-11-01T00:00:00Z"

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-01T00:00:00Z$", var.budget_start_date))
    error_message = "budget_start_date must be the first of a month, for example 2026-11-01T00:00:00Z."
  }
}

variable "github_subject_prefix" {
  description = "GitHub's immutable OIDC subject prefix for the repository: repo:OWNER@OWNER-ID/REPO@REPO-ID."
  type        = string
  default     = "repo:engg-119@343069214/townwise-mvp@1427161209"

  validation {
    condition     = can(regex("^repo:[A-Za-z0-9-]+@[0-9]+/[A-Za-z0-9._-]+@[0-9]+$", var.github_subject_prefix))
    error_message = "github_subject_prefix must be repo:OWNER@OWNER-ID/REPO@REPO-ID."
  }
}

variable "github_repository" {
  description = "owner/repository, as it appears in job_workflow_ref."
  type        = string
  default     = "engg-119/townwise-mvp"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be owner/repository."
  }
}

variable "github_bind_deploy_workflow" {
  description = "Require job_workflow_ref (deploy.yml on main) in the deploy credential's subject. Needs the repository's OIDC subject customized first (infra/README.md, step 12); false falls back to any workflow on main."
  type        = bool
  default     = true
}
