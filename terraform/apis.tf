###############################################################################
# GCP API enablement
#
# Ensures required APIs are enabled. Safe to run repeatedly — Terraform
# treats already-enabled APIs as no-ops.
###############################################################################

resource "google_project_service" "cloudscheduler" {
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
}

# Add additional APIs here as they come under Terraform management.
# Example:
# resource "google_project_service" "run" {
#   service            = "run.googleapis.com"
#   disable_on_destroy = false
# }
