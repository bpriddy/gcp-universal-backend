# Production Checklist

> This POC demonstrates end-to-end functionality. The items below outline
> what a vendor with infrastructure, security, and backend expertise
> should address to bring this to production.

## Security

- [ ] **Rotate all secrets.** Database passwords, JWT keys, OAuth client
      secret, and any other credentials set during POC must be rotated.
- [ ] **Review IAM bindings.** Audit all `roles/` grants. Remove any
      overly permissive bindings added during development (e.g., editor
      roles on service accounts).
- [ ] **Enable VPC Service Controls.** Restrict Cloud SQL, Cloud Run,
      and Secret Manager to a VPC perimeter.
- [ ] **Implement Cloud IAP for admin CMS.** Requires Serverless NEG +
      HTTPS Load Balancer. The admin CMS has BYPASSRLS database access
      and must be strictly access-controlled.
- [ ] **Complete Google OAuth app verification.** Required for external
      users. Currently published but unverified.
- [ ] **Add non-root user to gub-admin Dockerfile.** Match the pattern
      in the backend Dockerfile (`nodeuser`, uid 1001).
- [ ] **Review CORS allowed origins.** Update from dev values to
      production domains.
- [ ] **Review rate limiting.** Current limits (10 auth/15min, 100
      general/15min) may need tuning based on expected traffic.
- [ ] **Enable Cloud Armor.** WAF rules on the load balancer for DDoS
      and bot protection.
- [ ] **Review JWT TTL.** 15-minute access tokens are reasonable; 30-day
      refresh tokens may be too long for sensitive environments.
- [ ] **Audit logging.** Ensure Cloud Audit Logs are enabled for all
      services. The application-level audit_log table is already
      append-only and trigger-protected.

## Infrastructure

- [ ] **Terraform or Pulumi.** Convert all `gcloud` commands in
      DEPLOYMENT.md to infrastructure-as-code. Key resources:
  - Cloud SQL instance + databases + users
  - Cloud Run services + IAM bindings
  - Cloud Functions (oauth-relay)
  - Secret Manager secrets
  - Artifact Registry repositories
  - Cloud Build triggers
  - IAM service accounts + role bindings
  - VPC + connectors (if adding VPC)
  - Load balancer + SSL + IAP (for admin CMS)
- [ ] **Environment promotion.** Set up staging and production
      environments. Cloud Build configs already exist for dev/staging/prod
      but only dev has been tested.
- [ ] **Database backups.** Configure automated backups and point-in-time
      recovery on Cloud SQL.
- [ ] **Cloud SQL HA.** Enable high availability for production.
- [ ] **Connection pooling.** Consider PgBouncer or AlloyDB for
      production-scale connection management.
- [ ] **Custom domain.** Map a custom domain to Cloud Run services with
      managed SSL certificates.
- [ ] **Monitoring and alerting.** Set up Cloud Monitoring dashboards and
      alerts for: error rates, latency percentiles, Cloud SQL CPU/memory,
      Cloud Run instance count, failed auth attempts.
- [ ] **Uptime checks.** Configure Cloud Monitoring uptime checks against
      the `/health` endpoint.

## Code Quality

- [ ] **Remove debug logging from gub-agent.** The `_client.py` file has
      `logger.warning()` calls dumping state contents. Reduce to
      `logger.debug()` or remove entirely.
- [ ] **Add test suites.** The backend has vitest configured but test
      coverage is minimal. The agent and admin CMS have no tests.
- [ ] **Lint and format.** Run `eslint` on TypeScript repos and `ruff`
      on the Python agent.
- [ ] **Update gub-admin README.** Currently has the default
      create-next-app boilerplate.
- [ ] **Sync .env.example files** with current actual defaults.

## OAuth / Agentspace

- [ ] **Monitor Discovery Engine param stripping bug.** If Google fixes
      the bug where OAuth query params are stripped from
      `accounts.google.com` URLs, remove the OAuth relay Cloud Function
      and point the authorization directly to Google.
- [ ] **Monitor ADK State.get() prefix bug.** If fixed, simplify the
      token resolution in `_client.py` to use `State.get()` directly
      instead of `to_dict()`.
- [ ] **Switch to v1 API.** When Discovery Engine promotes authorization
      and agent registration to GA, switch from `v1alpha` to `v1`.
- [ ] **Consider service account auth for agent.** Instead of per-user
      OAuth, evaluate whether the agent should authenticate as a service
      account with elevated access, depending on the trust model.

## Data Sync

- [ ] **Re-enable immutability triggers.** Triggers on change log tables
      were disabled during POC. Re-enable via migration before production.
- [ ] **Schedule sync cron jobs.** Currently syncs are triggered manually
      or via API. Wire up Cloud Scheduler or similar for automated runs.
- [ ] **Add Workfront sync engine.** Requires `WORKFRONT_BASE_URL` and
      `WORKFRONT_API_TOKEN` environment variables.
- [x] **Google Drive sync engine** — incremental polling via Drive's
      `changes.list` API; LLM extraction pipeline + reviewer magic-link
      flow. Cadence is admin-configurable from gub-admin (Cloud
      Scheduler job updated via API). See `DATA-SYNC.md` "Google Drive
      Sync".
- [ ] **Add staff metadata import.** CSV/spreadsheet bulk import for
      skills, interests, certifications, and other metadata.
- [ ] **Sync error alerting.** Set up alerts when sync runs fail or
      error counts exceed thresholds.

## Database

- [ ] **Review RLS policies.** The backend uses `set_config` +
      AsyncLocalStorage for RLS. Verify policies are correctly scoped.
- [ ] **Migrate change log triggers.** The append-only triggers on
      `account_changes`, `staff_changes`, and `audit_log` prevent
      UPDATE/DELETE. Ensure migration scripts account for this.
- [ ] **Data retention policy.** Append-only tables will grow
      indefinitely. Define a retention/archival policy for change logs
      and audit entries.
- [ ] **Index review.** Profile queries under realistic load and add
      indexes as needed. Current indexes cover the primary access
      patterns but may need expansion.

## Operational

- [ ] **Runbook.** Create operational runbooks for: deploying new
      versions, rotating secrets, handling incident response, scaling
      up/down, database maintenance.
- [ ] **Disaster recovery.** Document RTO/RPO requirements and test
      restore procedures from Cloud SQL backups.
- [ ] **Cost optimization.** Review Cloud Run min/max instances, Cloud
      SQL tier, and other resource sizing for production traffic.
- [ ] **CI/CD pipeline review.** The production Cloud Build pipeline
      deploys with `--no-traffic` requiring manual promotion. Verify
      this matches the desired release process.
