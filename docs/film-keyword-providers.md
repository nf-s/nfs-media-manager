# Film Keyword Providers

## Configuration and Safety

TMDb and MDBList appear under Providers. Store credentials there; the existing encrypted-secret resolver prefers stored values over environment fallbacks. MDBList declares `MDBLIST_API_KEY` on its `apiKey` secret descriptor. No environment-file changes are required. Existing `TMDB_API_KEY` fallback behavior is unchanged.

Both adapters use only `context.request`. TMDb retains one concurrent request and a 2,000 ms minimum interval. MDBList permits **3 concurrent requests**, with **350 ms between request starts**, and defaults to **10,000 requests per UTC calendar day** for the upgraded account. Its dispatcher runs up to three independent one-film jobs concurrently; this is not merely a display setting. Providers > MDBList > Configuration offers an editable request cap and either Daily (UTC) or Rolling hour. Daily mode has no additional hourly cap. Choose a local cap appropriate to the account allowance; other applications share the service quota and can exhaust it sooner. Credential tests and failed HTTP attempts count against the same persistent gateway budget; blocked attempts do not.

MDBList also allows at most **1,000 reads and 300 writes per fixed five-minute window**, aligned to :00, :05, :10, etc., across every API key and OAuth app on an account. Independent durable read/write counts enforce these limits under the same provider row lock used for spacing, daily budgets and concurrency leases. This adapter only performs GET lookups. The gateway classifies GET as read and other methods as write; future documented POST batch-read endpoints would need explicit classification before adoption (currently they would conservatively spend the smaller write budget). Separate applications cannot be counted locally: successful quota headers and HTTP 429 enforce the service's account-wide decisions.

Migration `0012_provider_request_concurrency` adds request classification and expiring concurrent leases without deleting history. Existing request events default to read, matching historical MDBList GET lookups. Live leases survive process restarts and expire after 20 seconds, beyond the 15-second HTTP timeout. Concurrency is explicitly enabled only for MDBList; existing provider throughput is unchanged. A 429 blocks waiting requests; already-dispatched requests may finish, and their successful responses cannot clear the cooldown.

The configured account allowance is 10,000 requests per day, resetting at midnight UTC. Existing installations retain their saved budget overrides; update the saved cap through Configuration when upgrading an account, not just the manifest default. Daily usage counts the existing durable request event log from UTC midnight, including attempts older than an hour; no longer request-array retention is needed. Mode/cap changes and restarts never erase usage. Reservations and configuration updates use the same provider row lock, so concurrent clients cannot spend the final allowance twice. Configurable-budget waits are derived from usage rather than stored as service cooldowns. Switching to daily clears only an obsolete wait carrying the exact internal `Hourly request budget exhausted` reason, never quota/429 errors or access halts. Migration `0009_gray_spencer_smythe` adds nullable budget-override and updater fields to the existing request state; no data is reset. Only explicitly opted-in providers allow budget configuration; other providers' hard limits stay unchanged.

MDBList opts into `rateLimit.respectRateLimitHeaders`: the gateway validates `X-RateLimit-Limit`, `X-RateLimit-Remaining` and the Unix-second `X-RateLimit-Reset`. A successful response with a positive limit, zero remaining and a valid future reset persists a cooldown until that reset, without rejecting the successful result or counting a failure. Missing, malformed or expired header values do not create a successful-response cooldown; local limits remain enforced. Increasing the local cap cannot bypass a service-reported quota or reset time.

MDBList opts into `retryAfterIsAuthoritative`: HTTP 429 uses a valid future `Retry-After` deadline, without imposing the old one-hour minimum. A daily reset header extends that deadline only when the daily remaining allowance is zero; otherwise a five-minute throttle must not become a midnight wait. Missing, invalid or expired Retry-After values use a conservative five-minute fallback. Repeated scheduled throttles do not add the generic fifteen-minute failure penalty. Other providers retain their existing minimum-cooldown policy and unexpected errors retain fail-fast safeguards. Both documented errors (`Daily API limit exceeded!` and `API rate limit exceeded!`) are stopped by HTTP 429 before adapter parsing, with no automatic retry loop.

The cooldown uses the existing database state and row locks, survives restarts, blocks concurrent clients, and cannot shorten an existing cooldown or clear an access halt. Successful completion retains an active cooldown's reason. It does not poll `/user` or issue any extra requests. Adapters propagate gateway safety exceptions unchanged and stop the current scrape on service/transport/validation errors. MDBList's only fallback is one alternate explicit-ID lookup after a gateway-classified `ProviderItemNotFoundError`, as described below; it never falls back after rate limits, authentication/access failures, network errors, malformed payloads or mismatched identities. A normalizer failure never becomes an empty successful snapshot. The existing explicit, audited manual cooldown-reset action remains available; it is not invoked by configuration changes.

