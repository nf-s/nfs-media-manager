# Google Custom Search Retirement

Active Google Custom Search scraping is retired. `Google Custom Search (legacy)`
is the display name of the retained import-only catalog entry; its provider ID
remains `google-custom-search`. This is not a new provider namespace or a data
migration.

## Runtime Behavior

- The Google scraper implementation and builtin registration are removed.
  `getScrapePlugin('google-custom-search')` returns `null`, and loaded scraper
  lists exclude it.
- The catalog retains `supportsLegacyImport: true`, `supportsScrape: false`
  and `surface: 'import'`. Google is not offered in active Providers or scrape
  selections. It declares no credential fields, name lookup or connection test.
- Google environment credential fallbacks are removed. Existing environment
  files and encrypted credential rows are not changed or deleted. No replacement
  Google credentials are needed.
- New Google jobs are rejected with `Provider cannot be scraped`. When an
  existing queued Google job is claimed, the existing worker marks it failed
  with `No executable plugin is loaded for this provider.` before loading
  secrets, requesting HTTP or persisting provider results. Existing queue safety
  holds still apply; this change does not clear cooldowns, retry jobs or delete
  job history.

## Data Preservation

No database migration, cleanup command or row deletion is part of this change.
Snapshots, current state, imported browse ratings, references, rating/source
links, history and tag provenance retain their existing provider IDs and values.
`Google Custom Search (legacy)` is a catalog label only, not a stored-payload rewrite.

Snapshot and job history also explicitly render this readable legacy label,
including the job link's accessible name. These display-only labels do not
require a catalog request or alter event provider IDs, titles or payloads.

The legacy importer still translates `rymGoogle` and `metacriticGoogle`, retains
their payloads and source links, and persists them under `google-custom-search`.
Its genre translation and the provenance backfill's existing Google fallback
namespace remain unchanged. Removing the executable adapter does not remove the
import translator. Historical RYM and Metacritic ratings remain browseable;
retirement does not promise that those retained scores are current.

The archived scraper has been removed. The current importer preserves compatible
saved metadata without running the retired scraper or rewriting source JSON.

## Offline Verification

From the workspace root, run the focused mocked tests:

```sh
pnpm --filter @repo/server exec vitest run src/services/__tests__/google-search-retirement.test.ts src/plugins/__tests__/registry.test.ts src/plugins/builtin/__tests__/album-providers.test.ts src/lib/tag-provenance-backfill.test.ts scripts/__tests__/import-legacy.test.ts
```

The retirement suite uses an in-memory database double and forbids live HTTP.
It verifies catalog capabilities, missing scraper lookup, preserved Serply lookup,
unused Google environment fallbacks, unchanged legacy payload/link/tag
translation, rejection of new jobs and failure of pre-existing queued jobs.
It does not start a worker against the application database or inspect secrets.
