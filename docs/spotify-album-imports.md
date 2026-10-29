# Spotify Albums and CSV Imports

## Scope

Spotify is a read-only metadata provider. It fetches a selected album and its tracks, or explicitly discovers the connected user's saved albums. There is no playback, audio-feature collection, playlist access/write, or library mutation. All HTTP requests, including token exchange, refresh and credential tests, pass through the persistent Spotify request gate (one concurrent request, at least 1500 ms between requests). Errors stop the operation; there are no hidden retries or cooldown resets.

Metadata jobs use Spotify-owned `album` references already in the legacy library, then the explicit `spotify` CSV alias, UPC, or an unambiguous exact title/full-artist-set lookup. Generic `album` references owned by another provider are not Spotify IDs. New results retain the `album` namespace. Missing response UPCs preserve the existing value, and absent popularity does not reset an existing score to zero. Track pagination is bounded to 500 tracks and must finish consistently before replacing tracks or calculating duration. Client-credentials tokens use the documented HTTP Basic authorization header; no tokens are exposed to the browser.

## Account Setup

Configure Spotify `clientId`, `clientSecret`, and `redirectUri` in Providers. The client secret is used by metadata jobs; saved-album account authorization uses Authorization Code with PKCE and requests only `user-library-read`. An optional uppercase two-letter `market` applies to metadata requests. The registered redirect URI must exactly match the Providers value and end with `/api/v1/spotify/callback`.

Spotify rejects `localhost` callback URLs. Keep the existing signed-in app/API addresses and use an explicit loopback IP only for the Spotify callback. For example:

- Web app: `http://localhost:3001`
- Browser-facing API/auth base: `http://localhost:4001`
- Registered Spotify callback and Providers `redirectUri`: `http://127.0.0.1:4001/api/v1/spotify/callback`

The web and API/auth origins must be explicitly allowed by the application's existing trusted-origin configuration. There is no need to sign in again on the loopback IP or change the app's addresses. The callback uses the API port, not the web port. Register its exact URL in Spotify's developer dashboard. `SPOTIFY_CLIENT_REDIRECT_URI` is the environment fallback; a saved provider setting takes precedence. The connection setup disclosure shows the callback URL.

Connect is an explicit authenticated POST from a trusted app origin. The public callback only relays validated OAuth parameters to `/api/v1/spotify/complete` on the fixed configured API/auth origin, never to a request-supplied host or return URL. Completion requires the original authenticated session, owner-bound cryptographic state, PKCE, and a ten-minute expiry. It exchanges the code using the original registered callback URL, not the relay URL. State is atomically consumed and cannot be replayed. Both endpoints use no-store/no-referrer headers; application and reverse-proxy logs must omit query strings because the redirect carries a short-lived authorization code. Access/refresh tokens and the verifier remain encrypted server-side in a separate per-user namespace. Disconnect deletes local account tokens and pending authorization; it does not revoke the app in Spotify account settings. A disconnect/reconnect during token exchange prevents the old exchange from restoring credentials.

## Preview and Commit

`GET /api/v1/spotify/status` is local-only. Spotify's saved-albums endpoint does not document a sort parameter or guarantee saved-date order. A live five-album check on 2026-10-27 returned dates out of order. The import UI permits a preview with **Read all** unchecked; it sends `{scanAll: false, limit: 20, offset: 0, confirmBroadRun: false}` for a bounded 20-album read, not necessarily the newest additions across the whole library. Checking **Read all** explicitly confirms a full-library scan and sends `{scanAll: true, limit: 20, offset: 0, confirmBroadRun: true}`. For a full scan, `limit` controls the newest results shown, not the number read. The server reads sequential pages of at most 50, sorts by Spotify's `added_at` descending, and only then takes the requested newest albums. The preview exposes Added dates and scanned counts. It never uses playback or release dates for this ordering.

Full scans require confirmation even for a one-album preview, start at offset zero, and stop if the reported library exceeds 10,000 albums. Duplicate IDs, changing totals, incomplete pagination, and provider errors abort without staging partial newest results. Overlapping previews for one user are rejected in the current single-process server. Returned next URLs are never followed. Every request uses the same persistent rate gate; discovery does not import canonical albums or queue jobs. Full-scan behavior is covered with fixtures, not a live full-library test.

Bounded-page requests use `scanAll: false` (also the API default when omitted). More than 50 requires confirmation, with a maximum 500 per preview and offset 10000. A returned `nextOffset` is informational, never automatically followed beyond the requested count. A partial batch is sorted within itself and explicitly warns that it is not the newest across the whole library. `discovery.complete` distinguishes complete reads; `scanned` is separate from `received`, the number of preview results.

CSV uses `POST /api/v1/album-imports/preview` with `{format, fileName, content}`. Formats are `album-csv` (required `title,artist`) and `upc-csv` (required `title,artist,upc`). Optional columns are `spotify`/`spotifyId`/`spotifyUrl`, `upc`, and `date`/`addedDate`/`dateAdded`. Column names are case-insensitive. Artist is one complete artist name, not a comma-separated list. Dates must be ISO dates/timestamps. Spotify values may be album IDs, album URIs or HTTPS album links. Barcodes remain strings with leading zeroes. UPC-only files without title/artist are not supported. CSV previews are entirely offline, limited to 20 MB and 9,999 rows; malformed rows are reported and skipped.

Both sources produce an hour-long owner-bound preview. The existing staging table is reused with distinct album kinds and a version-independent album envelope; it is not a film preview. `POST /api/v1/album-imports/commit` accepts only `previewId`, selected `rows`, selected `providers`, and `confirmBroadRun`. The preview is claimed once. Identity is rechecked transactionally, recognizes legacy Spotify references and shared barcodes, rejects ambiguity, and uses exact title/artist sets only as a fallback. Identical title/artist entries in one source are conservatively deduplicated. Internal canonical IDs do not use Spotify IDs.

Existing albums are always unchanged: no title/date/identifier overwrite, provider snapshots, or enrichment jobs. A previously-existing album deleted since preview is not recreated without another preview. Newly-created albums alone go through the shared enrichment scheduler with the selected configured providers. Selecting no providers is offline. More than five new-album/provider operations requires explicit confirmation. Import history is scoped to albums, including running/failed runs.

## Verification and API Notes

Automated tests use mocked HTTP, mocked persistence and authenticated route fixtures; no live provider calls, queue workers or production imports run in tests. Chrome verification on 2026-10-27 confirmed both simulated denial and successful live authorization through the loopback callback, returning to the localhost app with its session intact. After the account owner signed in and the exact callback was registered in Spotify's dashboard, token exchange succeeded and the local status endpoint confirmed `connected: true` with `user-library-read`. No saved-album discovery or scraping was triggered by these checks.

Official references verified 2026-10-27:

- [Saved albums](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-albums): read scope and 50-item HTTP pages.
- [PKCE authorization](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) and [refresh tokens](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens).
- [Redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri): HTTPS except explicit loopback IPs; no localhost.
- [February 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026): development-mode album popularity/label removals; search is limited to ten results.
- [March 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/march-2026): album external IDs remain available.
- [July 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/july-2026): development quota is shared across client IDs on a developer account. This application's persistent gate cannot count traffic made by other applications.

Legacy `spotify.ts`, `spotify-server.ts`, album/UPC CSV and playlist scripts were read as references only. Their broad recursive discovery, OAuth scopes, automatic existing-album date writes, playlist synchronization and audio-feature behavior are intentionally not reproduced.