Selecting a provider for a confirmed job is required. Registration, imports, tests and browsing do not make provider requests. The explicit credential-test action performs one known-film lookup, not an account/list request. No live scraping or account checks were used to develop this integration.

## Requests and Output

- TMDb requests `/3/movie/{tmdbId}?append_to_response=credits,keywords` with the existing API-key query parameter. If only IMDb is known, the existing `/3/find/{imdbId}?external_source=imdb_id` request resolves the TMDb ID first. There is no separate keyword request. The normalizer reads `keywords.keywords` as `{ id, name }` entries and emits valid positive integer IDs as `sourceId`, `source: tmdb`, and exact original `rawName`. It does not strip prefixes or replace hyphens in TMDb names. Existing metadata/genre/credit behavior remains intact.
- MDBList requests `/{imdb|tmdb}/movie/{id}/?apikey=...&append_to_response=keyword`. IMDb takes priority; TMDb is the primary lookup when IMDb is absent. Only a gateway-classified `ProviderItemNotFoundError` permits one fallback to the other explicitly supplied identifier. With IMDb-first selection, this means trying the known TMDb movie ID after an IMDb 404. A successful primary lookup uses **one request**; fallback uses **at most two requests per film**, both through `context.request` with unchanged budgets, spacing, concurrency, cooldowns and access halts. Both supplied lookup IDs are validated before any HTTP request. Missing IDs remain explicit errors; there is no title search, list enumeration, ID discovery, TV guessing or retry loop.
- MDBList response identity must match the requested `ids.imdb` or `ids.tmdb`. A fallback response must match **both supplied expected IDs**; missing or conflicting identities fail rather than accepting the wrong film. The documented older `imdbid`/`tmdbid` spellings and public-schema `imdb_id` are accepted, but conflicting identifiers fail. A top-level `id` is **not** assumed to be a TMDb ID.
- MDBList returns keyword tags, the original JSON snapshot, and four audience ratings: Metacritic users (0-10), Trakt (0-100 percent), Letterboxd (0-5), and Rotten Tomatoes audience/Popcorn (0-100 percent). Each has its own vote count. Ratings write only `mediaPatch.metadata.browse`; aggregator title/artwork and canonical film fields remain untouched. No references, credits or playlists are emitted. Unknown response fields remain in the raw snapshot but do not become metadata edits.

## Audience Ratings

The existing single-film response supplies ratings; no additional requests are made. The normalized `score` (0-100) is preferred and converted into the source's display scale. Missing values remain missing, including vote counts; real zero is retained. Value-only responses use native scales (Letterboxd 0-5). Older documented examples used Letterboxd values on a 0-10 scale, so the unambiguous normalized score takes precedence and out-of-scale values are not guessed.

Stored rating URLs are validated against the appropriate source domain and film path. Documented relative paths are resolved against that domain; a critic film URL can serve the corresponding audience rating. Trakt's numeric `ids.trakt` supplies its film URL when the rating has no URL. No film slugs are generated from titles. A score without a known film URL explicitly links to the source homepage, explained by its tooltip. Known provider references without scores render linked icon-only entries; unknown providers do not produce empty placeholder icons. Grid, table and detail badges share the same source-link resolver, open new tabs without opening item details, and omit the external-arrow decoration only for rating entries.

## MDBList Provenance

The maintained API examples use `keywords: [{ id: number, name: string }]`. Unsupported shapes, missing keyword arrays, wrong media types, invalid IDs/names and service-error payloads fail validation rather than silently clearing tags. An explicit empty array is valid. Blank/non-name tokens are ignored.

Each keyword retains the complete original `rawName` and an opaque, explicitly aggregator-namespaced `sourceId: mdblist:<id>`. The numeric keyword ID is not claimed to be an upstream IMDb/TMDb ID. `source` is independent of the transporting provider (`mdblist`, recorded by persistence).

Only simple dot prefixes `imdb.`, `tmdb.`, `trakt.` and `mdblist.` are recognized, case-insensitively. Their remainder must not contain another dot; unfamiliar/multi-part namespaces stay intact. Colon and hyphen prefixes are **not** namespace syntax. Display names trim whitespace and turn slug hyphens into spaces; original tokens are untouched. Exact custom tokens listed in MDBList's keyword documentation receive `source: mdblist`; other unprefixed/unknown tokens receive `source: unknown`. In particular, `imdb-tv-movie` becomes **imdb tv movie**, with MDBList provenance, not **tv movie** attributed to IMDb.

No fuzzy matching or adapter-level cross-source deduplication is performed. Canonical tag normalization, occurrence provenance, aliases and manual merges belong to backend tag persistence.

## Evidence and Limitations

