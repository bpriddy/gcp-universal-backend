# Commands Reference

> Validated commands from the POC buildout. Copy-paste ready for the
> current dev environment (`os-test-491819`).

## Environment

```bash
export PROJECT_ID=os-test-491819
export PROJECT_NUMBER=843516467880
export REGION=us-central1
export SQL_INSTANCE=gub-platform
```

---

## Database

### Connect to Cloud SQL

```bash
# Use beta for Cloud SQL Proxy (avoids IPv6 issues)
gcloud beta sql connect $SQL_INSTANCE \
  --database=gub \
  --user=postgres \
  --project=$PROJECT_ID
```

### Run Migrations (Manual)

```bash
# From gcp-universal-backend directory
DATABASE_URL="postgresql://gub_migrator:<password>@/gub?host=/cloudsql/$PROJECT_ID:$REGION:$SQL_INSTANCE" \
  npx prisma migrate deploy
```

### Disable Append-Only Triggers (for data fixes)

```sql
-- As postgres superuser, use DISABLE TRIGGER USER (not ALL)
ALTER TABLE account_changes DISABLE TRIGGER USER;
ALTER TABLE staff_changes DISABLE TRIGGER USER;
ALTER TABLE audit_log DISABLE TRIGGER USER;

-- ... make changes ...

ALTER TABLE account_changes ENABLE TRIGGER USER;
ALTER TABLE staff_changes ENABLE TRIGGER USER;
ALTER TABLE audit_log ENABLE TRIGGER USER;
```

### Set User as Admin

```sql
UPDATE users SET is_admin = true WHERE email = 'you@yourdomain.com';
```

---

## Cloud Build

### Trigger a Build Manually

```bash
# Backend
gcloud builds triggers run gub-backend-dev \
  --branch=dev \
  --project=$PROJECT_ID

# Admin CMS
gcloud builds triggers run gub-admin-dev \
  --branch=dev \
  --project=$PROJECT_ID
```

### Check Build Status

```bash
gcloud builds list --limit=5 --project=$PROJECT_ID
gcloud builds log <BUILD_ID> --project=$PROJECT_ID
```

### Fix: Cloud Build Permission Errors

These were the IAM grants needed during the POC:

```bash
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

# If "artifactregistry.repositories.uploadArtifacts" denied:
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" --role="roles/artifactregistry.writer"

# If "run.services.get" denied:
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" --role="roles/run.admin"

# If "iam.serviceaccounts.actAs" denied:
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$CB_SA" --role="roles/iam.serviceAccountUser"
```

---

## Cloud Run

### Check Service Status

```bash
# Backend
gcloud run services describe gcp-universal-backend-dev \
  --region=$REGION --project=$PROJECT_ID \
  --format='value(status.url)'

# Admin
gcloud run services describe gub-admin-dev \
  --region=$REGION --project=$PROJECT_ID \
  --format='value(status.url)'
```

### Health Check

```bash
BACKEND_URL="https://gcp-universal-backend-dev-843516467880.us-central1.run.app"
curl -s "$BACKEND_URL/health" | jq .
```

### Grant a User Cloud Run Invoke Access

```bash
gcloud run services add-iam-policy-binding gub-admin-dev \
  --region=$REGION \
  --member="user:you@yourdomain.com" \
  --role="roles/run.invoker" \
  --project=$PROJECT_ID
```

---

## Logs

### Cloud Run Logs

```bash
# Backend (recent 50 entries)
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=gcp-universal-backend-dev" \
  --limit=50 --format=json --project=$PROJECT_ID

# Admin CMS
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=gub-admin-dev" \
  --limit=50 --format=json --project=$PROJECT_ID
```

### Agent Engine Logs

```bash
gcloud logging read \
  "resource.type=aiplatform.googleapis.com/ReasoningEngine" \
  --limit=50 --format=json --project=$PROJECT_ID
```

### OAuth Relay Logs

```bash
gcloud functions logs read oauth-relay \
  --gen2 --region=$REGION --limit=20 --project=$PROJECT_ID
```

---

## ADK Agent

### Deploy to Agent Engine

```bash
cd gub-agent
source .venv/bin/activate

# Re-authenticate if you get invalid_grant errors
gcloud auth application-default login

adk deploy agent_engine \
  --project=$PROJECT_ID \
  --region=$REGION \
  --agent_module=gub_agent
```

### Run Locally

```bash
cd gub-agent
source .venv/bin/activate

# With a service JWT for local testing:
GUB_SERVICE_JWT="<jwt>" GUB_BASE_URL="http://localhost:3000" \
  adk run gub_agent
```

### Register / Update Agent in Discovery Engine

```bash
cd gub-agent

# List registered agents
python deployment/register_agent.py --list

# Register new
python deployment/register_agent.py

# Update existing
python deployment/register_agent.py --update 4727522440043381131

# Delete
python deployment/register_agent.py --delete 4727522440043381131
```

---

## OAuth Relay

### Deploy

```bash
cd gub-agent/deployment/oauth-relay

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

### Test

```bash
RELAY_URL="https://$REGION-$PROJECT_ID.cloudfunctions.net/oauth-relay"
curl -s -o /dev/null -w "%{http_code}" "$RELAY_URL?response_type=code&client_id=test"
# Expected: 302
```

---

## Discovery Engine API (v1alpha)

### Authorization Resources

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)
BASE="https://discoveryengine.googleapis.com/v1alpha/projects/$PROJECT_ID/locations/global"

# List authorizations
curl -s "$BASE/authorizations" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .

# Get specific authorization
curl -s "$BASE/authorizations/gub-oauth-3" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .

# Create authorization
curl -X POST "$BASE/authorizations?authorizationId=gub-oauth-3" \
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

### Agent Management

```bash
APP_ID="gub-agentspace-test_1775506197940"
AGENTS_BASE="$BASE/collections/default_collection/engines/$APP_ID/assistants/default_assistant/agents"

# List agents
curl -s "$AGENTS_BASE" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .

# Get agent
curl -s "$AGENTS_BASE/4727522440043381131" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

---

## Secret Manager

### Update a Secret Value

```bash
echo -n "<new_value>" | \
  gcloud secrets versions add <secret-name> \
    --data-file=- \
    --project=$PROJECT_ID
```

### Read Current Secret Value

```bash
gcloud secrets versions access latest \
  --secret=<secret-name> \
  --project=$PROJECT_ID
```

---

## RS256 Key Management

### Generate New Key Pair

```bash
# Using the built-in script
npm run keys:generate

# Or manually
openssl genrsa -out private.pem 2048
openssl pkcs8 -topk8 -in private.pem -out private_pkcs8.pem -nocrypt
openssl rsa -in private.pem -pubout -out public.pem

# Base64 encode for Secret Manager
base64 -i private_pkcs8.pem | tr -d '\n' > private_b64.txt
base64 -i public.pem | tr -d '\n' > public_b64.txt

# Upload to Secret Manager
gcloud secrets versions add dev-jwt-private-key-b64 --data-file=private_b64.txt --project=$PROJECT_ID
gcloud secrets versions add dev-jwt-public-key-b64 --data-file=public_b64.txt --project=$PROJECT_ID
```
