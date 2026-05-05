# Architecture Overview

> **Status:** Proof of Concept (POC)
> This system demonstrates end-to-end functionality. It is intended to be
> hardened and brought to production by a vendor with infrastructure and
> security expertise.

## System Map

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Google Cloud (os-test-491819)                    │
│                                                                          │
│  ┌─────────────┐    ┌───────────────────────┐    ┌────────────────────┐  │
│  │ Agentspace   │───▶│  Vertex AI Agent       │───▶│  GUB Backend       │  │
│  │ (Gemini      │    │  Engine                │    │  (Cloud Run)       │  │
│  │  Enterprise) │    │                        │    │                    │  │
│  │              │    │  gub-agent (ADK)       │    │  Express + Prisma  │  │
│  └──────┬───────┘    └───────────────────────┘    └────────┬───────────┘  │
│         │                                                   │             │
│         │ OAuth                                             │             │
│         ▼                                                   ▼             │
│  ┌──────────────┐    ┌───────────────────────┐    ┌────────────────────┐  │
│  │ OAuth Relay   │    │  GUB Admin CMS        │    │  Cloud SQL         │  │
│  │ (Cloud Func.) │    │  (Cloud Run)          │    │  (PostgreSQL 14)   │  │
│  │              │    │                        │    │                    │  │
│  │ Workaround   │    │  Next.js + Prisma      │    │  Shared database   │  │
│  └──────────────┘    └───────────────────────┘    └────────────────────┘  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Three Repositories

| Repo | Language | Purpose | Deployed To |
|------|----------|---------|-------------|
| **gcp-universal-backend** | TypeScript / Node.js | Auth gateway + org data API | Cloud Run |
| **gub-agent** | Python | ADK agent for Agentspace | Vertex AI Agent Engine |
| **gub-admin** | TypeScript / Next.js | Admin CMS for data management | Cloud Run |

### gcp-universal-backend (this repo)

The core backend. Accepts Google OAuth tokens, validates users against
PostgreSQL, and issues RS256-signed JWTs. Downstream apps verify tokens
via the public JWKS endpoint with no callback required.

**Key responsibilities:**
- Google OAuth token verification and user identity resolution
- RS256 JWT signing with JWKS discovery endpoint
- Refresh token rotation with reuse detection
- Organization data API — accounts, campaigns, offices, teams, staff, users
  — all gated by `access_grants` (per-resource + cohort scopes like
  `office_active`, `team_active`, `staff_current`)
- OAuth 2.0 broker for headless clients (server-side flow)
- Google access token exchange endpoint (for ADK agent)
- Staff metadata and resourcing search
- Data sync engine — Google Directory staff sync (active, LLM-classified),
  Google Drive LLM extraction (active, incremental polling via
  `changes.list` + chunked bootstrap + stale-sync reaper), with Workfront
  and staff metadata import planned
- Staff classifier (`src/modules/staff-classifier/`) — source-agnostic
  `{email, displayName}` → `person | skip` decision. Two hard filters +
  batched Gemini with greedy-keep bias. Used by Directory sync today;
  reusable for Okta/BambooHR/whatever comes next.
- Drive review workflow — notify + magic-link + apply for Drive proposals
- Sync run logging with structured details, human-readable summaries, and
  a stale-run auto-sweeper (guards against Cloud Run CPU-throttled
  background work dying mid-flight)
