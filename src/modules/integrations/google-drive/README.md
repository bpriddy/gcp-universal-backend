# Google Drive Integration — Campaign State Extraction

## Purpose

Extract **sparse, high-level campaign/account state** from project folders
in Google Drive. This is NOT an ETL pipeline or a greedy crawler. The goal
is to capture a small number of structured facts — status changes, key dates,
budget updates — that belong in the central database.

Content that stays elsewhere:
- Deep project knowledge → NotebookLM
- Documents, decks, assets → Google Drive (referenced, not imported)
- Asset management → AEM (queried at request time, not synced)

## Auth Model (2026-04-16)

Drive sync is **service-account-only by design** and does NOT use the
`src/modules/workspace/` pass-through helpers (`resolveWorkspaceCreds`).

- Runs in a background worker — no HTTP user in the request
- The SA must be explicitly shared into each account/campaign folder
- The review flow (`drive.review.ts`) operates on already-extracted,
  already-stored proposals — no Drive API call at review time

Keys are read from `GOOGLE_DRIVE_SA_KEY_PATH` / `GOOGLE_DRIVE_SA_KEY_B64`
or fall back to `GOOGLE_DIRECTORY_SA_KEY_*` so a single SA can serve both
syncs in dev.

If a future endpoint needs per-user Drive access ("list files from MY
Drive"), that endpoint would use `resolveWorkspaceCreds` instead — see
[AUTH-FLOW.md § Path 4](../../../../docs/AUTH-FLOW.md#path-4-workspace-pass-through-client-owned-oauth).

## Design Principles

1. **Sparse output** — a sync run should produce a handful of
   `account_changes` / `campaign_changes` rows, not thousands.
2. **Convention-driven** — folder structure or a well-known file (e.g.
   a project status sheet) defines what to extract.
3. **Idempotent** — re-running the sync produces no duplicate changes
   if nothing actually changed.
4. **Append-only** — writes to the change log tables, never overwrites
   the campaign/account record directly.

## Planned Architecture

```
Google Drive API
  │
  ├── List project folders (by convention: shared drive or folder ID)
  │
  ├── For each folder:
  │   ├── Read a "project state" sheet or naming convention
  │   ├── Extract: status, key dates, budget, lead
  │   └── Map to account_changes / campaign_changes rows
  │
  └── Diff against last known state → write only actual changes
```

## What Needs to Be Defined

Before implementation, the following conventions must be established:

- [ ] Where do project folders live? (shared drive ID, parent folder ID)
- [ ] How is a folder mapped to an account/campaign? (naming convention,
      a metadata file, or a sheet with a known name)
- [ ] What fields are extracted? (status, dates, budget, lead — from where?)
- [ ] What triggers a state change? (file modified date? sheet cell value?)

## Files (Scaffold)

- `drive.client.ts` — Google Drive API client (list folders, read sheets)
- `drive.mapper.ts` — Convention-based extraction → structured change rows
- `drive.sync.ts` — Diff + write to account_changes / campaign_changes
- `drive.cron.ts` — Orchestrator
- `drive.router.ts` — POST /integrations/google-drive/cron
