# Deployment Guide

> **Status:** POC. All commands below were validated during the initial
> buildout. Variables like project IDs and service account names reflect
> the current dev environment.

## Prerequisites

- `gcloud` CLI authenticated with project owner or editor role
- `gh` CLI (GitHub) for repo operations
- Node.js 20+, Python 3.11+
- Docker (for local builds)

## Environment Variables

```
PROJECT_ID=os-test-491819
PROJECT_NUMBER=843516467880
REGION=us-central1
SQL_INSTANCE=gub-platform
```

---

## 1. GCP Project Setup

These are one-time operations for a new project. There is an existing
automation script that handles most of this:

```bash
# Automated setup — creates service accounts, secrets, triggers, etc.
./scripts/setup-gcp.sh $PROJECT_ID $REGION
```

If setting up manually or understanding what the script does:

### Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudfunctions.googleapis.com \
  aiplatform.googleapis.com \
  discoveryengine.googleapis.com \
  iap.googleapis.com \
  people.googleapis.com \
  --project=$PROJECT_ID
```

### Create Cloud SQL Instance

```bash
gcloud sql instances create $SQL_INSTANCE \
  --database-version=POSTGRES_14 \
  --tier=db-f1-micro \
  --region=$REGION \
  --project=$PROJECT_ID

gcloud sql databases create gub \
  --instance=$SQL_INSTANCE \
  --project=$PROJECT_ID
```

### Create Artifact Registry Repositories

```bash
gcloud artifacts repositories create gcp-universal-backend \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT_ID

gcloud artifacts repositories create gub-admin \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT_ID
```

---

## 2. GUB Backend (gcp-universal-backend)

### Service Account

```bash
# Create service account
gcloud iam service-accounts create sa-gcp-universal-backend-dev \
  --display-name="GUB Backend Dev" \
  --project=$PROJECT_ID

# Grant Cloud SQL client
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:sa-gcp-universal-backend-dev@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"

# Grant Secret Manager access
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:sa-gcp-universal-backend-dev@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Generate RS256 Keys

```bash
# Generate key pair
openssl genrsa -out private.pem 2048
openssl pkcs8 -topk8 -in private.pem -out private_pkcs8.pem -nocrypt
openssl rsa -in private.pem -pubout -out public.pem

# Base64 encode for Secret Manager
base64 -i private_pkcs8.pem | tr -d '\n' > private_b64.txt
base64 -i public.pem | tr -d '\n' > public_b64.txt
```

### Create Secrets

```bash
# Database URL
echo -n "postgresql://gub_app:<password>@/gub?host=/cloudsql/$PROJECT_ID:$REGION:$SQL_INSTANCE" | \
  gcloud secrets create dev-database-url \
    --data-file=- \
    --replication-policy=automatic \
    --project=$PROJECT_ID

# JWT keys
gcloud secrets create dev-jwt-private-key-b64 \
  --data-file=private_b64.txt \
  --replication-policy=automatic \
  --project=$PROJECT_ID

gcloud secrets create dev-jwt-public-key-b64 \
  --data-file=public_b64.txt \
  --replication-policy=automatic \
  --project=$PROJECT_ID

# Google OAuth client ID
echo -n "843516467880-crbjjtkp9ri8em139i03rf3gmgr95l8m.apps.googleusercontent.com" | \
  gcloud secrets create dev-google-client-id \
    --data-file=- \
    --replication-policy=automatic \
    --project=$PROJECT_ID

# Google OAuth client secret (needed for access token exchange)
echo -n "<client_secret>" | \
  gcloud secrets create dev-google-client-secret \
    --data-file=- \
    --replication-policy=automatic \
    --project=$PROJECT_ID

# App DB connections (JSON map — empty for POC, needed if apps use isolated DBs)
echo -n '{}' | \
  gcloud secrets create dev-app-db-connections \
    --data-file=- \
    --replication-policy=automatic \
    --project=$PROJECT_ID
```

### Cloud Build Setup

