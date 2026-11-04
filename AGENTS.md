# Working on Media Manager

Start with the [application architecture](docs/handoff.md), then read the relevant [requirements and guides](docs/README.md), READMEs and decision notes. Find the closest working example and search for existing helpers and shared types before writing code. Follow the surrounding structure and naming; extend a utility rather than creating a parallel version.

Create new projects as local Git repositories; do not use Sites. Deploy only on explicit request to a specified or agreed destination.

Keep installation-specific Markdown in ignored `docs/.local/`. Do not publish library contents, measured library counts, deployment records, personal identifiers or real-library screenshots. Use synthetic examples instead.

## Implementation

- Validate external input at the boundary with the project's schemas. Keep route handlers thin: authorize, validate, call a service, return.
- No type assertions, non-null assertions, TypeScript ignores or expected-error directives, lint suppressions, or weakening types to make code compile. Fix the types or the logic.
- Use concise, functional interface copy. Preserve user-supplied wording. No slogans, decorative headings, taglines, filler or cute empty states. Add explanatory text only when it helps someone act or understand a real limitation. Follow the [UI guidelines](docs/dev-guidelines-ui.md).
- Stay within scope. Do not silently refactor unrelated code, leave debug logging or keep commented-out implementations.

## Workflow

- Automatically delegate independent units of work to subagents using the default coding model, not Astra unless explicitly requested. Choose reasoning effort for the work. Give each agent clear ownership, constraints, these instructions and verification criteria. Coordinate dependencies between agents; keep tightly coupled edits together. The main agent reviews and verifies the integrated result.
- Reproduce bugs first. For a scraping failure, start with the specific job's saved request, response, error and snapshot, not a new search. Say when reproduction is not possible. Make one small change and verify it; if it fails, return your own change to a known working state instead of stacking speculative fixes.
- Keep tests green. Use fixtures, mocked providers and a disposable database. Do not run live or full-library scrapes as tests. If a live check is explicitly requested, review the queue, select a tiny explicit subset, and preserve rate limits, cooldowns and concurrency controls.
- Use the project's existing dotenv loading. Do not overwrite local configuration, export the environment in shell scripts or print keys. Never publish private plugin names, aliases, credentials, scraped payloads, backups or machine-specific paths.
- Check Git status before editing or deploying. Keep pre-existing work intact. Review every changed line and its effect on callers and docs. Run relevant tests, use the configured formatter, verify the final diff, then commit and push completed changes unless asked not to. Preserve configured commit signing. Do not stage unrelated work.
