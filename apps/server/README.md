# API Server

Hono routes live in `src/routes`, business logic in `src/services`, and Drizzle tables/migrations in `src/schemas/db.ts` and `drizzle/`. Shared Zod contracts live in `packages/schemas`; provider contracts live in `packages/media-plugin-sdk`.

Run `pnpm --filter @repo/server dev:server` from the workspace root. Configuration is loaded from the root environment through dotenv. See the [root README](../../README.md) for database setup, imports and tests, and [backend guidelines](../../docs/dev-guidelines-backend.md) before changing code.

Do not run the legacy scraper as part of a test. Previews and file parsing are local operations. Confirmed film imports can enqueue the explicitly selected metadata providers; an empty provider selection is offline. Live scraping runs only through authenticated jobs and the persistent request gate.

Film previews are owner-bound, expiring staging rows, claimed once on import. `SCAN_DIR` is server-only. Provider freshness uses `lastScrapedAt`, not the general update timestamp. Jobs list responses are paginated (`items`, `totalCount`, `page`, `size`, `pageCount`) with query, status and batch filters; `/activity` is a lightweight header counter. Provider manifests declare `identifierTypes` so jobs without usable IDs are rejected before execution.

Each scrape job targets exactly one explicit film or album. Bulk selection creates independent jobs with a shared batch ID for navigation. Concurrency is per provider across these jobs; it is not an item pool inside a job. Providers that opt into concurrent requests use their declared `maxConcurrent`, while other providers remain serial independently of each other. The persistent request gate still enforces spacing, budgets, cooldowns and access halts. Historical grouped jobs can be repaired offline with `scripts/split-job-history.ts`; see [the repair guide](../../docs/job-history-split.md).