- Row-level security via AsyncLocalStorage + PostgreSQL `set_config`
- Workspace pass-through auth — clients pass Google access tokens via
  `X-Workspace-Token`; GUB never stores Workspace refresh tokens. Service
  account fallback on backend/admin/cron paths only (see
  [AUTH-FLOW.md § Path 4](./AUTH-FLOW.md#path-4-workspace-pass-through-client-owned-oauth))

**Tech stack:** Express, Prisma ORM, jose (JWT), google-auth-library,
Zod validation, Pino structured logging, Helmet security headers.

### gub-agent

A Python ADK (Agent Development Kit) agent deployed to Vertex AI Agent
Engine and registered with Agentspace (Gemini Enterprise).

**Key responsibilities:**
- Natural language interface to GUB backend data
- Staff resourcing — find people by skills, interests, certifications
- Account and campaign lookups
- OAuth token exchange with GUB backend (Google access token → GUB JWT)

**Tech stack:** google-adk, httpx, python-dotenv.

**Tools exposed to the LLM:**
- `find_staff_for_resourcing` — metadata-based people search
- `get_staff_profile` — full staff profile with metadata
- `search_staff` — general name/title/email search
- `list_accounts` — discover accessible accounts
- `get_account_overview` — account + all campaigns
- `get_campaign` — single campaign detail

### gub-admin

A Next.js admin CMS for managing all data in the shared PostgreSQL
database. Protected by Google Cloud IAP (Identity-Aware Proxy).

**Key responsibilities:**
- CRUD for users, staff, offices, teams, accounts, campaigns
- Access grant management (per-resource access to GUB-owned org data)
- Access request review workflow
- OAuth Agent Client management (`/settings/oauth-clients`)
- Trusted apps registry (`/settings/trusted-apps` — origins + Google client_ids that may obtain tokens)
- Staff metadata editor (skills, interests, certifications)
- Resourcing search interface
- Data Sources dashboard — sync configuration, run history, and run details

**Tech stack:** Next.js 14 (App Router, standalone output), Prisma,
Tailwind CSS, Zod v4.

## Shared Database

All three components share a single Cloud SQL PostgreSQL instance
(`gub-platform`). The backend connects via its own service account
with RLS policies. The admin CMS connects with `BYPASSRLS` (full
access, gated by IAP at the network layer).

## Data Model Summary

```
┌─────────────────────────────────────────────────────┐
│                   Auth Layer                         │
│  users ─── refresh_tokens                            │
│    │        oauth_auth_codes                         │
│    │        access_grants ── (per-resource org access) │
│    │        access_requests                          │
│    └── staff (org identity)                          │
│                                                     │
│  apps  (thin appId → friendly-name registry; not a gate) │
│  trusted_apps (origins + google_client_ids; trust  │
│                registry for /auth/google/exchange) │
│                                                     │
│                   Org Layer                          │
│  offices ── staff ── team_members ── teams           │
│              │                                      │
│              ├── staff_metadata                      │
│              ├── staff_changes (append-only + prev values) │
│              └── staff_external_ids                   │
│                                                     │
│                   Client Layer                       │
│  accounts ── campaigns                               │
│    │            │                                    │
│    │            └── campaign_changes (append-only)    │
│    └── account_changes (append-only)                 │
│                                                     │
│                   Sync Layer                         │
│  data_sources ── sync_runs                           │
│                                                     │
│                   Audit Layer                        │
│  audit_log (immutable, DB-trigger protected)         │
└─────────────────────────────────────────────────────┘
```

Key design patterns:
- **Append-only change logs** (EAV pattern) for accounts, campaigns,
  staff, offices, and teams. Current state = latest value per property.
- **Immutable audit log** protected by database triggers.
- **Soft revocation** for access grants (never hard-delete).
- **Identity resolution**: Users (auth) → Staff (org). Not all staff
  have platform accounts; not all users are staff.

## GCP Resources

| Resource | Name / ID | Notes |
|----------|-----------|-------|
| Project | `os-test-491819` | Project number: `843516467880` |
| Cloud SQL | `gub-platform` | PostgreSQL 14, us-central1 |
| Cloud Run (backend) | `gcp-universal-backend-dev` | 0-2 instances, 512Mi |
| Cloud Run (admin) | `gub-admin-dev` | 0-2 instances, 512Mi |
| Cloud Function | `oauth-relay` | us-central1, workaround for Discovery Engine bug |
| Vertex AI Agent Engine | `9136379226620952576` | Hosts the ADK agent |
| Agentspace App | `gub-agentspace-test_1775506197940` | Gemini Enterprise UI |
| Agent Registration | ID `4727522440043381131` | State: ENABLED |
| Authorization | `gub-oauth-3` | Google OAuth token injection |
| Artifact Registry | `gub-admin`, `gcp-universal-backend` | Docker images |
| Secret Manager | Multiple secrets | DB URLs, JWT keys, Google client ID |
| OAuth Client | `843516467880-crbjjtkp9ri8em139i03rf3gmgr95l8m` | Published to production |

## Network Flow

```
User (browser)
  │
  ▼
Agentspace UI (vertexaisearch.cloud.google.com)
  │
  ├──[OAuth]──▶ OAuth Relay (Cloud Function)
  │                │
  │                └──[302]──▶ accounts.google.com/o/oauth2/v2/auth
  │                              │
  │                              └──[redirect]──▶ vertexaisearch.cloud.google.com/oauth-redirect
  │
  ├──[Chat message]──▶ Vertex AI Agent Engine
  │                        │
  │                        ├── Injects Google OAuth access token into tool_context.state
  │                        │
  │                        └──[Tool call]──▶ gub-agent (Python)
  │                                            │
  │                                            ├── Exchange Google token → GUB JWT
  │                                            │   POST /auth/google/access-token-exchange
  │                                            │
  │                                            └── Authenticated API calls
  │                                                GET /org/staff, /org/accounts, etc.
  │                                                    │
  │                                                    ▼
  │                                              Cloud SQL (PostgreSQL)
  │
  └──[Response]──▶ User sees results
```
