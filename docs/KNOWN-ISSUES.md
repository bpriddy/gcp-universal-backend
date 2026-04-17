# Known Issues & Workarounds

> Documented during the POC buildout. A vendor taking this to production
> should address each item.

## Platform Bugs

### 1. Discovery Engine Strips Query Params from Google OAuth URLs

**Problem:** When Agentspace redirects users to Google's OAuth endpoint
(`accounts.google.com/o/oauth2/v2/auth`), Discovery Engine strips
query parameters like `response_type=code`. This breaks the OAuth flow
entirely.

**Workaround:** An OAuth relay Cloud Function receives the request and
302-redirects to Google's endpoint with the full query string preserved.

- Relay URL: `https://us-central1-os-test-491819.cloudfunctions.net/oauth-relay`
- Code: `gub-agent/deployment/oauth-relay/main.py`
- The authorization resource in Discovery Engine uses the relay URL
  as the `authorizationUrl` instead of Google's directly.

**Production fix:** Monitor whether Google fixes this in Discovery
Engine. If fixed, update the authorization resource to point directly
to `https://accounts.google.com/o/oauth2/v2/auth` and decommission
the relay.

### 2. ADK State.get() Prepends Prefixes to Keys

**Problem:** `tool_context.state.get("some_key")` prepends internal
prefixes (`app:`, `temp:`) to the key before lookup. The OAuth token
injected by Agentspace is stored under the raw key (no prefix), so
`State.get()` silently returns `None`.

**Workaround:** Use `tool_context.state.to_dict()` to get the raw
state dictionary, then access keys directly:

```python
state_dict = tool_context.state.to_dict()
token = state_dict.get("gub-oauth-3")  # raw key, no prefix
```

**Location:** `gub-agent/gub_agent/tools/_client.py`

**Production fix:** If Google updates ADK to fix this behavior, the
`to_dict()` workaround can be simplified back to `State.get()`.

### 3. Discovery Engine Requires v1alpha for Authorization/Agent Management

**Problem:** The `v1` endpoint returns 404 for authorization and agent
registration operations. Only `v1alpha` works.

**Workaround:** All API calls in `register_agent.py` and manual curl
commands use `v1alpha`.

**Production fix:** Watch for GA promotion of these APIs and switch to
stable endpoints when available.

### 4. widgetStoreUserAuthorization 500 Errors

**Problem:** During initial OAuth setup, the Agentspace client-side
call to `widgetStoreUserAuthorization` returned 500 errors. Root cause
was a combination of: OAuth app in "Testing" mode, and possibly
corrupted state from repeated authorization resource patches.

**Resolution steps that worked:**
1. Publish the OAuth app to production (not testing) in Google Cloud Console
2. Create a fresh authorization resource with a new ID (`gub-oauth-3`
   instead of repatching `gub-oauth-2`)
3. Remove and re-add the Agentspace connection to force a clean OAuth flow

---

## Code Cleanup Items

### 5. Debug Logging in _client.py

The `_resolve_gub_jwt()` function in `gub-agent/gub_agent/tools/_client.py`
contains `logger.warning()` calls that dump state contents for debugging.
These should be reduced to `logger.debug()` or removed before production.

Lines to clean up:
```python
logger.warning("DEBUG tool_context.state to_dict(): %s", ...)
logger.warning("DEBUG APP_PREFIX=%s TEMP_PREFIX=%s", ...)
logger.warning("Found OAuth token via to_dict()['%s']", ...)
```

### 6. .env.example Defaults Out of Sync

The `.env.example` in `gub-agent` has defaults for the original local
dev setup (`GUB_BASE_URL=http://localhost:3000`, `GEMINI_MODEL=gemini-2.0-flash`).
The deployed defaults in `config.py` are different (Cloud Run URL,
`gemini-2.5-flash`). The `.env.example` should be updated to document
both local and deployed defaults.

---

## Infrastructure Items

### 7. Cloud SQL Password

The PostgreSQL password was set to an insecure value during the POC for
expedience. It must be rotated to a strong password before any
non-development use. Update the password in:
- Cloud SQL user settings
- Secret Manager secrets (`dev-database-url`, `gub-admin-db-url-dev`)

### 8. IAP for Admin CMS

The admin CMS is deployed with `--no-allow-unauthenticated` (IAM-gated)
but does not have full Cloud IAP. Proper IAP requires:
- A Serverless NEG (Network Endpoint Group)
- An HTTPS Load Balancer with managed SSL certificate
- IAP enabled on the backend service

For the POC, access is managed via IAM `roles/run.invoker` grants.

### 9. OAuth App Verification

The Google OAuth app is published to production but has not completed
Google's verification process. For a production deployment with
external users, the app should go through Google's OAuth verification.

### 10. Cloud Run Container Runs as Root (gub-admin)

The `gub-admin` Dockerfile does not create a non-root user. The
`gcp-universal-backend` Dockerfile does (`nodeuser`, uid 1001). The
admin CMS Dockerfile should be updated to match.

---

## Operational Notes

### 11. Append-Only Triggers Disabled

The immutability triggers on change log tables and audit_log were
**disabled via migration** (`20240126000000_disable_append_only_triggers`)
during the POC to simplify development. The trigger functions still exist
in the database. A startup check (`trigger-check.ts`) logs warnings if
expected triggers are missing.

**Production action:** Re-enable immutability triggers on:
- `account_changes`, `campaign_changes`, `office_changes`,
  `team_changes`, `staff_changes`
- `audit_log` (both update and delete triggers)
- `users` and `staff` (no-delete triggers)

### 12. UUID Validation

Zod v4 (used in gub-admin) enforces strict RFC 4122 UUID validation.
UUIDs must have the correct version nibble (char 13) and variant bits
(char 17). Using `gen_random_uuid()` in PostgreSQL guarantees valid
UUIDs. Hand-crafted UUIDs like `c0000000-0000-0000-0000-000000000003`
will fail validation.

### 13. Next.js Static Generation vs. Dynamic

Pages in gub-admin that make Prisma calls must include:
```typescript
export const dynamic = 'force-dynamic';
```
Without this, Next.js attempts to statically generate the page at build
time, which fails because there is no database connection during builds.
Pages that needed this fix: `/accounts/new`, `/campaigns/new`,
`/api/staff-metadata/options`.
