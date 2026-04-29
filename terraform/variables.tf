###############################################################################
# Input variables
###############################################################################

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

# ── Backend Cloud Run service ────────────────────────────────────────────────

variable "backend_service_name" {
  description = "Name of the backend Cloud Run service"
  type        = string
}

variable "backend_service_url" {
  description = "Full URL of the backend Cloud Run service"
  type        = string
}

variable "backend_service_account" {
  description = "Email of the backend runtime service account"
  type        = string
}

# ── Scheduler configuration ──────────────────────────────────────────────────

variable "sync_schedules" {
  description = "Map of data source key to schedule configuration"
  type = map(object({
    description = string
    schedule    = string       # Cron expression
    time_zone   = string       # e.g. "America/New_York"
    endpoint    = string       # Path on the backend service (e.g. /integrations/google-directory/cron)
    enabled     = bool
    timeout     = optional(string, "300s")
  }))
  default = {}
}

variable "cleanup_schedule" {
  description = "Cron schedule for the nightly cleanup Cloud Run Job"
  type        = string
  default     = "0 2 * * *"
}

variable "cleanup_time_zone" {
  description = "Time zone for the cleanup schedule"
  type        = string
  default     = "UTC"
}

# ── Drive sync poller ────────────────────────────────────────────────────────

variable "drive_target_sa" {
  description = <<-EOT
    Email of the dedicated Drive SA that the runtime SA impersonates via
    iam.serviceAccountTokenCreator. The Workspace admin grants DWD with
    drive.readonly to this SA only — never to the runtime SA. Setting
    GOOGLE_DRIVE_TARGET_SA on Cloud Run to this same value activates
    Path B in drive.client.ts.
  EOT
  type        = string
  default     = "gdrive-scanner@os-test-491819.iam.gserviceaccount.com"
}

variable "drive_poll_initial_schedule" {
  description = <<-EOT
    Initial cron expression for the Drive poll job. After the first apply,
    the admin UI in gub-admin owns this value via the Cloud Scheduler API;
    Terraform's lifecycle.ignore_changes lets that drift without flagging
    the resource as out of sync.

    Default is 07:00 America/New_York (one hour after the Directory sync
    at 06:00 ET, so the two daily syncs don't pile up on the same minute).
    Daily is calibrated to this org's actual scale: typical Drive activity
    is sparse, the rare large-scan trigger is a new account/project add
    that doesn't need same-hour latency. Admin can tighten via the UI any
    time without a redeploy.
  EOT
  type        = string
  default     = "0 7 * * *"
}

variable "drive_poll_time_zone" {
  description = "Time zone for the Drive poll cron. Defaults to America/New_York to match the Directory sync."
  type        = string
  default     = "America/New_York"
}

variable "gub_admin_runtime_sa" {
  description = <<-EOT
    Email of the gub-admin Cloud Run runtime service account. Granted
    cloudscheduler.jobs.update on the Drive poll job (via custom role)
    so the admin UI can adjust the cadence at runtime via the Cloud
    Scheduler API. Convention: sa-gub-admin-<env>@<project>.iam.gserviceaccount.com.
  EOT
  type        = string
  default     = "sa-gub-admin-dev@os-test-491819.iam.gserviceaccount.com"
}

# ── gub-admin authorization (IAP IAM) ────────────────────────────────────────

variable "admin_emails" {
  description = <<-EOT
    Email addresses authorized to access the gub-admin app via Cloud IAP.
    Each entry must be an individual Google account email — groups and
    domain-wide bindings are intentionally not supported here so the audit
    trail in IAP logs always names a specific human.

    This list is authoritative: removing an email here revokes their access
    on the next `terraform apply`.
  EOT
  type        = list(string)
  validation {
    condition     = length(var.admin_emails) > 0
    error_message = "admin_emails must contain at least one email — an empty list would lock everyone out of gub-admin."
  }
  validation {
    condition     = alltrue([for e in var.admin_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "Every entry in admin_emails must look like a valid email address."
  }
}