The Cloud Build service account needs these roles:

```bash
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/cloudsql.client"
```

### Create Cloud Build Trigger

```bash
gcloud builds triggers create github \
  --name="gub-backend-dev" \
  --repo-name=gcp-universal-backend \
  --repo-owner=bpriddy \
  --branch-pattern="^dev$" \
  --build-config=cloudbuild/dev.yaml \
  --project=$PROJECT_ID
```

### Deploy

Push to the `dev` branch to trigger Cloud Build:

```bash
git push origin dev
```

Or manually trigger:

```bash
gcloud builds triggers run gub-backend-dev \
  --branch=dev \
  --project=$PROJECT_ID
```

### Verify

```bash
# Check service is running
BACKEND_URL=$(gcloud run services describe gcp-universal-backend-dev \
  --region=$REGION --format='value(status.url)' --project=$PROJECT_ID)

curl -s "$BACKEND_URL/health" | jq .
# Expected: { "status": "ready" }

curl -s "$BACKEND_URL/.well-known/jwks.json" | jq .
# Expected: JWKS with RS256 public key
```

---

## 3. GUB Admin CMS (gub-admin)

### Service Account

```bash
gcloud iam service-accounts create sa-gub-admin-dev \
  --display-name="GUB Admin Dev" \
  --project=$PROJECT_ID

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:sa-gub-admin-dev@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:sa-gub-admin-dev@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Create Database Secret

The admin CMS uses the `gub_admin` role which has `BYPASSRLS` — full
table access without row-level security filtering. This is safe because
access is gated by Cloud IAP at the network layer.

```bash
echo -n "postgresql://gub_admin:<password>@/gub?host=/cloudsql/$PROJECT_ID:$REGION:$SQL_INSTANCE" | \
  gcloud secrets create gub-admin-db-url-dev \
    --data-file=- \
    --replication-policy=automatic \
    --project=$PROJECT_ID
```

### Cloud Build Trigger

```bash
gcloud builds triggers create github \
  --name="gub-admin-dev" \
  --repo-name=gub-admin \
  --repo-owner=bpriddy \
  --branch-pattern="^dev$" \
  --build-config=cloudbuild/dev.yaml \
  --project=$PROJECT_ID
```

**Important:** If you create the trigger through the Console UI, make
sure to set the build config to `cloudbuild/dev.yaml` explicitly. The
"autodetect" option will use the Dockerfile directly and skip the
Cloud Run deployment steps.

### Connect Repository to Cloud Build

If this is the first time connecting the GitHub repo:

```bash
# Open the Cloud Build repo connection page
echo "https://console.cloud.google.com/cloud-build/repos/2nd-gen?project=$PROJECT_ID"
```

Follow the UI to connect your GitHub account and link the repository.

### Deploy

```bash
git push origin dev
```

### IAP Setup (Optional for POC)

Cloud IAP for Cloud Run requires a Serverless NEG + HTTPS Load Balancer.
You cannot toggle IAP directly on a Cloud Run service. For the POC,
the service is deployed with `--no-allow-unauthenticated` which
restricts to IAM-authorized callers. Full IAP setup is a production task.

If you want basic access control without full IAP:

```bash
# Grant a user permission to invoke the service
gcloud run services add-iam-policy-binding gub-admin-dev \
  --region=$REGION \
  --member="user:you@yourdomain.com" \
  --role="roles/run.invoker" \
  --project=$PROJECT_ID
```

---

## 4. ADK Agent (gub-agent)

### Prerequisites

```bash
cd gub-agent
python -m venv .venv
source .venv/bin/activate
pip install -e ".[deploy]"
```

### Deploy to Vertex AI Agent Engine

```bash
# Authenticate
gcloud auth application-default login

# Deploy (from the gub-agent directory)
adk deploy agent_engine \
  --project=$PROJECT_ID \
  --region=$REGION \
  --agent_module=gub_agent

