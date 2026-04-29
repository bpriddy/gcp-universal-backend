# Changelog

All notable changes to this repository are tracked here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Security entries
describe what controls were added; operational detail that could narrow
an attacker's search space (which values lived where, timing of rotations,
remaining exposures) lives in internal notes instead of this public log.

## [Unreleased]

### Drive sync (2026-04-29)

- Replaced full-folder-scan trigger with **incremental polling** via
  Drive's `changes.list` API. New `POST /integrations/google-drive/poll`
  endpoint is the Cloud Scheduler target; only kicks off a full sync
  when there are in-scope changes. Cadence is admin-configurable from
  gub-admin (writes the cron expression onto a Cloud Scheduler job;
  reads live state from the job on render).
- New singleton `drive_sync_state` table holding the page token,
  last-polled timestamp, and last-poll outcome. `/run-full-sync`
  augmented to capture and persist a fresh start page token at end of
  successful run, so bootstrap and post-token-expiry recovery share one
  path.
- **Chunking** for the bootstrap path: 50-min wall-clock budget per
  chunk, persisted checkpoints on `sync_runs` (`chunk_phase` /
  `chunk_index`), HTTP self-call to `/run-full-sync/continue` to resume
  in a fresh Cloud Run request. Sized for this org's actual scale
  (per-project ceiling ~100 files; pathological multi-project batch
  ~1k files).
- **Stale-sync reaper** runs at request entry of `/poll`,
  `/run-full-sync`, `/run-full-sync/continue`. Detects rows stuck in
  `running` (>24h since `updated_at`) or `paused` (>60min since
  `updated_at`) — typically caused by Cloud Run instance death between
  checkpoint persist and self-call dispatch — and force-fails them so
  subsequent syncs aren't blocked by the concurrency guard. New
  `sync_runs.updated_at` heartbeat column powers the detection (DB
  trigger + Prisma `@updatedAt`).
- README and `docs/DATA-SYNC.md` updated with full operational details
  (bootstrap, token expiry, chunking math, reaper thresholds).

### Security (2026-04-23)

- Added a `gitleaks` pre-commit hook (`.githooks/pre-commit`) that scans
  staged changes before every commit and rejects the commit on any
  finding. One-time setup per clone is documented in the README
  ("Local setup").
- Tightened `.gitignore` coverage to block additional secret-file shapes
  from slipping through (additional `.env.*` variants, typical key/cert
  file extensions).
- Refreshed `.env.example` so it enumerates every configuration key the
  backend reads today — new devs have a single authoritative reference
  and no reason to copy from a colleague's local file.
- Added `BACKLOG.md` to track infrastructure follow-ups queued for the
  next relevant deploy.
