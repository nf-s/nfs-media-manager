# Production operations

This is a handoff, not a deployment procedure. The rollout state below was reported through 2026-11-04; it is not a live status check or authorization to run jobs. A fresh clone may lack the Worker entrypoints, deployment configuration, local runner and private plugin used in production. Do not deploy a checkout on the assumption that it matches the running revision.

## Access and runtime

The public entrypoint is the Next.js web Worker (OpenNext). It calls the private Hono API Worker through a service binding; the API has no public or preview URL. The API connects directly to Neon PostgreSQL using Drizzle and the Neon serverless driver, not Hyperdrive or D1. Keep the runtime database role separate from the migration owner. Never start the local Node dispatcher against the production database.

Better Auth permits only the configured owner: the API checks the normalized owner email and admin role, and checks the user ID when pinned. An admin role alone is insufficient. Public signup is disabled; login attempts are rate limited. Keep the allowlist, credentials, encryption key and deployment identifiers out of published configuration and documentation. Preserve the original encryption key when restoring provider credentials.

## Dispatch and provider policy

Queue delivery, the global scraping switch and each provider's Durable Object dispatch controls are separate gates. Disabling scraping does not stop durable CSV imports; an explicit Spotify saved-album preview can still read from Spotify. A pause is not cancellation of in-flight work.

The owner can inspect pause/stop state, active slots and job selection at `GET /api/v1/cloud/providers/:provider/dispatch`. On the corresponding POST, omitted `jobIds` preserves the selection; `[]` holds all work; up to ten unique IDs restrict dispatch to those jobs without substitution; explicit `null` removes the restriction. Change scope only with no active slots. Before releasing a provider, review the backlog and the selected test job's logs, request events and linked snapshot. Do not revive historical failures or release a library-wide backlog as a test.

| Provider                                                   | Last reported operating state                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MDBList, TMDb, OMDb, Last.fm, MusicBrainz, Spotify, Serply | Enabled after individual cloud tests. Last.fm's extra album top-tag lookup is opt-in, not a reason for a bulk run.                                                                                                                  |
| Discogs                                                    | Last explicit dispatch decision: paused after rate limiting. Stored results or adapter changes do not establish a later release.                                                                                                    |
| Private film provider                                      | Cloud request denied (403); cause unconfirmed. A reviewed single-film test succeeded via the local worker. The owner then released normal dispatch on that transport; the earlier test-only pause no longer describes that release. |

Dispatch permission never overrides per-provider concurrency, request spacing, hourly/daily budgets, fixed windows, cooldowns or access halts. Keep these controls across pairing, restarts and scope changes. Investigate denials rather than switching transports automatically; honor rate-limit responses rather than retrying around them.

## Local worker and limitations

The paired foreground worker performs only permitted HTTPS GETs from a trusted machine using a revocable provider-scoped token and local credential headers. Jobs, request authorization, quotas and snapshots remain in the cloud. When the worker is offline, jobs wait; there is no cloud fallback. An interrupted GET is not replayed: preserve the journal, distinguish a pending result upload from a new request, and review uncertain work before resuming. A past successful test does not establish current worker availability.

NFO scanning and export remain local; cloud NFO upload/import is not implemented. iPhone Safari supports **Share > Add to Home Screen** with standalone launch, not offline library access. Narrow-screen layout was browser-tested; physical installation and standalone session behavior remain manual checks.

Optional working-copy runbooks (not required by a fresh clone): `docs/cloudflare-deployment.md`, `docs/local-worker.md`, `docs/mobile-home-screen.md`. Treat them as drafts, not publication inputs. Review any excerpts for private provider names and abbreviations, account and owner identifiers, local paths, tokens and handoff details.
