#!/usr/bin/env bash
###############################################################################
# setup-gcp.sh
#
# One-time GCP resource provisioning for gcp-universal-backend.
# Run once per project before the first Cloud Build trigger fires.
#
# Usage:
#   ./scripts/setup-gcp.sh <project-id> <region>
#
# Example:
#   ./scripts/setup-gcp.sh my-gcp-project us-central1
###############################################################################
set -euo pipefail

PROJECT_ID="${1:?Usage: $0 <project-id> <region>}"
REGION="${2:?Usage: $0 <project-id> <region>}"
AR_REPO="gcp-universal-backend"
ENVS=("dev" "staging" "prod")

echo "Setting up GCP resources in project: $PROJECT_ID / region: $REGION"
echo ""

gcloud config set project "$PROJECT_ID"

# ── Enable required APIs ──────────────────────────────────────────────────────
echo "→ Enabling APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com

# ── Artifact Registry repository ─────────────────────────────────────────────
echo "→ Creating Artifact Registry repository: $AR_REPO..."
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="gcp-universal-backend container images" \
  2>/dev/null || echo "   (already exists, skipping)"

# ── Per-environment resources ─────────────────────────────────────────────────
for ENV in "${ENVS[@]}"; do
  SERVICE="gcp-universal-backend-$ENV"
  SA_NAME="sa-$SERVICE"
  SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

  echo ""
  echo "── Environment: $ENV ─────────────────────────────────────────────────"

  # Service account
  echo "→ Creating service account: $SA_NAME..."
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="gcp-universal-backend $ENV runtime" \
    2>/dev/null || echo "   (already exists, skipping)"

  # IAM roles for the runtime service account
  echo "→ Granting runtime IAM roles to $SA_NAME..."
  for ROLE in \
    roles/secretmanager.secretAccessor \
    roles/cloudtrace.agent \
    roles/logging.logWriter \
    roles/monitoring.metricWriter \
    roles/cloudsql.client; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:$SA_EMAIL" \
      --role="$ROLE" \
      --quiet
  done

  # Secret Manager placeholders — populate values after running this script
  echo "→ Creating Secret Manager secrets for $ENV..."
  for SECRET in \
    "$ENV-database-url" \
    "$ENV-app-db-connections" \
    "$ENV-google-client-id" \
    "$ENV-jwt-private-key-b64" \
    "$ENV-jwt-public-key-b64"; do
    gcloud secrets create "$SECRET" \
      --replication-policy=automatic \
      2>/dev/null || echo "   (secret $SECRET already exists, skipping)"
  done
done

# ── Cloud Build service account permissions ───────────────────────────────────
echo ""
echo "── Cloud Build permissions ───────────────────────────────────────────────"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CB_SA="$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"

echo "→ Granting Cloud Build SA permissions..."
for ROLE in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/artifactregistry.writer \
  roles/secretmanager.secretAccessor \
  roles/cloudsql.client; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$CB_SA" \
    --role="$ROLE" \
    --quiet
done

# ── Cloud Build triggers ──────────────────────────────────────────────────────
echo ""
echo "── Creating Cloud Build triggers ────────────────────────────────────────"

declare -A BRANCH_MAP
BRANCH_MAP[dev]="^dev$"
BRANCH_MAP[staging]="^staging$"
BRANCH_MAP[prod]="^main$"

for ENV in "${ENVS[@]}"; do
  TRIGGER_NAME="deploy-$ENV"
  echo "→ Creating trigger: $TRIGGER_NAME (branch: ${BRANCH_MAP[$ENV]})..."
  gcloud builds triggers create github \
    --name="$TRIGGER_NAME" \
    --repo-name="gcp-universal-backend" \
    --repo-owner="bpriddy" \
    --branch-pattern="${BRANCH_MAP[$ENV]}" \
    --build-config="cloudbuild/$ENV.yaml" \
    --region="$REGION" \
    2>/dev/null || echo "   (trigger $TRIGGER_NAME already exists, skipping)"
done

# ── Cloud Scheduler — nightly cleanup jobs ────────────────────────────────────
# Creates one Cloud Scheduler job per environment that triggers the cleanup
# Cloud Run Job at 02:00 local time (UTC). The Cloud Run Job is deployed by
# Cloud Build on every push — Cloud Scheduler owns the execution schedule.

echo ""
echo "── Creating Cloud Scheduler cleanup jobs ────────────────────────────────"

gcloud services enable cloudscheduler.googleapis.com

for ENV in "${ENVS[@]}"; do
  SERVICE="gcp-universal-backend-$ENV"
  SA_EMAIL="sa-$SERVICE@$PROJECT_ID.iam.gserviceaccount.com"
  SCHEDULER_NAME="cleanup-$ENV"
  JOB_NAME="$SERVICE-cleanup"

  echo "→ Creating Cloud Scheduler job: $SCHEDULER_NAME..."
  gcloud scheduler jobs create http "$SCHEDULER_NAME" \
    --location="$REGION" \
    --schedule="0 2 * * *" \
    --time-zone="UTC" \
    --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/$JOB_NAME:run" \
    --message-body="{}" \
    --oauth-service-account-email="$SA_EMAIL" \
    --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
    --attempt-deadline=360s \
    2>/dev/null || echo "   (scheduler job $SCHEDULER_NAME already exists, skipping)"

  # Grant the service account permission to invoke Cloud Run Jobs
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/run.invoker" \
    --quiet
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "========================================================================="
echo "  Setup complete."
echo ""
echo "  Next steps:"
echo ""
echo "  1. Provision Cloud SQL (run once after this script):"
echo "     ./scripts/setup-cloud-sql.sh $PROJECT_ID $REGION"
echo "     (Creates the instance, databases, users, and writes DATABASE_URLs"
echo "      to Secret Manager automatically.)"
echo ""
echo "  2. Connect your GitHub repo to Cloud Build at:"
echo "     https://console.cloud.google.com/cloud-build/triggers/connect"
echo ""
echo "  3. Generate JWT keys per environment and store as base64 in secrets:"
echo "     ./scripts/generate-keys.sh"
echo "     base64 -i keys/private.pem | tr -d '\\n' | \\"
echo "       gcloud secrets versions add <env>-jwt-private-key-b64 --data-file=-"
echo ""
echo "  4. Populate remaining secrets (google-client-id, app-db-connections):"
echo "     gcloud secrets versions add <secret-name> --data-file=-"
echo ""
echo "  5. Push to dev/staging/main to trigger the first deploy."
echo "========================================================================="