# Note the reasoning engine ID from the output, e.g.:
# projects/os-test-491819/locations/us-central1/reasoningEngines/9136379226620952576
```

After deployment, update `.env` with the engine ID:

```
AGENT_ENGINE_ID=9136379226620952576
```

### Register with Agentspace (Discovery Engine)

The registration script requires the Discovery Engine `v1alpha` API
(not `v1` — agent registration is alpha-only).

```bash
# Grant the Discovery Engine service account access to Agent Engine
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-discoveryengine.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# Register the agent
python deployment/register_agent.py
# Output: Registered agent: .../agents/4727522440043381131
```

To update or manage registrations:

```bash
python deployment/register_agent.py --list
python deployment/register_agent.py --update 4727522440043381131
python deployment/register_agent.py --delete 4727522440043381131
```

### Deploy the OAuth Relay Cloud Function

```bash
cd deployment/oauth-relay

gcloud functions deploy oauth-relay \
  --gen2 \
  --runtime=python312 \
  --region=$REGION \
  --source=. \
  --entry-point=oauth_relay \
  --trigger-http \
  --allow-unauthenticated \
  --project=$PROJECT_ID
```

Verify:

```bash
RELAY_URL="https://$REGION-$PROJECT_ID.cloudfunctions.net/oauth-relay"
curl -s -o /dev/null -w "%{http_code}" "$RELAY_URL?response_type=code&client_id=test"
# Expected: 302
```

### Configure Agentspace Authorization

This must be done via the Discovery Engine `v1alpha` API. The UI does
not expose all required fields.

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)

# Create authorization resource
curl -X POST \
  "https://discoveryengine.googleapis.com/v1alpha/projects/$PROJECT_ID/locations/global/authorizations?authorizationId=gub-oauth-3" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "oauthConfig": {
      "clientId": "843516467880-crbjjtkp9ri8em139i03rf3gmgr95l8m.apps.googleusercontent.com",
      "clientSecret": "<CLIENT_SECRET>",
      "authorizationUrl": "https://us-central1-os-test-491819.cloudfunctions.net/oauth-relay",
      "tokenUrl": "https://oauth2.googleapis.com/token",
      "scopes": ["openid", "email", "profile"]
    }
  }'
```

Then link the authorization to the agent in the Agentspace UI under
Agent settings → Authorization → select `gub-oauth-3`.

### Redeploying the Agent

When you change agent code:

```bash
source .venv/bin/activate

# If you get invalid_grant errors:
gcloud auth application-default login

adk deploy agent_engine \
  --project=$PROJECT_ID \
  --region=$REGION \
  --agent_module=gub_agent
```

The existing registration in Discovery Engine persists — no need to
re-register unless the reasoning engine ID changes.

---

## 5. Database Setup

### Connect to Cloud SQL

```bash
# Use the beta command (supports Cloud SQL Proxy for IPv6)
gcloud beta sql connect $SQL_INSTANCE \
  --database=gub \
  --user=postgres \
  --project=$PROJECT_ID
```

### Create Database Roles

The full role setup is in `scripts/setup-db-roles.sql`. It creates four
roles: `gub_migrator` (DDL), `gub_app` (DML with RLS), `gub_admin`
(DML with BYPASSRLS), and `gub_readonly` (SELECT only).

```bash
# Connect to Cloud SQL as postgres superuser
gcloud beta sql connect $SQL_INSTANCE --database=gub --user=postgres --project=$PROJECT_ID

# Then in psql:
\i scripts/setup-db-roles.sql
```

After running the script, set strong passwords:

```sql
ALTER ROLE gub_app PASSWORD '<strong_random_password>';
ALTER ROLE gub_admin PASSWORD '<strong_random_password>';
ALTER ROLE gub_migrator PASSWORD '<strong_random_password>';
```

### Run Migrations

Migrations are run by Cloud Build as part of the backend deployment.
For manual runs:

```bash
# From the gcp-universal-backend directory
DATABASE_URL="postgresql://postgres:<password>@/gub?host=/cloudsql/$PROJECT_ID:$REGION:$SQL_INSTANCE" \
  npx prisma migrate deploy
```

