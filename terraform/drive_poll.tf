###############################################################################
# Drive sync — poll job + supporting IAM
#
# This file owns the GCP-side wiring for the Drive incremental-poll feature.
# What lives here:
#
#   1. google_cloud_scheduler_job.drive_poll      — POSTs to /integrations/
#                                                   google-drive/poll on a
#                                                   cron managed by gub-admin.
#   2. google_service_account_iam_member          — runtime SA gets
#                                                   roles/iam.serviceAccountTokenCreator
#                                                   on the dedicated Drive SA
#                                                   so it can call signJwt
#                                                   for the impersonation chain.
#   3. google_project_iam_custom_role             — narrow custom role with
#                                                   just cloudscheduler.jobs.{get,
#                                                   list,update} so gub-admin
#                                                   can adjust the cadence.
#   4. google_project_iam_member                  — grant of the custom role
#                                                   to the gub-admin runtime SA.
#
# What does NOT live here (Workspace-admin actions, no Terraform surface):
#   - Domain-wide delegation grant on var.drive_target_sa (Workspace Admin
#     Console → Security → API Controls → Manage Domain Wide Delegation).
#   - Provisioning the bot user @anomaly.com.
#   - Sharing the bot user on each restricted Drive.
#
# Activation sequence (after this file applies):
#   1. Workspace admin grants DWD to var.drive_target_sa (drive.readonly scope).
#   2. Workspace admin provisions the bot user (any @anomaly.com mailbox).
#   3. IT shares the bot user on each restricted Drive as Viewer.
#   4. Set GOOGLE_DRIVE_TARGET_SA + GOOGLE_DRIVE_IMPERSONATE_EMAIL in
#      cloudbuild/<env>.yaml. Next deploy auto-switches Drive to Path B.
###############################################################################

# ── 1. Cloud Scheduler job: hourly POST to /integrations/google-drive/poll ──

resource "google_cloud_scheduler_job" "drive_poll" {
  depends_on = [google_project_service.cloudscheduler]

  name        = "drive-poll-${var.environment}"
  description = "Incremental Drive poll. Cron is admin-configurable from gub-admin; Terraform sets the initial value only."
  region      = var.region
  schedule    = var.drive_poll_initial_schedule
  time_zone   = var.drive_poll_time_zone

  paused = false

  retry_config {
    retry_count          = 1
    min_backoff_duration = "10s"
    max_backoff_duration = "60s"
    max_doublings        = 2
  }

  http_target {
    uri         = "${var.backend_service_url}/integrations/google-drive/poll"
    http_method = "POST"

    headers = {
      "Content-Type" = "application/json"
    }

    body = base64encode("{}")

    # OIDC token configured now so Item 7b (which adds verification at the
    # gateway) is a one-side change. The receiving service ignores this
    # header today since /poll is currently unauthenticated.
    oidc_token {
      service_account_email = var.backend_service_account
      audience              = var.backend_service_url
    }
  }

  attempt_deadline = "1800s" # 30 min — accommodates the synchronous changes.list call

  # The schedule + paused state are admin-controlled via gub-admin's UI
  # (Cloud Scheduler API). Terraform owns the initial values; subsequent
  # admin edits are expected drift, not config rot. ignore_changes keeps
  # apply quiet when the admin has changed the cadence.
  lifecycle {
    ignore_changes = [schedule, paused]
  }
}

# ── 2. Runtime SA → impersonate the dedicated Drive SA ──────────────────────
#
# This is the IAM grant that makes Path B (STS impersonation) work.
# Without it, drive.client.ts's iamcredentials.signJwt call fails with
# 403. With it, the runtime SA can mint JWTs as the Drive SA.
#
# Scope: only this one target SA. The runtime SA can't impersonate any
# other SA in the project as a result of this binding.

resource "google_service_account_iam_member" "runtime_can_impersonate_drive_sa" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.drive_target_sa}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.backend_service_account}"
}

# ── 3. Custom role: gub-admin's narrow access to the Drive poll job ─────────
#
# Predefined Cloud Scheduler roles are too broad: roles/cloudscheduler.admin
# would let the admin app create, delete, or pause arbitrary scheduler jobs
# anywhere in the project. roles/cloudscheduler.jobRunner is read-only-ish
# but still scoped to all jobs.
#
# We define a custom role with only the three permissions the admin UI
# actually needs: get (read for status display), list (in case multiple jobs
# need listing), update (to change the cron). No create, no delete, no run.

resource "google_project_iam_custom_role" "gub_admin_drive_scheduler_editor" {
  role_id     = "gubAdminDriveSchedulerEditor"
  title       = "gub-admin Drive Scheduler Editor"
  description = "Lets gub-admin read and update Cloud Scheduler jobs (used for the Drive poll cadence editor)."
  stage       = "GA"

  # cloudscheduler.jobs.* permissions cover the get/list/update API surface
  # the admin UI needs. Notably absent: create, delete, run, pause, resume.
  # Pause/resume can be added later if the admin UI grows that capability.
  permissions = [
    "cloudscheduler.jobs.get",
    "cloudscheduler.jobs.list",
    "cloudscheduler.jobs.update",
  ]
}

# ── 4. Grant the custom role to gub-admin's runtime SA ──────────────────────
#
# Project-scoped because Cloud Scheduler doesn't expose per-job IAM in the
# Google Terraform provider as of v6.50. The custom role above is narrow
# enough that project scope grants the admin SA exactly what it needs and
# nothing more — they can read/list/update any Cloud Scheduler job in the
# project, but nothing else.
#
# In practice, Cloud Scheduler in this project today is just two jobs:
# the Directory sync and this Drive poll. If that surface grows and we
# want stricter scoping, we'd switch to project-level IAM Conditions or
# wait for Terraform per-job IAM support to land.

resource "google_project_iam_member" "gub_admin_drive_scheduler_grant" {
  project = var.project_id
  role    = google_project_iam_custom_role.gub_admin_drive_scheduler_editor.id
  member  = "serviceAccount:${var.gub_admin_runtime_sa}"
}
