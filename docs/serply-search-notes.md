# Serply search notes

## Verified API contract

The adapter uses the [Serply Google Search endpoint](https://www.serply.io/docs/resources/google-search) with an `X-Api-Key` header. Put the search text in the `q` parameter. Inspect organic results for the destination, indexed title, description and optional structured rating metadata. HTTP success does not establish a match; empty results do not prove that an album is absent from RYM.

## Query syntax and encoding

Set `q` once with `URL.searchParams.set`; do not pre-encode search text or embedded URLs. [Search operators](https://www.serply.io/docs/guides/search-operators) belong inside the query. A [Google site restriction](https://developers.google.com/search/docs/monitor-debug/search-operators/all-search-site) can select a URL prefix, not just the exact release. Validate the returned URL and indexed identity before using any fields.

## Bounded fallback recommendations

Use the [provider contract](album-providers.md#serply-rate-your-music) for query ordering, ceilings and early stopping. Each additional [page](https://www.serply.io/docs/guides/pagination) is another request, not a free extension of the first result set. Do not follow opaque redirects, infer a rating from a search summary, or retry outside the gate. Bing is not a production fallback.

## RYM .p suffix

Keep an observed terminal `.p` on source links and URL-restricted searches. The matcher removes it only for identity comparison. A release summary and a primary-issue result need not describe the same rating population. Keep a score and its vote count together; do not sum counts or select a result solely because it has more votes.

## Reviewing a match

Inspect the saved response before requesting another lookup. Distinguish an empty result set, a contradictory release identity, an identity without a rating and a supported score. Even a matching URL does not override an indexed title for a different album. Use explicit aggregate evidence, not personal review stars. To recover labelled genres or descriptors without changing ratings, [replay saved tags](album-providers.md#replaying-saved-tags).