### Seed Test Data

See `scripts/seed-dev-data.sql` (if created) or use the admin CMS.
When seeding directly, note that several tables have append-only
triggers that prevent UPDATE and DELETE. To work around this:

```sql
-- As the postgres superuser:
SET ROLE postgres;

-- Disable triggers (USER level only — keeps system triggers)
ALTER TABLE account_changes DISABLE TRIGGER USER;
ALTER TABLE staff_changes DISABLE TRIGGER USER;
ALTER TABLE audit_log DISABLE TRIGGER USER;

-- ... insert/update data ...

-- Re-enable triggers
ALTER TABLE account_changes ENABLE TRIGGER USER;
ALTER TABLE staff_changes ENABLE TRIGGER USER;
ALTER TABLE audit_log ENABLE TRIGGER USER;
```

---

## 6. Google Directory Sync (Staff)

The backend includes a sync engine that pulls staff data from the
Google Workspace company directory (the same data visible at
`contacts.google.com/directory`). It uses the People API
`listDirectoryPeople` endpoint via a service account with domain-wide
delegation.

### 6a. Create the Service Account

```bash
gcloud iam service-accounts create gub-directory-sync \
  --display-name="GUB Directory Sync" \
  --project=$PROJECT_ID
```

No GCP IAM roles are needed — the service account's power comes
entirely from the domain-wide delegation configured in Google Admin.

### 6b. Enable Domain-Wide Delegation

1. In GCP Console → **IAM & Admin → Service Accounts**, open
   `gub-directory-sync@$PROJECT_ID.iam.gserviceaccount.com`.
2. Check **"Enable Google Workspace Domain-wide Delegation"**.
3. Note the **Client ID** (numeric) shown on the detail page.

### 6c. Authorize the Scope in Google Admin Console

This step requires a **Workspace super admin**.

1. Go to `https://admin.google.com`
2. Navigate to **Security → Access and data control → API controls →
   Manage Domain Wide Delegation**
3. Click **Add new** and enter:
   - **Client ID:** the numeric ID from step 6b
   - **Scopes:** `https://www.googleapis.com/auth/directory.readonly`
4. Click **Authorize**

### 6d. Create a JSON Key

```bash
gcloud iam service-accounts keys create secrets/gub-directory-sync.json \
  --iam-account=gub-directory-sync@$PROJECT_ID.iam.gserviceaccount.com \
  --project=$PROJECT_ID
```

The `secrets/` directory is gitignored. Never commit this file.

### 6e. Configure Environment Variables

**Local dev** — add to `.env`:

```env
GOOGLE_DIRECTORY_SA_KEY_PATH=./secrets/gub-directory-sync.json
GOOGLE_DIRECTORY_IMPERSONATE_EMAIL=support@yourdomain.com
```

**Deployed (Cloud Run)** — base64 the key and store in Secret Manager:

```bash
base64 -i secrets/gub-directory-sync.json | tr -d '\n' | \
  gcloud secrets create dev-directory-sa-key-b64 \
    --data-file=- \
    --replication-policy=automatic \
    --project=$PROJECT_ID
```

Then add to the Cloud Build deploy step's `--set-secrets`:

```
GOOGLE_DIRECTORY_SA_KEY_B64=dev-directory-sa-key-b64:latest
```

And set the impersonation email as a plain env var:

```
GOOGLE_DIRECTORY_IMPERSONATE_EMAIL=support@yourdomain.com
```

`GOOGLE_DIRECTORY_IMPERSONATE_EMAIL` should be a durable functional
mailbox (e.g. `support@`, `it@`, `systems@`) — not a personal account
that could be deactivated. The service account impersonates this user
to read the directory. Any domain member sees the same directory, so
the choice only matters for durability.

### 6f. Test the Sync

```bash
# Local
curl -X POST http://localhost:3000/integrations/google-directory/cron

# Deployed
curl -X POST "$BACKEND_URL/integrations/google-directory/cron"
```

