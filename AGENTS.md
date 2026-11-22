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

Create new projects as local Git repositories; do not use Sites. Production is released by CI: a push to `main` deploys that commit once its checks pass, as described in [production operations](docs/production-operations.md). Do not deploy by hand or to any other destination unless asked.

Keep installation-specific Markdown in ignored `docs/.local/`. Do not publish library contents, measured library counts, deployment records, personal identifiers or real-library screenshots. Use synthetic examples instead.

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

- Work is done when the action the owner asked for has been checked in the flow they use. Where it depends on real devices, a signed-in session or data volume, check on production. Otherwise begin the reply with what was not checked.
- Say "all" or "every" only after running the check across the full list.
- When one provider, table or query has a fault, check the others for the same fault before reporting.
- Do not ask the owner to run or look up what you can run or look up. Do not end a turn while jobs you started are queued or paused.
- Start an explanation with what changes for the owner, in plain words. Offer one recommended action, not a menu.

## Workflow

- Automatically delegate independent units of work to subagents. Name the model and the effort on every launch and pick the cheapest that can do the job. Claude Code: Haiku for read-only search; Sonnet for test runs and exact mechanical edits; Opus for all other work that writes code, at `medium` effort for implementation that follows an existing example from a clear brief and `high` for work that needs design decisions, interface work and anything that touches a release, a migration or stored data. Codex: the newest Sol for all of these, at `low` effort for test runs and mechanical edits, `medium` for implementation from a clear brief and `high` for the rest; Luna only for read-only search. Keep a fault that is not yet understood in the main thread. Never use Astra or Terra, and never launch without naming a model. If a result fails review once, redo it one tier up instead of retrying. Choose reasoning effort for the work and preserve the main thread's selected speed. Give each agent clear ownership, constraints, these instructions and verification criteria. Give all subagents one shared brief file. Coordinate dependencies between agents; keep tightly coupled edits together. A subagent that changes the interface checks it in a browser. The main agent reviews and verifies the integrated result.
- Reproduce bugs first. For a scraping failure, start with the specific job's saved request, response, error and snapshot, not a new search. A fault that was not reproduced gets no fix: report what is known and ask. A retry or re-send is not a fix. Make one small change and verify it; if it fails, return your own change to a known working state instead of stacking speculative fixes.
- Keep tests green. Use fixtures, mocked providers and a disposable database. Do not run live or full-library scrapes as tests. If a live check is explicitly requested, review the queue, select a tiny explicit subset, and preserve rate limits, cooldowns and concurrency controls.
- Use the project's existing dotenv loading. Do not overwrite local configuration, export the environment in shell scripts or print keys or other environment values. Do not ask for a secret in chat, and filter page dumps before printing them. Never publish private plugin names, aliases, credentials, scraped payloads, backups or machine-specific paths.
- Work that changes code goes in its own Git worktree. Run `corepack pnpm worktree:setup` in a new worktree before anything else. Never give a worktree its own `.env.local`. See [worktrees](docs/development.md#worktrees).
- Check Git status before editing or pushing. Keep pre-existing work intact. Review every changed line and its effect on callers and docs. Run relevant tests, use the configured formatter, verify the final diff, then commit and push completed changes unless asked not to. Preserve configured commit signing. Stage files by path, never with `git add -A` or `git add .`, and do not stage unrelated work.
- Edit with the edit tool. Batch read-only commands. Send large output to a file and read the relevant part. Run targeted tests while working and one full run before pushing.
- Finished work goes to `main`, and that push is the release. Keep prototypes and unfinished work on a branch. The release does not run database migrations: run any migration the change depends on first. Releases publish one at a time, each commit that passed its checks in turn, so later pushes do not hold yours back; a run ends without publishing only when a newer commit is already live. After pushing, wait for the run and confirm that your commit or a newer one is live; a failed check publishes nothing, so fix it or say the change is not live. The release tests signed-out pages only, so check the changed flow in the app yourself. Begin the final reply with what was pushed, whether it is live and what was checked.
