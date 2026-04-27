###############################################################################
# IAP IAM binding for gub-admin
#
# gub-admin is a Cloud-Run-deployed Next.js admin app fronted by Cloud IAP.
# Authorization is enforced at the IAP layer — only the emails listed in
# `admin_emails` can reach the app. The admin app itself does NOT do
# in-app role checks (the User.isAdmin / User.role columns in the database
# are retained for future use but are no longer editable from this app).
#
# Authoritative `_binding` (not `_member`): if anyone adds a user via the
# GCP console without updating `admin_emails`, the next `terraform apply`
# will revoke them. That's the point — drift detection IS the security
# posture. To grant or revoke admin access, update `admin_emails` in the
# environment-specific tfvars file and apply.
#
# Scope: this resource is per-service. Cloud Run direct IAP integration
# stores IAP IAM on the Cloud Run service resource, so this binding only
# affects gub-admin-${environment} and cannot leak onto other services.
#
# First-time bring-up: import the existing live binding before the first
# apply so the binding isn't briefly torn down and recreated:
#
#   terraform import \
#     -var-file=environments/dev.tfvars \
#     google_iap_web_cloud_run_service_iam_binding.gub_admin_users \
#     "projects/${var.project_id}/iap_web/cloud_run-${var.region}/services/gub-admin-${var.environment} roles/iap.httpsResourceAccessor"
#
# After import, `terraform plan` should report zero changes when
# `admin_emails` matches the live state.
###############################################################################

resource "google_iap_web_cloud_run_service_iam_binding" "gub_admin_users" {
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = "gub-admin-${var.environment}"
  role                   = "roles/iap.httpsResourceAccessor"
  members                = [for email in var.admin_emails : "user:${email}"]
}
