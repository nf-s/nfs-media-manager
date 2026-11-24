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

## Worktrees

Set a new Git worktree up from inside it:

```sh
corepack pnpm worktree:setup
```

It needs Node 22 or later and is safe to run again. It:

1. Finds the main checkout through `git rev-parse --git-common-dir` and refuses to run in the main checkout itself.
2. Links the main checkout's ignored working files into the worktree, so there is one shared copy of each: `.cloudflare`, `.local-plugins`, `.neon` and `.claude/launch.json` (the list is `sharedPaths` in the script). It skips a path the main checkout does not have and never replaces a file or folder the worktree already has. It then checks that Git ignores each link: an ignore pattern ending in `/` matches a folder but not a link to one. Data, backups, legacy inputs, `.playwright-mcp` and per-chat or per-worker state are not linked.
3. Installs dependencies from the shared pnpm store (`pnpm install --frozen-lockfile --prefer-offline`).
4. Builds `@repo/schemas`, `@repo/media-plugin-sdk` and the `@repo/server` types, which the typechecks need.
5. Makes the main checkout's `.env` and `.env.local` visible to the workspace env loader. A worktree under `.claude/worktrees/` needs nothing, because the loader walks up to the main checkout. Elsewhere, such as Codex worktrees, the command links each file to the main checkout's, so they cannot drift. It never writes an env file of its own and never prints a setting. `packages/local-worker/.env` is not linked, so a worktree cannot start the local worker against the real library by accident.
6. Checks that the local PostgreSQL server named in the settings answers. If it does not, the command says how to start it, for example the `docker start` command for the container that publishes the port. It never starts or changes a container or database itself.
7. Prints what it did and what is still missing, and exits non-zero if the worktree is not ready.

A worktree must not get its own `.env.local`. The loader finds it first, and it replaces the main checkout's file instead of merging with it. Because it is loaded with override, a test suite or migration then reaches whatever database it names, or fails to find one. For a separate database, use `corepack pnpm preview`, which passes its own settings file through `MEDIA_MANAGER_ENV_FILE` and writes nothing in the checkout. The set-up command reports a worktree `.env.local` as missing work and does not remove it. Where it has linked `.env.local`, a tool that writes to that path writes to the main checkout's file.

In a new Claude Code session, the committed `.claude/settings.json` adds a note to the session when `apps/server/node_modules` is missing, so the agent runs the command first. `.worktreeinclude` is not used because it copies files. A `WorktreeCreate` hook is not used because it replaces how Claude Code creates worktrees. Codex has no committed hook for this, so run the command by hand there.

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
- It runs the migrations, the initial account seed and the preview seed, then the API without the job worker (nothing a click queues is run) and the web app on `127.0.0.1`. Each checkout and worktree gets its own pair of ports, derived from its path (`apps/server/scripts/preview/preview-ports.ts`): the web app on 3710–3809 and the API on 4710–4809, the same offset for both. The command prints them at start. Set `PREVIEW_WEB_PORT` and `PREVIEW_API_PORT` to choose others.
- Every preview step checks first that its settings name a `media_preview_run_<id>` database on a local server, so it cannot migrate or seed the development database.
- Open the sign-in link it prints (`http://127.0.0.1:<API port>/preview/sign-in?next=/tracks`) to sign in as the generated preview account; the password is never shown.
- Ctrl+C stops both servers, drops the database and deletes the settings. A database left by a preview that was killed is dropped the next time the command starts, unless something is still connected to it.

The preview uses its own Next.js process in the checkout, so stop `corepack pnpm dev` in the same checkout first, or run the preview from a worktree.

## Replaying catalog discoveries

Run `corepack pnpm --filter @repo/server backfill:music-catalog --dry-run` to inspect recoverable music observations. Use `--apply` for a confirmed replay. For film and subscription evidence, run `corepack pnpm --filter @repo/server exec tsx scripts/backfill-nonmusic-catalog.ts --family responses --limit 1`. This dry run rolls the projection back. Add `--apply` to keep the batch and pass its returned cursor to `--after` for the next one. Other supported families are `film-snapshots`, `subscription-sources`, `subscription-items` and `shorts`.

Both commands read retained inputs. A missing or truncated provider response limits what the replay can recover. A repeated occurrence retains its catalog identity and evidence. Inspect a small batch on a disposable database before selecting a production batch.

## Browser tests

```sh
corepack pnpm --filter web test:browser
```

Playwright tests in `apps/web/e2e` run against the preview at desktop width and at phone width (375 × 812). A preview already running on the checkout's default ports is reused; otherwise the run starts one and removes it at the end. `tracks-browse.spec.ts` covers Tracks Browse and `metadata-selection.spec.ts` the track Metadata selection: a field filter through the shared search control, selecting rows, and a reload that keeps the filter from the URL. The tests use Playwright's Chromium; if it is missing, run `corepack pnpm --filter web exec playwright install chromium`. They are not part of CI yet.

## Provider development

Use the registry and [plugin SDK workflow](local-plugins.md). Validate untrusted inputs at the boundary. Route handlers validate/authenticate, call services and return results. Providers must use the shared request gate; no direct networking, hidden retries or broad automatic runs. The one exception is the [Sonos](sonos.md) Control API, whose calls a listener is waiting on: they use the gate module's `createDirectProviderRequest`, which keeps the provider's halt, cooldown and failure records but skips the durable reservation, pacing and request count. It refuses any provider with a request budget.

Use synthetic test fixtures. Keep live scraping to an explicitly reviewed small selection. The archived application and unused spatial/editor packages have been removed; legacy-data imports are supported by the current server and covered by its tests.
