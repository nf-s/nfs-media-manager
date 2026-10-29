# Development

Start with [getting started](getting-started.md) to configure PostgreSQL, secrets and the initial account. Read the [UI guidelines](dev-guidelines-ui.md) and [backend guidelines](dev-guidelines-backend.md) before changing code. Follow the closest existing implementation and shared utilities.

## Workspace

| Path                        | Role                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `apps/web`                  | Next.js App Router, TanStack Query and library UI.                         |
| `apps/server`               | Hono API, Drizzle/PostgreSQL, provider adapters and persistent job worker. |
| `packages/schemas`          | Zod request/response contracts and shared helpers.                         |
| `packages/media-plugin-sdk` | Local provider plugin contracts.                                           |
| `packages/ui`               | Shared components and styles.                                              |

`corepack pnpm dev` runs the apps and shared build watchers. To run a single app, use `corepack pnpm --filter web dev` or `corepack pnpm --filter @repo/server dev:server`. The root environment is loaded automatically. Restart after environment/plugin changes.

## Checks

```sh
corepack pnpm --filter @repo/schemas build
corepack pnpm --filter @repo/media-plugin-sdk build
corepack pnpm --filter @repo/server build:types
corepack pnpm --filter @repo/server typecheck
corepack pnpm --filter web typecheck
corepack pnpm --filter @repo/schemas test:unit
corepack pnpm --filter @repo/server test:unit
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/components/*.test.ts apps/web/components/*.test.tsx apps/web/utils/*.test.ts
corepack pnpm --filter @repo/server test:integration
```

Integration tests create/drop uniquely named temporary databases on the configured PostgreSQL server. The test database role needs `CREATEDB`. Provider requests are mocked and outbound fetches are blocked; these tests do not scrape or import your library. CI runs the checks with a disposable PostgreSQL service.

Build production output with `corepack pnpm build`. The web build writes `apps/web/.next`; stop the development web process before building in the same checkout, or use another checkout. Server runtime uses `corepack pnpm --filter @repo/server start`; the web uses `corepack pnpm --filter web start --port 3000`. See the [hosting notes](getting-started.md#hosting-beyond-your-computer) for origins, TLS and process limits.

Run the configured Prettier formatter on changed files as the final edit step. Do not commit environment files, database dumps, generated output, library data or local provider packages. Reproduce bugs, run relevant tests, review the diff and avoid unrelated refactors.

## Provider development

Use the registry and [plugin SDK workflow](local-plugins.md). Validate untrusted inputs at the boundary. Route handlers validate/authenticate, call services and return results. Providers must use the shared request gate; no direct networking, hidden retries or broad automatic runs.

Use synthetic test fixtures. Keep live scraping to an explicitly reviewed small selection. The archived application and unused spatial/editor packages have been removed; legacy-data imports are supported by the current server and covered by its tests.
