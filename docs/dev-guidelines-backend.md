# Backend Guidelines

## Stack

- `apps/server` is the only backend application.
- Use `Hono` routes under [`apps/server/src/routes`](../apps/server/src/routes).
- Use `Drizzle` with Postgres schema definitions under [`apps/server/src/schemas`](../apps/server/src/schemas).
- Shared request and response contracts live in [`packages/schemas/src`](../packages/schemas/src).

## Route Pattern

- Keep handlers thin.
- Validate route params, query, and body with shared Zod schemas.
- Require auth with [`apps/server/src/middlewares/auth.ts`](../apps/server/src/middlewares/auth.ts) for private admin routes.
- Return JSON through [`apps/server/src/lib/response.ts`](../apps/server/src/lib/response.ts).
- Throw `ServerError` for domain failures. Do not leak raw DB or plugin errors to clients.
- Authenticated job logs retain exception messages, stacks and causes after server-side credential redaction through `lib/job-errors.ts`. Keep general API error responses sanitized; never return credentials or unfiltered request headers.

## Service Pattern

- Put business logic in `src/services`.
- Keep provider normalization and legacy import logic at the boundary. Convert raw JSON and plugin payloads into internal records before storing them.
- Reuse [`apps/server/src/services/provider-state.ts`](../apps/server/src/services/provider-state.ts) to persist provider history and current state.
- Reuse the plugin registry in [`apps/server/src/plugins/registry.ts`](../apps/server/src/plugins/registry.ts) instead of hardcoding external providers.

## Database

- Generate migrations from the intended Drizzle schema. With a running watch server, stage column-dependent schema/code outside watched source until the migration is verified and applied. Back up and quiesce incompatible writers for the schema/application cutover; never expose new-column consumers to an old database.
- Keep canonical media rows in `media_item`, `album`, and `film`.
- Store provider payloads in `provider_snapshot` and `provider_current_state`.
- Store manual edits in `media_override` and `provider_reference_override`.
- Store secrets only in `provider_secret`, encrypted with `MEDIA_ENCRYPTION_KEY`.

## Safety

- Scrape jobs must stay conservative by default.
- Do not add code paths that trigger broad scrape runs without explicit confirmation.
- Keep private-source integrations out of the OSS repo. Use local plugins through `MEDIA_PLUGIN_PATHS`.
