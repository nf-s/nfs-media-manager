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
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/components/*.test.ts apps/web/components/*.test.tsx apps/web/hooks/*.test.ts apps/web/utils/*.test.ts
corepack pnpm --filter @repo/server test:integration
corepack pnpm --filter @repo/ui check:design
```

Integration tests create and drop uniquely named temporary databases on the configured PostgreSQL server. The test database role needs `CREATEDB`. Provider requests are mocked and outbound fetches are blocked. CI runs three integration shards concurrently, each with its own disposable PostgreSQL service. The `checks` job succeeds only after every integration shard and the unit tests and typechecks pass.

`check:design` runs the design-system checks, which the unit tests and typechecks job runs first. They read the source only, need no build and take under a second:

- **Style check** (`packages/ui/scripts/check-styles.mjs`, or `check:styles`). Outside the design system (`packages/ui/src/design-system`, `components/ds`, `components/ui`, `lib` and `docs/design-system`) it fails on a literal colour, font family, shadow or corner radius, and on a literal size equal to a `--ds-*` token of its kind: a type size in a font size, a space step in a margin, padding, gap or offset, a control, row or layout size in a width or height, a leading in a line height. It reads page stylesheets, CSS modules, inline `style={{…}}` objects, class names (Tailwind colour, radius, shadow, font and spacing classes) and colour strings in components. It also fails on a style file outside `packages/ui/src/design-system` and `packages/ui/src/styles`.
- **Table audit** (`packages/ui/scripts/audit-tables.mjs`, or `audit:tables`). It lists every table the app renders and fails on one that does not use the shared table: `<Table>` from `@repo/ui/components/ui/table`, or `<table className="ds-table">` with that file's `TableHead` and `TableCell`, as the Jobs table does. It also fails on a `<th>`, a `<td>` with content and a `role="table"` or `"grid"` element.

Findings that existed when the checks began are allowed by `packages/ui/scripts/style-baseline.json` and `table-baseline.json`, keyed by file and the offending code rather than by line. A check fails only on findings beyond its baseline. Do not add to a baseline to pass a check: use a token or a shared component, or take a new visual element through the approval process in [AGENTS.md](../AGENTS.md#interface). After fixing baselined code, shrink the baseline with `corepack pnpm --filter @repo/ui check:styles --update` or `audit:tables --update`, and check that the diff only removes entries. `check:styles --report` gives the counts by file.

Build the self-hosted Node application with `corepack pnpm build`. The web build writes `apps/web/.next`; stop the development web process before building in the same checkout, or use another checkout. Server runtime uses `corepack pnpm --filter @repo/server start`; the web uses `corepack pnpm --filter web start --port 3000`. See the [hosting notes](getting-started.md#hosting-beyond-your-computer) for origins, TLS and process limits.

Run the configured Prettier formatter on changed files as the final edit step. Do not commit environment files, database dumps, generated output, library data or local provider packages. Reproduce bugs, run relevant tests, review the diff and avoid unrelated refactors.

## Preview for interface checks

```sh
corepack pnpm --filter @repo/schemas build
corepack pnpm --filter @repo/media-plugin-sdk build
corepack pnpm preview
```

`corepack pnpm preview` starts the app on a disposable database filled with the synthetic preview library (`apps/server/scripts/preview/seed.ts`): albums, tracks, artists, films, playlists, scrobbles, subscriptions and jobs with saved provider results. It needs only the local PostgreSQL server from your settings and refuses any other host.

- It creates a database named `media_preview_run_<id>`, writes its own settings file outside the checkout and passes it to every preview process through `MEDIA_MANAGER_ENV_FILE`, which the workspace env loader uses in place of `.env` and `.env.local`. Those files are read only for the PostgreSQL connection and are never changed. Provider keys and plugins are not loaded.
- It runs the migrations, the initial account seed and the preview seed, then the API without the job worker (nothing a click queues is run) on `127.0.0.1:4710` and the web app on `127.0.0.1:3710`. Choose other ports with `-- --web-port <port> --api-port <port>`.
- Open the sign-in link it prints (`http://127.0.0.1:4710/preview/sign-in?next=/tracks`) to sign in as the generated preview account; the password is never shown.
- Ctrl+C stops both servers, drops the database and deletes the settings. A database left by a preview that was killed is dropped the next time the command starts, unless something is still connected to it.

The preview uses its own Next.js process in the checkout, so stop `corepack pnpm dev` in the same checkout first, or run the preview from a worktree.

## Browser tests

```sh
corepack pnpm --filter web test:browser
```

Playwright tests in `apps/web/e2e` run against the preview at desktop width and at phone width (375 × 812). A preview already running on the default ports is reused; otherwise the run starts one and removes it at the end. `tracks-browse.spec.ts` covers Tracks Browse and `metadata-selection.spec.ts` the track Metadata selection: a field filter through the shared search control, selecting rows, and a reload that keeps the filter from the URL. The tests use Playwright's Chromium; if it is missing, run `corepack pnpm --filter web exec playwright install chromium`. They are not part of CI yet.

## Provider development

Use the registry and [plugin SDK workflow](local-plugins.md). Validate untrusted inputs at the boundary. Route handlers validate/authenticate, call services and return results. Providers must use the shared request gate; no direct networking, hidden retries or broad automatic runs. The one exception is the [Sonos](sonos.md) Control API, whose calls a listener is waiting on: they use the gate module's `createDirectProviderRequest`, which keeps the provider's halt, cooldown and failure records but skips the durable reservation, pacing and request count. It refuses any provider with a request budget.

Use synthetic test fixtures. Keep live scraping to an explicitly reviewed small selection. The archived application and unused spatial/editor packages have been removed; legacy-data imports are supported by the current server and covered by its tests.