Returns `202` immediately. Check logs for the sync result:

```json
{
  "total": 150,
  "created": 148,
  "updated": 2,
  "unchanged": 0,
  "skipped": 0,
  "errors": 0
}
```

### 6g. Schedule Daily Sync (Production)

Set up a Cloud Scheduler job to call the cron endpoint daily:

```bash
gcloud scheduler jobs create http directory-sync-daily \
  --location=$REGION \
  --schedule="0 3 * * *" \
  --time-zone="UTC" \
  --uri="$BACKEND_URL/integrations/google-directory/cron" \
  --http-method=POST \
  --oidc-service-account-email=sa-gcp-universal-backend-dev@$PROJECT_ID.iam.gserviceaccount.com \
  --oidc-token-audience="$BACKEND_URL" \
  --project=$PROJECT_ID
```

### What the Sync Does

- Fetches all domain profiles from the People API (same as
  `contacts.google.com/directory`)
- For each person: creates or updates a `staff` record, tracked via
  `staff_external_ids` (system: `google_directory`)
- If a staff record with the same email already exists (e.g.
  admin-created), it links to it rather than creating a duplicate
- Core fields (name, email, title, department) are diffed — only
  actual changes produce `staff_changes` audit rows
- Everything else (phones, locations, relations/manager, skills,
  bios, addresses, nicknames, URLs, birthdays, etc.) is stored in
  `staff_metadata` tagged with `source: "google_directory_sync"` —
  replaced wholesale each run without touching manually-created
  metadata

### Fields Pulled from Directory

| Category | What's extracted |
|----------|-----------------|
| **Staff columns** | fullName, email, title, department, status, photoUrl |
| **Metadata: phone** | All phone numbers with type (work, mobile, etc.) |
| **Metadata: location** | Building, floor, section, desk code |
| **Metadata: relation** | Manager, assistant, and other relationships |
| **Metadata: skill** | Skills listed in the directory profile |
| **Metadata: biography** | Bio / about text |
| **Metadata: address** | Work and other addresses |
| **Metadata: nickname** | Display nicknames |
| **Metadata: occupation** | Headline / occupation text |
| **Metadata: external_id** | Employee number and other external IDs |
| **Metadata: url** | Personal website, LinkedIn, etc. |
| **Metadata: birthday** | Birthday (if shared in directory) |
| **Metadata: sip** | SIP addresses |
| **Metadata: organization** | Additional org entries beyond primary |

---

## 7. Service URLs (Current Dev — Test Project)

| Service | URL |
|---------|-----|
| GUB Backend | `https://gcp-universal-backend-dev-843516467880.us-central1.run.app` |
| GUB Admin CMS | `https://gub-admin-dev-843516467880.us-central1.run.app` |
| OAuth Relay | `https://us-central1-os-test-491819.cloudfunctions.net/oauth-relay` |
| JWKS Endpoint | `https://gcp-universal-backend-dev-843516467880.us-central1.run.app/.well-known/jwks.json` |
| Health Check | `https://gcp-universal-backend-dev-843516467880.us-central1.run.app/health` |

---

## 8. Monitoring & Debugging

### View Cloud Run Logs

```bash
# Backend logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=gcp-universal-backend-dev" \
  --limit=50 --format=json --project=$PROJECT_ID

# Admin CMS logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=gub-admin-dev" \
  --limit=50 --format=json --project=$PROJECT_ID
```

### View Agent Engine Logs

```bash
gcloud logging read "resource.type=aiplatform.googleapis.com/ReasoningEngine" \
  --limit=50 --format=json --project=$PROJECT_ID
```

### View OAuth Relay Logs

```bash
gcloud functions logs read oauth-relay \
  --gen2 --region=$REGION --limit=20 --project=$PROJECT_ID
```

### Check Cloud Build Status

```bash
gcloud builds list --limit=5 --project=$PROJECT_ID
gcloud builds log <BUILD_ID> --project=$PROJECT_ID
```
