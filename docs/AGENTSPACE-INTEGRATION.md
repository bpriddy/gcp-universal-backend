# Agentspace Integration Guide

> This documents the integration between the GUB agent and Google
> Agentspace (Gemini Enterprise). Several workarounds are in place
> for platform bugs — see [KNOWN-ISSUES.md](./KNOWN-ISSUES.md).

## Overview

The GUB agent is built with Google's ADK (Agent Development Kit) and
deployed to Vertex AI Agent Engine. It is then registered with
Agentspace via the Discovery Engine API so users can interact with it
through the Agentspace chat interface.

## Component Chain

```
Agentspace UI → Discovery Engine → Vertex AI Agent Engine → gub-agent (ADK) → GUB Backend
```

## Step-by-Step Setup

### 1. Deploy the Agent to Vertex AI Agent Engine

```bash
cd gub-agent
source .venv/bin/activate

# Ensure gcloud ADC is fresh
gcloud auth application-default login

# Deploy
adk deploy agent_engine \
  --project=os-test-491819 \
  --region=us-central1 \
  --agent_module=gub_agent
```

Save the reasoning engine ID from the output:
```
projects/os-test-491819/locations/us-central1/reasoningEngines/9136379226620952576
```

### 2. Grant Discovery Engine Access to Agent Engine

```bash
gcloud projects add-iam-policy-binding os-test-491819 \
  --member="serviceAccount:service-843516467880@gcp-sa-discoveryengine.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

### 3. Deploy the OAuth Relay

```bash
cd gub-agent/deployment/oauth-relay

gcloud functions deploy oauth-relay \
  --gen2 \
  --runtime=python312 \
  --region=us-central1 \
  --source=. \
  --entry-point=oauth_relay \
  --trigger-http \
  --allow-unauthenticated \
  --project=os-test-491819
```

### 4. Create the Authorization Resource

Uses the Discovery Engine `v1alpha` API (authorization management is
not in `v1`):

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)

curl -X POST \
  "https://discoveryengine.googleapis.com/v1alpha/projects/os-test-491819/locations/global/authorizations?authorizationId=gub-oauth-3" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "oauthConfig": {
      "clientId": "843516467880-crbjjtkp9ri8em139i03rf3gmgr95l8m.apps.googleusercontent.com",
      "clientSecret": "<GOOGLE_CLIENT_SECRET>",
      "authorizationUrl": "https://us-central1-os-test-491819.cloudfunctions.net/oauth-relay",
      "tokenUrl": "https://oauth2.googleapis.com/token",
      "scopes": ["openid", "email", "profile"]
    }
  }'
```

### 5. Register the Agent with Discovery Engine

```bash
cd gub-agent

# Set required env vars
export GCP_PROJECT_ID=os-test-491819
export GCP_PROJECT_NUMBER=843516467880
export GEMINI_APP_ID=gub-agentspace-test_1775506197940
export AGENT_ENGINE_ID=9136379226620952576

python deployment/register_agent.py
```

### 6. Link Authorization to Agent

In the Agentspace console:
1. Go to the agent's settings
2. Under Authorization, select `gub-oauth-3`
3. Save

### 7. Test

Open the Agentspace app and send a message that triggers the agent,
e.g. "What accounts do I have access to?"

The first request will prompt an OAuth consent flow. After consent,
the token is cached and subsequent requests work without re-auth.

## Agent Configuration

### Environment Variables (Deployed)

The deployed agent does **not** load `.env` files. Configuration is
set via defaults in `config.py`:

| Variable | Default (deployed) | Notes |
|----------|-------------------|-------|
| `GUB_BASE_URL` | `https://gcp-universal-backend-dev-843516467880.us-central1.run.app` | Must match deployed backend URL |
| `GUB_SERVICE_JWT` | `""` (empty) | Not used in deployed mode — OAuth token is injected |
| `GUB_AUTHORIZATION_ID` | `gub-oauth-3` | Must match Discovery Engine authorization ID exactly |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model used by ADK agent |
| `AGENT_NAME` | `gub_agent` | Agent display name |

**Critical:** The `GUB_AUTHORIZATION_ID` must match the authorization
resource ID in Discovery Engine character-for-character. Any mismatch
causes silent token injection failure.

### Local Development

For local development without Agentspace:

```bash
cd gub-agent
source .venv/bin/activate

# Set a service JWT (obtain from browser login or broker flow)
echo 'GUB_SERVICE_JWT=<your_jwt>' >> .env
echo 'GUB_BASE_URL=http://localhost:3000' >> .env

# Run locally with ADK
adk run gub_agent
```

## Tool Context State

When Agentspace routes a request to the agent, it injects the user's
Google OAuth access token into `tool_context.state`. The token is
stored under the authorization ID as a raw key:

```python
# The token is at state["gub-oauth-3"] (raw key, no prefix)
state_dict = tool_context.state.to_dict()
google_access_token = state_dict.get("gub-oauth-3")
```

**Do not use `tool_context.state.get(key)`** for this — the `State`
class prepends prefix strings (`app:`, `temp:`) that don't match the
raw key. Always use `to_dict()` first.

The agent then exchanges this Google access token for a GUB JWT:

```
POST {GUB_BASE_URL}/auth/google/access-token-exchange
Body: { "accessToken": "<google_access_token>" }
```

The GUB JWT is cached in `tool_context.state["gub_jwt"]` for the
duration of the session.

## Agent Tools

The agent exposes 6 tools to the LLM:

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `find_staff_for_resourcing` | `GET /org/resourcing` | Search staff by skills, metadata |
| `get_staff_profile` | `GET /org/staff/:id` + `/metadata` | Full staff profile |
| `search_staff` | `GET /org/staff` | General people search |
| `list_accounts` | `GET /org/accounts` | Discover accessible accounts |
| `get_account_overview` | `GET /org/accounts/:id` + `/campaigns` | Account + campaigns |
| `get_campaign` | `GET /org/campaigns/:id` | Single campaign detail |

All tools receive `tool_context` as the last parameter, which ADK
injects automatically. The `_client.py` module handles auth resolution
transparently.

## Discovery Engine API Reference

All management operations use `v1alpha`:

```bash
BASE="https://discoveryengine.googleapis.com/v1alpha/projects/os-test-491819/locations/global"

# List authorizations
curl "$BASE/authorizations" -H "Authorization: Bearer $(gcloud auth print-access-token)"

# Get specific authorization
curl "$BASE/authorizations/gub-oauth-3" -H "Authorization: Bearer $(gcloud auth print-access-token)"

# List registered agents
curl "$BASE/collections/default_collection/engines/gub-agentspace-test_1775506197940/assistants/default_assistant/agents" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)"

# Get agent details
curl "$BASE/collections/default_collection/engines/gub-agentspace-test_1775506197940/assistants/default_assistant/agents/4727522440043381131" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)"
```
