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
