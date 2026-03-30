#!/usr/bin/env bash
###############################################################################
# setup-cloud-sql.sh
#
# Provisions a shared Cloud SQL PostgreSQL instance for all environments.
# One instance, three databases (gub_dev / gub_staging / gub_prod).
# Per-env DB users are created and their DATABASE_URLs written to Secret Manager.
#
# Run AFTER setup-gcp.sh (secrets must already exist).
#
# Usage:
#   ./scripts/setup-cloud-sql.sh <project-id> <region>
#
# Example:
#   ./scripts/setup-cloud-sql.sh my-gcp-project us-central1
###############################################################################
set -euo pipefail

PROJECT_ID="${1:?Usage: $0 <project-id> <region>}"
REGION="${2:?Usage: $0 <project-id> <region>}"

INSTANCE_NAME="gub-platform"
POSTGRES_VERSION="POSTGRES_15"
TIER="db-g1-small"    # 0.5 vCPU / 1.7 GB — upgrade prod tier after first deploy if needed
ENVS=("dev" "staging" "prod")

echo "Setting up Cloud SQL in project: $PROJECT_ID / region: $REGION"
echo ""

gcloud config set project "$PROJECT_ID"

# ── Enable API ────────────────────────────────────────────────────────────────
echo "→ Enabling Cloud SQL Admin API..."
gcloud services enable sqladmin.googleapis.com

# ── Create instance ───────────────────────────────────────────────────────────
echo "→ Creating Cloud SQL instance: $INSTANCE_NAME (this takes ~5 minutes on first run)..."
gcloud sql instances create "$INSTANCE_NAME" \
  --database-version="$POSTGRES_VERSION" \
  --tier="$TIER" \
  --region="$REGION" \
  --storage-auto-increase \
  --backup-start-time=03:00 \
  --retained-backups-count=7 \
  --deletion-protection \
  2>/dev/null || echo "   (already exists, skipping)"

CONN_NAME=$(gcloud sql instances describe "$INSTANCE_NAME" --format='value(connectionName)')
echo "   Connection name: $CONN_NAME"

# ── Per-environment databases and users ───────────────────────────────────────
for ENV in "${ENVS[@]}"; do
  DB_NAME="gub_$ENV"
  DB_USER="gub_$ENV"
  SECRET_NAME="$ENV-database-url"

  echo ""
  echo "── Environment: $ENV ──────────────────────────────────────────────────"

  # Database
  echo "→ Creating database: $DB_NAME..."
  gcloud sql databases create "$DB_NAME" \
    --instance="$INSTANCE_NAME" \
    2>/dev/null || echo "   (already exists, skipping)"

  # DB user + password
  PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)

  echo "→ Creating/updating DB user: $DB_USER..."
  gcloud sql users create "$DB_USER" \
    --instance="$INSTANCE_NAME" \
    --password="$PASSWORD" \
    2>/dev/null || {
    echo "   (user exists — rotating password)"
    gcloud sql users set-password "$DB_USER" \
      --instance="$INSTANCE_NAME" \
      --password="$PASSWORD"
  }

  # Write DATABASE_URL to Secret Manager
  # Cloud Run connects via Unix socket when --add-cloudsql-instances is set.
  DB_URL="postgresql://${DB_USER}:${PASSWORD}@/${DB_NAME}?host=/cloudsql/${CONN_NAME}"

  echo "→ Writing DATABASE_URL to Secret Manager: $SECRET_NAME..."
  echo -n "$DB_URL" | gcloud secrets versions add "$SECRET_NAME" --data-file=-
  echo "   ✓ $ENV done"
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "========================================================================="
echo "  Cloud SQL setup complete."
echo ""
echo "  Instance:   $CONN_NAME"
echo "  Databases:  gub_dev, gub_staging, gub_prod"
echo ""
echo "  Add to every Cloud Run deploy command:"
echo "    --add-cloudsql-instances=$CONN_NAME"
echo ""
echo "  The cloudbuild yamls in this repo already include this flag."
echo ""
echo "  To upgrade the prod instance tier later:"
echo "    gcloud sql instances patch $INSTANCE_NAME --tier=db-n1-standard-2"
echo "========================================================================="
