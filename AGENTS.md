# Working on Media Manager

Start with the [application architecture](docs/handoff.md), then read the relevant [requirements and guides](docs/README.md), READMEs and decision notes. Find the closest working example and search for existing helpers and shared types before writing code. Follow the surrounding structure and naming; extend a utility rather than creating a parallel version.

Create new projects as local Git repositories; do not use Sites. Deploy only on explicit request to a specified or agreed destination.

Keep installation-specific Markdown in ignored `docs/.local/`. Do not publish library contents, measured library counts, deployment records, personal identifiers or real-library screenshots. Use synthetic examples instead.

## Implementation

- Validate external input at the boundary with the project's schemas. Keep route handlers thin: authorize, validate, call a service, return.
- No type assertions, non-null assertions, TypeScript ignores or expected-error directives, lint suppressions, or weakening types to make code compile. Fix the types or the logic.
- Use concise, functional interface copy. Preserve user-supplied wording. No slogans, decorative headings, taglines, filler or cute empty states. Add explanatory text only when it helps someone act or understand a real limitation. Follow the [UI guidelines](docs/dev-guidelines-ui.md).
- Keep library interfaces consistent. Every primary Browse page, including Artists, must use the shared Tracks Browse pattern: Grid/List/Table views, sorting, full autocomplete search with field filters and AI search, filter modes, ranges and URL state. Metadata selection must use that same search control and filter semantics alongside provider freshness filters. Do not substitute a plain text search or secondary table for a primary Browse page. Reuse shared controls and verify parity before finishing.
- Stay within scope. Do not silently refactor unrelated code, leave debug logging or keep commented-out implementations.

## Interface

The [design system](docs/design-system/README.md) is the only source of interface design. Read it before any interface work, and open its pages in a browser to see each component and screen.

- Build screens from the shared components in `packages/ui/src/components/ds` and `packages/ui/src/components/ui`. Style only with the `--ds-*` tokens in `packages/ui/src/design-system/tokens.css`. No literal colours, sizes, radii, shadows or fonts, no component styles written for one page, and no second style of table, card, list row, pill, tab, status or chart.
- The stylesheets in `packages/ui/src/styles` hold page layout only. Formats for dates, times, counts and durations come from `packages/ui/src/lib/format.ts`.
- Putting existing components together into a new screen needs no approval. A new visual element, a variant with its own look, or a change to how an existing component looks does. When the work needs one, stop that part of the work and:
  1. Draw two or three concepts as static pages copied from `docs/design-system/concept-template.html`, built from the existing tokens and components, with invented data.
  2. Show them to the owner with the trade-off of each and a recommendation, and wait for the owner to accept one. Do not choose for the owner and do not ship a temporary version in the meantime.
  3. Add the accepted concept to the design system: tokens if it needs them, its styles in `components.css`, its React component, and its section with rules on the components page. Delete the concept pages.
  4. Continue the feature using the new component.
- Check interface changes in a browser at desktop and phone widths against the design library page for that screen, on a disposable database with synthetic data.

## Workflow

- Automatically delegate independent units of work to subagents. Use Sol (Codex) or Opus (Claude Code) for every subagent and select it explicitly; never use Astra or implicitly inherit a model that could be Astra. Choose reasoning effort for the work and preserve the main thread's selected speed. Give each agent clear ownership, constraints, these instructions and verification criteria. Coordinate dependencies between agents; keep tightly coupled edits together. The main agent reviews and verifies the integrated result.
- Reproduce bugs first. For a scraping failure, start with the specific job's saved request, response, error and snapshot, not a new search. Say when reproduction is not possible. Make one small change and verify it; if it fails, return your own change to a known working state instead of stacking speculative fixes.
- Keep tests green. Use fixtures, mocked providers and a disposable database. Do not run live or full-library scrapes as tests. If a live check is explicitly requested, review the queue, select a tiny explicit subset, and preserve rate limits, cooldowns and concurrency controls.
- Use the project's existing dotenv loading. Do not overwrite local configuration, export the environment in shell scripts or print keys. Never publish private plugin names, aliases, credentials, scraped payloads, backups or machine-specific paths.
- Check Git status before editing or deploying. Keep pre-existing work intact. Review every changed line and its effect on callers and docs. Run relevant tests, use the configured formatter, verify the final diff, then commit and push completed changes unless asked not to. Preserve configured commit signing. Do not stage unrelated work.
