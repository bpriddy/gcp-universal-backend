# Backlog

Short-list of non-urgent follow-ups that shouldn't get lost. Each item should
either be picked up when its gate opens or explicitly closed out.

## Security — Secret Manager migration (queued — piggyback on next deploy)

Four credentials currently in local `.env` that should move to GCP Secret
Manager the next time a Cloud Run deploy touches them. No separate project;
mirror the existing `--set-secrets` pattern in `cloudbuild/dev.yaml`.

Status: already migrated → `DATABASE_URL`, `APP_DB_CONNECTIONS`,
`GOOGLE_CLIENT_ID`, `JWT_PRIVATE_KEY_B64`, `JWT_PUBLIC_KEY_B64`,
`GOOGLE_DIRECTORY_SA_KEY_B64`, `GEMINI_API_KEY`.

Still pending:

| Secret | Where it's read | Pending reason |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | OAuth broker (Agentspace / ADK) | Broker is mid-integration — rotate + migrate together when the broker flow stabilizes |
| `GOOGLE_DRIVE_SA_KEY_B64` | Drive sync SA | Awaiting IT approval of the Drive SA key; migration lands alongside |
| `DRIVE_ROOT_FOLDER_ID` | Drive sync discovery | Non-secret but gated on the above |
| `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAIL_FROM_*` | Mail module | Not wired yet (console driver in dev) — migrate when switching to `MAIL_DRIVER=mailgun` |

## Security — Credential rotation (deferred, not scheduled)

Exposure surface confirmed as a single laptop under `.gitignore`; rotation is
hygiene, not urgency. Revisit if the surface expands (shared dev machines,
new contractors, backup-to-cloud).

Candidates (when/if we rotate):
- OAuth client secret → Console reset + update `dev-google-client-id` secret +
  redeploy services using the broker
- Gemini API key → Console delete/create + `gcloud secrets versions add
  dev-gemini-api-key` + redeploy
- Directory SA key → Create new key, verify consumers, delete old
- GUB JWT signing key → Rotate key pair + bump `JWT_KEY_ID`; old JWTs die
  naturally within their 15-min TTL for access tokens; refresh tokens keyed
  off `refresh_tokens` table so rotation requires no migration

## Admin auth for sync triggers

`/integrations/google-drive/run-full-sync`, `/cron`, `/notify`,
`/sweep-expired`, and `/integrations/google-directory/cron` are currently
unauthenticated (match the pre-existing google-directory/cron pattern so the
gub-admin proxy can reach them without a token). Real fix: require a
Google-signed ID token from a whitelisted caller SA, verify against Google
JWKS. Needs a new `authenticateInternal` middleware + an
`INTERNAL_SA_EMAILS` allowlist env var. Bundle with the next admin-endpoints
pass.

## Observability / live-log on run detail

Currently `/data-sources/[key]/runs/[id]` polls every 10s while a run is
`running`. Future: server-sent events or WebSocket that streams log lines
live, so an operator can watch a Directory or Drive sync's batches as they
complete rather than wait for the next poll.

## Cloud Build triggers (post prod-project stand-up)

Today all three triggers watch `main` in dev. When the prod GCP project
exists:
- Rename `main` trigger patterns to `dev` for dev-project deploys
- Add new triggers on `main` branch → prod project
- Update `cloudbuild/*.yaml` substitutions per env
