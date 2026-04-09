# AEM Integration — Pass-Through Asset Queries

> **STATUS: SPECULATIVE** — This integration may not become part of the
> production architecture. It is scaffolded as a placeholder in case AEM
> is adopted for asset management. Do not invest significant effort here
> until the decision is confirmed.

## Purpose

When a client requests data about a campaign or project, the response
should include relevant assets if they exist in AEM. GUB does **not**
sync or replicate AEM data. Instead:

1. Each campaign stores an AEM collection reference (collection ID or URL)
2. At request time, GUB queries AEM's API and merges the results into
   the campaign response

## Design

```
Client → GET /org/campaigns/:id?include=assets
                                      │
                                      ▼
                              GUB Backend
                              ├── Fetch campaign from DB
                              ├── If campaign has aemCollectionId:
                              │   └── Query AEM API for collection assets
                              └── Return merged response
```

## What's Needed

- [ ] AEM instance URL and auth credentials
- [ ] A field on the `campaigns` table for the AEM collection reference
      (could use the existing `assetsUrl` field, or add `aemCollectionId`)
- [ ] AEM API endpoint for listing collection assets
- [ ] Response shape mapping (what fields to include in the merged response)

## Files (Scaffold)

- `aem.client.ts` — AEM API client (query collection assets)
- `aem.enricher.ts` — Response enrichment layer for org service
