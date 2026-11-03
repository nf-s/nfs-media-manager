# Serply search notes

Reviewed 2026-11-03 against official documentation, adapter/tests and main's saved experiment responses. This documentation review made no Serply API calls, direct RYM requests or library changes. Recommendations are not measured coverage improvements.

## Verified API contract

- Google: `GET /v1/search/?q=...`; authenticate with `X-Api-Key`. Although the endpoint heading uses `/v1/search/{query}`, current request examples explicitly use ordinary query parameters. Named options are `num`, `start`, and `gl` (country). `X-Proxy-Location` selects a proxy region; `X-User-Agent` accepts `desktop` or `mobile`. The adapter's `filter=0` is not documented on this endpoint; neither are `hl`, `tbs`, `safe`, or a generic `engine` selector. Treat these as unverified, not necessarily rejected. [Google Search](https://www.serply.io/docs/resources/google-search).
- Organic `results[]` documents `title`, `description`, `link`, `position`, `realPosition`, `result_type`, and `metadata`. Metadata can contain `display_url`, `attributes`, and sometimes `rating`/`reviews`; RYM-specific availability is not promised. Links may contain tracking parameters. `total` is nullable; `query`, `ts`, `device_region`, and `device_type` aid diagnostics. Other SERP fields include `answers`, optional `ai_overview`, ads, related queries/questions, images, places and knowledge panels. Do not treat these as release evidence. [Response fields](https://www.serply.io/docs/resources/google-search#response-fields).
- `num=10` retrieves approximately one page; larger values do not aggregate pages. `start=10` requests page two. Each page is a separate request. The guide describes no cursor or pagination envelope, but captured responses below sometimes include `pagination`; do not assume a stable envelope. Adjacent pages may overlap. HTTP 200 with empty `results` can also mean a transient upstream failure. The guide's retry suggestion is not permission to bypass this project's budget. [Pagination](https://www.serply.io/docs/guides/pagination).
- Bing uses a separate `/v1/b/search/` endpoint, not `engine=bing`. Its organic results document `title`, `description`, `link`, and `realPosition`, but not Google-style rating metadata. Do not assume Google's pagination parameters or parser behavior transfer unchanged. [Bing Search](https://www.serply.io/docs/resources/bing-search).

## Query syntax and encoding

Serply documents `site:`, quoted phrases, `OR`, exclusions, `intitle:`, and `inurl:`. These belong inside `q`, not separate API parameters. [Search operators](https://www.serply.io/docs/guides/search-operators).

Google confirms that `site:` accepts a domain, URL or URL prefix. Consequently, `site:https://rateyourmusic.com/release/album/.../` is valid but is a prefix restriction, not an exact-page guarantee. Scheme/hostname differences can affect results. A missing hit does not prove a URL is absent from the index, and a bare `site:` query has limited ranking semantics. [Google's site operator](https://developers.google.com/search/docs/monitor-debug/search-operators/all-search-site).

The adapter's `URL.searchParams.set('q', query)` correctly encodes the query once. Offline round trips preserved `+`, `&`, `#`, `%`, Unicode, and a URL containing `%20`. Encoding the literal percent as `%25` in the outer query is necessary, not accidental double encoding. Do not pre-encode `q` before passing it to `searchParams`. Raw names can still contain search operators such as quotes or `OR`; this is a search-semantics concern, not HTTP parameter injection. Quoting all titles may reduce recall and needs separate evaluation.

## Bounded fallback recommendations

1. The current adapter retains a five-query ceiling normally, increasing to six only when recognized OST/DJ Mix role simplification changes the cleaned title. The original four queries remain intact; the extra query is a simplified natural-language fallback. See the [provider contract](album-providers.md#serply-rate-your-music). Preserve concurrency, spacing, cooldowns, budgets and matching guards. These ceilings do not imply every lookup exhausts its allowance; no live-coverage improvement is claimed for the new fallback.
2. Evaluate alternatives within the applicable bound: `site:rateyourmusic.com "Artist" "Release"` for noisy results, or `site:rateyourmusic.com inurl:release Artist Release` to emphasize release pages. These are syntax-supported experiments, not proven better defaults; they can suppress useful review-header evidence.
3. Keep `num=10`. Prefer a query variation over default pagination for focused album lookup. If main explicitly budgets a pagination experiment, use `start=10`, consistent geography/device, and deduplicate release URLs. Keep the existing `gl=us`; consider pinning `X-Proxy-Location: US` when comparing runs.
4. Test Bing as a main-coordinated alternative within the approved per-album bound, with its own validated fixtures. Count pagination and engine alternatives against that same bound; do not accept non-RYM search summaries as RYM data.
5. Distinguish empty results, rejected candidates and missing fields in coverage reports. Do not label an empty response as confirmed absence. Keep `filter=0` classified as unverified until main's controlled comparison or provider clarification establishes its effect.

## Bounded canary timeout

The Serply manifest now sets `requestTimeoutMs: 120000`, implemented as a local diagnostic choice after a reported production abort at the previous 15-second default. The user authorized broad paid API testing; this note does not attribute the specific timeout choice to that authorization. Other providers retain the unchanged 15-second default. The earlier 30-second suggestion was not the implemented setting. Serply's [homepage Search example](https://www.serply.io/) uses 30 seconds, while its [pagination example](https://www.serply.io/docs/guides/pagination) uses 15; neither establishes a mandatory timeout or service SLA. No reviewed official guidance establishes a 120-second requirement.

The normal five-search ceiling allocates at most 600 seconds of HTTP timeout; the conditional sixth search raises this to 720 seconds within the 900-second job lease, excluding database, gate-wait and processing overhead. Two concurrent requests, 250 ms minimum start spacing, existing cooldowns/budgets and no hidden retries remain unchanged. Historical five-search captures retain their original scope. The reported approximately 20-second canary elapsed time included database work and is not a measurement of HTTP duration alone.

The canary was scheduled after the cooldown ending 2026-11-03 06:17 UTC (17:17 Hobart). The separate query experiment below does not establish that the timeout change fixed production aborts.

## Saved query experiment

On 2026-11-03, main completed six gated serial requests for caroline's `caroline 2`, all HTTP 200. Evidence is retained locally in `.cloudflare/rym-audit/query-experiment.json`, compared with the earlier `.cloudflare/rym-audit/canary-progress.json`. These ignored diagnostic artifacts are not bundled documentation fixtures. All experiment addresses retain `gl=us&num=10`; only `without-filter` omits `filter=0`.

| Variant                     | Direct RYM | Direct other | Opaque Google |
| --------------------------- | ---------: | -----------: | ------------: |
| Baseline `?q=`, plus spaces |         10 |            0 |             0 |
| Percent-encoded spaces      |         10 |            0 |             0 |
| Legacy `/q=` path           |         10 |            0 |             0 |
| Without `filter`            |         10 |            0 |             0 |
| Scheme-qualified domain     |          0 |            2 |             8 |
| Release-URL control         |          3 |            0 |             0 |

- The earlier baseline returned two Apple Music links and eight opaque Google links; it now returns ten direct RYM links. The scheme-domain variant shows the same count pattern as that earlier failure, not an identical response. Opaque destinations remain unresolved; all results, including Apple Music, are labelled `organic`. Direct RYM counts include editions and non-release pages, not ten valid album matches.
- All six report `device_type: desktop`, `device_region: ""`, `cf-cache-status: DYNAMIC`, and null recorded `age`/`x-cache`. Geography is not established by the blank region or `gl=us`; these headers do not rule out application/upstream caching. Legacy-path results exactly match baseline results and repeat its `ts=4.519` seconds despite only 763 ms elapsed including the gate. This is consistent with reuse, not proof of a cache mechanism or independent execution.
- Every response echoes the serialized parameter string, not just search text. Percent-space echoes literal spaces; baseline/legacy retain `+`. Successful and unsuccessful forms both echo `q=...&gl=...`, so this does not diagnose misparsing. Percent-space has the same ten URLs in a different order; without-filter shares nine baseline URLs.
- Scheme-domain includes `total: 49`, `total_text` and `pagination`; the first four have null totals and no pagination. Release-control has `total: 3` and no structured rating metadata, unlike the earlier ten-result rated control. Result count, schema and field availability vary independently of HTTP success.

One observation per variant, possible reuse, unreported proxy geography and the earlier baseline reversal prevent causal conclusions. No evidence here justifies changing encoding, adopting legacy paths, removing `filter`, or declaring scheme-qualified domains generally broken. Retain validated RYM URL/identity checks and bounded fallbacks; preserve these paired responses for provider investigation. No further calls were made for this analysis.

## Bing q-only follow-up

Serply explicitly shows `/v1/b/search/?q=...` in its cURL, JavaScript and Python examples, despite the path-parameter heading. Ordinary query transport is documented, not merely inferred from Google. The Bing page does not document `gl`, `num` or `filter`. [Bing request examples](https://www.serply.io/docs/resources/bing-search#request-example).

Main's ignored `.cloudflare/rym-audit/bing-q-only.json` contains two further HTTP 200 responses, inspected offline alongside `vivid-search.json`:

- The earlier VIVID request with extra options returned Irish-statute-themed results. The same query with only `q` returned ten general-word results (dictionaries, ticketing and other businesses), not matching album evidence.
- The q-only caroline control returned ten name/general-topic results, not the known album found through Google. Thus the failure is not confined to the less-established artist query.
- All three responses contain Bing `/ck/a` tracking links. The experiment's `otherDirect: 10` counter is misleading here: it recognizes Google opaque links only. There are zero direct RYM links; no redirects were followed or destination identities verified by this review.
- Responses echo the requested parameter strings and report desktop, blank region and `htmlLang: en`. Each records `cf-cache-status: DYNAMIC` with null `age`/`x-cache`; this does not establish proxy geography or exclude application/upstream caching.

Removing the extra options did not restore relevant, site-restricted evidence in these two observations. Changed topics do not establish why results changed or which terms the upstream engine executed. This is not proof that documented `?q=` is unsupported, nor that the albums are absent from RYM. Keep Bing out of production fallback and retain the captures for provider investigation. No additional calls were made; queue totals remain provisional.

## RYM .p suffix

Community evidence identifies `.p` as the primary issue, distinct from the album-level summary. MetaBrainz contributors describe `/succumb/` versus `/succumb.p/` and report a primary-issue URL ending `-1.p`; numeric suffixes alone therefore do not reliably identify editions. They discuss possible changes to primary issues without establishing URL permanence. [MetaBrainz discussion](https://community.metabrainz.org/t/proper-rate-your-music-linking/815564). A Wikidata contributor independently distinguishes the White Album summary, `.p` primary issue and numbered issue URLs. [Wikidata discussion](https://www.wikidata.org/wiki/Property_talk:P8392).

These are community observations, not verified RYM specifications. RYM search access was robots-blocked, and the linked [RYM primary-issue wiki](https://rateyourmusic.com/wiki/Music:Primary+issue) could not be fetched. No access controls were bypassed. The exact rating population, equivalence of summary/primary-issue counts, and URL stability remain unverified. The user-reported 7.8k versus 7.9k counts do not distinguish indexing lag from different rating scopes.

The implemented matcher does not blanket-exclude `.p`: it removes terminal `.p` for identity comparison while retaining the observed source URL/reference and preserving that `.p` in URL-restricted fallback queries. Edition-marked titles remain rejected. Two paid exact-`.p` experiments reported by main returned HTTP 200 with zero results. Correct query preservation is not a demonstrated coverage gain, redirect or rating-scope equivalence. Keep each score/count observation together and retain provenance; do not sum votes or choose evidence solely by the larger count.

## Repository observations and verification

Current deployment reported by main on 2026-11-03: `b8b4e85e-bd76-44a8-b8f7-ae9b38422899`. The [provider contract](album-providers.md#serply-rate-your-music) includes bilingual header handling, observed-`.p` query preservation and validated rated-source link preference. The serializer preserves the exact rating-source destination, including valid child pages, instead of selecting a stale legacy link first. Missing rated evidence retains the generic fallback; no new database queries, provider calls or ratings are introduced. Five searches remain the normal ceiling, six only for a distinct OST/DJ Mix simplified fallback. Diagnostics remain bounded at 384 KiB/14 entries; Bing remains outside production fallback.

Reported checks: 1,589 server tests across 81 files passed, including 55 new helper/serializer cases. The current 18-file standalone snapshot passed 477 targeted unit tests, typecheck, lint and formatting. Baseline replay remained 124/124. All 101 integration cases (13 Serply, 88 request-gate) passed on the latest parser including query preservation; that run preceded only the link-serialization change, which adds no database queries. Main confirmed a Chrome reload now links the Gish rating to the correct RYM root while preserving canonical title, date and artist. These scopes are not additive, and the browser check is not a new rating acquisition. This docs task inspected code but did not rerun suites or make provider calls. Commit/push remain blocked by 1Password signing pending the user's response; completion is not claimed.

## Final coverage

Final selected-cohort snapshot reported by main: 2026-11-03 08:03:33 UTC (19:03:33 AEDT), using latest manifest job IDs rather than superseded attempts. All 267 are terminal: zero queued and zero running.

| Cohort             | Rated | Genres-only | Identity-only | Failed | Total |
| ------------------ | ----: | ----------: | ------------: | -----: | ----: |
| Previously failed  |   163 |           4 |             3 |     10 |   180 |
| Additional unrated |    50 |           6 |             0 |     31 |    87 |
| Total              |   213 |          10 |             3 |     41 |   267 |

The previously failed cohort has 170/180 successful jobs, but only 163 fresh rating recoveries. The 41 failures do not establish absence from RYM: indexed evidence may be empty, insufficient or edition-ambiguous. One Battle's recorded canary supplied two genres, not a fresh rating or validation of a historical 3.8. Library rating totals include legacy observations and are not fresh validation.

Safety at this snapshot: `halted=false`, `failure_count=0`; the 06:17 UTC cooldown had expired. Main owns the private `final-results.json` export; audit files remain ignored. Reproduce the scoped read-only report with `node .cloudflare/rym-audit/final-coverage.mjs`. Selected-queue and verification completion do not imply Git commit/push completion.
