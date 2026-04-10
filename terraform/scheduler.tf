###############################################################################
# Cloud Scheduler — Data Sync Jobs
#
# Each enabled data source gets a Cloud Scheduler job that POSTs to the
# backend Cloud Run service's sync trigger endpoint. Authentication uses
# OIDC tokens scoped to the backend service URL.
###############################################################################

resource "google_cloud_scheduler_job" "sync" {
  for_each = { for k, v in var.sync_schedules : k => v if v.enabled }

  depends_on = [google_project_service.cloudscheduler]

  name        = "sync-${each.key}-${var.environment}"
  description = each.value.description
  region      = var.region
  schedule    = each.value.schedule
  time_zone   = each.value.time_zone

  # Pause/resume without destroying the resource
  paused = false

  retry_config {
    retry_count          = 1
    min_backoff_duration = "10s"
    max_backoff_duration = "60s"
    max_doublings        = 2
  }

  http_target {
    uri         = "${var.backend_service_url}${each.value.endpoint}"
    http_method = "POST"

    headers = {
      "Content-Type" = "application/json"
    }

    body = base64encode("{}")

    oidc_token {
      service_account_email = var.backend_service_account
      audience              = var.backend_service_url
    }
  }

  attempt_deadline = each.value.timeout
}

###############################################################################
# Cloud Scheduler — Nightly Cleanup Job
#
# Triggers the cleanup Cloud Run Job. The job definition is managed by
# Cloud Build (updated on every deploy); Scheduler owns the execution timing.
###############################################################################

resource "google_cloud_scheduler_job" "cleanup" {
  depends_on = [google_project_service.cloudscheduler]

  name        = "cleanup-${var.environment}"
  description = "Nightly cleanup: expired tokens, stale sessions (${var.environment})"
  region      = var.region
  schedule    = var.cleanup_schedule
  time_zone   = var.cleanup_time_zone

  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
    max_doublings        = 2
  }

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${var.backend_service_name}-cleanup:run"
    http_method = "POST"

    headers = {
      "Content-Type" = "application/json"
    }

    body = base64encode("{}")

    oauth_token {
      service_account_email = var.backend_service_account
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  attempt_deadline = "360s"
}