Rate-limit policy updated on 2026-10-28 against the [MDBList API limits](https://docs.mdblist.com/docs/api) and the account owner's upgraded 10,000/day allowance.

Reviewed public documentation on 2026-10-27:

- [Current MDBList public OpenAPI](https://api.mdblist.com/schema/) documents the single-title route, `keyword` append, API-key authentication and quota behavior, but omits the appended keyword response schema.
- [Maintainer API examples, pinned revision](https://github.com/linaspurinis/api.mdblist.com/blob/8aa0843ec6166dead8475a0c086d43bbec3a7b19/apiary.apib) show nested single-title `ids` and object-form `keywords` in the companion batch response. The reduced offline fixture preserves those structures. The example's top-level media ID differs from its TMDb ID.
- [Older maintainer single-title example](https://github.com/linaspurinis/api.mdblist.com/blob/8af027361e6665bf420b3b9539ba9b6261de6e6c/apiary.apib) independently shows object-form `keywords` and the legacy identifier spelling.
- [MDBList keyword documentation](https://docs.mdblist.com/docs/keywords) identifies upstream sources and the custom-token allowlist. Dot-prefix handling is the requested adapter policy; the public OpenAPI does not specify namespace syntax.
- [TMDb append-to-response](https://developer.themoviedb.org/docs/append-to-response) and [movie keywords](https://developer.themoviedb.org/reference/movie-keywords) document the combined details request and keyword endpoint.

The current single-title OpenAPI is incomplete. The parser is based on maintained examples plus the older single-title example and fails closed on undocumented alternatives. The audience-rating shape was also checked against one already stored response; no new live request was made. Lists are intentionally omitted: the existing single-title response does not document a list-membership field. Even though separate list endpoints exist, this provider never calls them per film. Genres and other aggregator ratings are not imported by this integration.

## Initial Library Run

`scripts/queue-mdblist-library.ts` previews the active film library by default, skipping hidden legacy records, successful MDBList snapshots and queued/running MDBList work. Missing IMDb/TMDb identifiers are listed in its local report. Dispatch uses the authenticated server API and the existing configured admin credentials; it does not call MDBList directly or bypass provider safeguards. It preserves an output report after each submitted job, stops on a submission error, and requires explicit confirmation for an all-library run.

From `apps/server`:

```sh
pnpm exec tsx scripts/queue-mdblist-library.ts --all --output /tmp/mdblist-preview.json
pnpm exec tsx scripts/queue-mdblist-library.ts --run --limit 3 --output /tmp/mdblist-small-run.json
pnpm exec tsx scripts/queue-mdblist-library.ts --run --all --confirm-broad-run --output /tmp/mdblist-library-run.json
```

Use a fresh report filename for each invocation. Every submitted job contains exactly one film. A shared batch ID is only a navigation aid, not an execution group. MDBList runs up to three independent jobs simultaneously, and completion refills capacity immediately rather than waiting for the next worker timer. Other providers have their own independent slots and retain their request limits. Already-dispatched work can finish after an error, but cooldowns, access halts, cancellation and repeated-error stops prevent new requests. A queued run is not a guarantee that every provider lookup succeeds; inspect failed jobs and missing identifiers separately.

MDBList's exact-ID lookup opts into `request(url, init, { notFoundOn404: true })`. Only HTTP 404 becomes an item-level `ProviderItemNotFoundError`. If no alternate explicit ID exists, or both exact-ID attempts miss, the final not-found error remains visible in job errors without stopping unrelated films or creating a provider cooldown. Other HTTP failures retain the normal safety classification, including on the fallback request. The gateway does not assume 404 is benign for other endpoints or providers. Some active library entries are television programmes or other non-movie material; this movie-only adapter reports lookup misses rather than guessing a different media type or saving a false successful snapshot.

Live verification on 2026-10-28, explicitly authorized by the account owner, observed three independent one-film jobs running simultaneously and overlapping HTTP requests before launching the initial-library batches. Normal automated tests remain fixture-only.

## Offline Tests

Run from the workspace root:

```sh
pnpm --filter @repo/server test:unit src/plugins/builtin/__tests__ src/lib/provider-secrets.test.ts src/lib/request-policy.test.ts src/plugins/__tests__/registry.test.ts
pnpm --filter @repo/server typecheck
```

Fixtures include a reduced maintainer example and explicitly synthetic malformed/prefix cases. Tests assert exact request URLs/counts, no direct fetch, SDK provenance round-tripping, identifier matching, unknown namespaces, custom tokens, missing/invalid values, service failures, gateway exception propagation, no title/artwork patches, catalog registration and secret precedence. Exact-ID fallback tests cover one-request primary success, two-request 404 recovery, both misses retaining not-found classification, no fallback after 429/auth/network/schema/identity failures, both expected response IDs, movie-only validation and invalid lookup IDs rejected before HTTP. Rating tests additionally cover native scales, counts, zero/missing scores, safe source URLs and the stored-response Trakt ID shape. Gateway quota/Retry-After behavior is exercised by the existing request-policy tests; these adapter tests do not contact providers or wait on real quotas.
