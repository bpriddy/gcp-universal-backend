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
      version = "~> 5.0"
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
