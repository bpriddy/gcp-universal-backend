###############################################################################
# Dev environment
###############################################################################

project_id  = "os-test-491819"
region      = "us-central1"
environment = "dev"

backend_service_name    = "gcp-universal-backend-dev"
backend_service_url     = "https://gcp-universal-backend-dev-843516467880.us-central1.run.app"
backend_service_account = "sa-gcp-universal-backend-dev@os-test-491819.iam.gserviceaccount.com"

# ── Sync schedules ───────────────────────────────────────────────────────────
# Add entries here as new sync engines come online.
# Disabled sources are excluded from Cloud Scheduler entirely (no paused job).

sync_schedules = {
  google_directory = {
    description = "Google Workspace directory → staff sync"
    schedule    = "0 6 * * *"           # Daily at 6:00 AM ET
    time_zone   = "America/New_York"
    endpoint    = "/integrations/google-directory/cron"
    enabled     = true
    timeout     = "300s"
  }

  google_groups = {
    description = "Google Workspace groups → teams + members sync"
    schedule    = "30 6 * * *"          # Daily at 6:30 AM ET — 30 min after directory
    time_zone   = "America/New_York"
    endpoint    = "/integrations/google-groups/cron"
    enabled     = true
    timeout     = "600s"                # Longer: per-group members.list calls add up
  }

  # Uncomment as engines are built:
  #
  # workfront = {
  #   description = "Adobe Workfront project data sync"
  #   schedule    = "0 7 * * *"
  #   time_zone   = "America/New_York"
  #   endpoint    = "/integrations/workfront/cron"
  #   enabled     = false
  #   timeout     = "600s"
  # }
}

# ── Cleanup ──────────────────────────────────────────────────────────────────

cleanup_schedule  = "0 2 * * *"     # 2:00 AM UTC daily
cleanup_time_zone = "UTC"

# ── gub-admin authorization (IAP IAM) ────────────────────────────────────────
# Authoritative list. To grant admin access add the email here and apply.
# To revoke, remove and apply. Drift detection is intentional — anyone
# added via the console without updating this list will be revoked on the
# next apply.

admin_emails = [
  "bpriddy@anomaly.com",
  "kcurnuck@anomaly.com",
]
