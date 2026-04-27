###############################################################################
# GUB Platform — Terraform Configuration
#
# Manages GCP infrastructure for the GCP Universal Backend platform.
# Currently scoped to Cloud Scheduler jobs; designed to expand to cover
# all platform resources over time.
#
# Usage:
#   cd terraform
#   terraform init
#   terraform plan  -var-file=environments/dev.tfvars
#   terraform apply -var-file=environments/dev.tfvars
###############################################################################

terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      # v6.x is required for google_iap_web_cloud_run_service_iam_*
      # (see gub_admin_iap.tf). google_cloud_scheduler_job and
      # google_project_service have no breaking changes in 6.0.
      version = "~> 6.0"
    }
  }

  # Remote state in GCS — create the bucket once manually:
  #   gsutil mb -p $PROJECT_ID -l $REGION gs://$PROJECT_ID-tfstate
  #   gsutil versioning set on gs://$PROJECT_ID-tfstate
  #
  # Uncomment after creating the bucket:
  # backend "gcs" {
  #   bucket = "os-test-491819-tfstate"
  #   prefix = "gub-platform"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
