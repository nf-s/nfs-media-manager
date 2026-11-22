# Working on Media Manager

Read what the task needs:

- Data model, or a feature that adds to it: [application architecture](docs/handoff.md).
- Interface: the [design system](docs/design-system/README.md) and [UI guidelines](docs/dev-guidelines-ui.md).
- Providers, scraping and jobs: [album providers](docs/album-providers.md), [job worker](docs/job-worker.md) and [local provider plugins](docs/local-plugins.md).
- Browse queries and speed: [query performance](docs/query-performance.md).
- Commands, tests and checks: [development](docs/development.md).
- Releases and production: [production operations](docs/production-operations.md).
- Anything else: the [documentation index](docs/README.md).

Find the closest working example and search for existing helpers and shared types before writing code. Follow the surrounding structure and naming; extend a utility rather than creating a parallel version.

Production is released by CI: a push to `main` deploys that commit once its checks pass, as described in [production operations](docs/production-operations.md). Do not deploy by hand or to any other destination unless asked.

Keep installation-specific notes and records out of this repository. Do not publish library contents, measured library counts, deployment records, personal identifiers or real-library screenshots. Use synthetic examples instead.

## Implementation

- Validate external input at the boundary with the project's schemas. Keep route handlers thin: authorize, validate, call a service, return.
- No type assertions, non-null assertions, TypeScript ignores or expected-error directives, lint suppressions, or weakening types to make code compile. Fix the types or the logic.
- Use concise, functional interface copy. Preserve user-supplied wording. No slogans, decorative headings, taglines, filler or cute empty states. Add explanatory text only when it helps someone act or understand a real limitation. Follow the [UI guidelines](docs/dev-guidelines-ui.md).
- Keep library interfaces consistent. Every primary Browse page, including Artists, must use the shared Tracks Browse pattern: Grid/List/Table views, sorting, full autocomplete search with field filters and AI search, filter modes, ranges and URL state. Metadata selection must use that same search control and filter semantics alongside provider freshness filters. Do not substitute a plain text search or secondary table for a primary Browse page. Reuse shared controls and verify parity before finishing.
- Stay within scope. Do not silently refactor unrelated code, leave debug logging or keep commented-out implementations.
- Providers and jobs: store the raw response. Recurring work is a job. Confirm with one item before a bulk run.
- Speed: measure the time to the first visible rows in the signed-in app on production, before and after the change. Database timings alone do not count.

## Interface

The [design system](docs/design-system/README.md) is the only source of interface design. Read it before any interface work, and open its pages in a browser to see each component and screen.

- Build screens from the shared components in `packages/ui/src/components/ds` and `packages/ui/src/components/ui`. Style only with the `--ds-*` tokens in `packages/ui/src/design-system/tokens.css`. No literal colours, sizes, radii, shadows or fonts, no component styles written for one page, and no second style of table, card, list row, pill, tab, status or chart.
- The stylesheets in `packages/ui/src/styles` hold page layout only. Formats for dates, times, counts and durations come from `packages/ui/src/lib/format.ts`.
- Putting existing components together into a new screen needs no approval. A new visual element, a variant with its own look, or a change to how an existing component looks does. When the work needs one, stop that part of the work and:
  1. Draw two or three concepts as static pages copied from `docs/design-system/concept-template.html`, built from the existing tokens and components, with invented data.
  2. Show them to the owner with the trade-off of each and a recommendation, and wait for the owner to accept one. Do not choose for the owner and do not ship a temporary version in the meantime.
  3. Add the accepted concept to the design system: tokens if it needs them, its styles in `components.css`, its React component, and its section with rules on the components page. Delete the concept pages.
  4. Continue the feature using the new component.
- Before building a new list, table or Browse page, name the shared components it will use.
- Before rebuilding or moving a screen, list the old screen's controls and links. Check each one in a browser afterwards.
- Check interface changes in a browser at desktop and phone widths against the design library page for that screen, on a disposable database with synthetic data.

## Done and reporting

- A change is done when the changed action has been checked in the flow where it is used. Where it depends on real devices, a signed-in session or data volume, check on production, or report that it was not checked.
- Say "all" or "every" only after running the check across the full list.
- When one provider, table or query has a fault, check the others for the same fault before reporting.
- Do not leave jobs you started queued or paused.

## Workflow

- Reproduce bugs first. For a scraping failure, start with the specific job's saved request, response, error and snapshot, not a new search. A fault that was not reproduced gets no fix: report what is known and ask. A retry or re-send is not a fix. Make one small change and verify it; if it fails, return your own change to a known working state instead of stacking speculative fixes.
- Keep tests green. Use fixtures, mocked providers and a disposable database. Do not run live or full-library scrapes as tests. If a live check is explicitly requested, review the queue, select a tiny explicit subset, and preserve rate limits, cooldowns and concurrency controls.
- Use the project's existing dotenv loading. Do not overwrite local configuration, export the environment in shell scripts or print keys or other environment values. Never publish private plugin names, aliases, credentials, scraped payloads, backups or machine-specific paths.
- In a new Git worktree, run `corepack pnpm worktree:setup` before anything else. Never give a worktree its own `.env.local`. See [worktrees](docs/development.md#worktrees).
- Check Git status before editing or pushing. Keep pre-existing work intact. Review every changed line and its effect on callers and docs. Run relevant tests, use the configured formatter, verify the final diff, then commit and push completed changes unless asked not to. Preserve configured commit signing. Do not stage unrelated work.
- Finished work goes to `main`, and that push is the release. Keep prototypes and unfinished work on a branch. The release does not run database migrations: run any migration the change depends on first. Releases publish one at a time, each commit that passed its checks in turn, so later pushes do not hold yours back; a run ends without publishing only when a newer commit is already live. After pushing, wait for the run and confirm that your commit or a newer one is live; a failed check publishes nothing, so fix it or say the change is not live. The release tests signed-out pages only, so check the changed flow in the app yourself.
