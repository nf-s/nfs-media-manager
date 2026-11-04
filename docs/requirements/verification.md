# Verification criteria

Use synthetic media records, mocked provider responses and a disposable database. Block outbound provider requests. These checks describe expected behavior, not results from a particular library.

- **Browse and search:** Test desktop and narrow layouts, keyboard navigation, saved preferences and direct links. Jump between distant viewport windows, change filters while requests are pending and return from details. Verify counts, stable sorting, missing values, failed artwork and retry behavior.
- **Import reconciliation:** Compare visible records with the cleaned fixture and retained history with raw inputs. Include duplicate identifiers, missing IDs, conflicting identity evidence and records outside the visible set. Repeat the import: identical inputs must not duplicate entities or snapshots. Source files remain unchanged.
- **Reviewed imports:** Check preview ownership, expiry, selection and replay prevention. Change an item's state between preview and commit; verify actual outcomes and that enrichment targets only newly created items. Mock Spotify discovery separately from offline file import.
- **Metadata and history:** Distinguish zero from missing scores, audience from critic ratings and provider identifiers from canonical IDs. Check source links, manual overrides, playlist memberships, merged and hidden tags, and retained provenance. Verify the targeted Spotify audio-feature exclusion without losing other track or snapshot data.
- **Jobs and access:** Verify authentication, redacted diagnostics, per-provider request limits, cooldowns and explicit retry of unfinished work. Distinguish a failed attempt from a successful scrape or no attempt. Opening a view or inspecting a job must not schedule work.
- **Release checks:** Run the relevant contract, service and UI tests and typechecks. Report what was tested and what remains unverified; mocked responses do not establish live connectivity.
