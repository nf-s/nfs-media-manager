# Importing a library

Select Films or Albums in the top-left menu, then open **Imports**. A preview lets you check rows before writing anything. Selecting no metadata providers keeps file imports offline. Source files remain unchanged.

## Add one album or film

In Browse, choose **Add album** or **Add film**. Search Spotify for an album or TMDb for a film, check the artwork, artist or original title and release date, then choose **Add**. Search requires the provider's credentials in Providers; Spotify account connection is not required. **Next** reads one more page only when selected.

Adding fetches metadata for the selected provider ID and stores the item with its provider history. Spotify albums include their tracks. The app does not save the album to your Spotify account. Existing items stay unchanged, including dates and manual edits; repeated or concurrent additions resolve to the same library item. No other providers or background scrape jobs are started. Failed provider requests are not retried automatically, and the normal provider request limits and cooldowns apply.

The original Added date for a new item is the time you add it. Existing Last.fm scrobbles can be linked to a new album through the scrobble-name link controls, or by the next sync or **Relink**. See [Last.fm scrobble history](lastfm-scrobbles.md).

Provider search follows the [Spotify album search](https://developer.spotify.com/documentation/web-api/reference/search) and [TMDb movie search](https://developer.themoviedb.org/reference/search-movie) APIs. Results are limited to ten Spotify albums or twenty TMDb films per page, with at most fifty pages per search.

## Film CSVs

Choose the matching IMDb ratings or watchlist format and drop the exported CSV. The preview shows new, changed and unchanged films, missing IDs and personal-state changes. Select the rows to import and any providers you want to enrich **new films**.

Existing films keep their canonical metadata, artwork, public scores and manual overrides. Personal ratings, watched/watchlist state, dates and missing identifiers can be updated. Existing films are not automatically scraped again; use **Jobs → Metadata** for that.

Matching uses IMDb/TMDb identifiers and refuses ambiguous identities. A film with no external ID still appears in the library as **Needs ID**. Open its details and Edit to correct identifiers later.

## Film NFOs

Set `SCAN_DIR` to a folder accessible to the API server, restart the API, and choose the NFO import. **Find new NFO films** previews entries absent from your library. The browser cannot choose an arbitrary server directory.

Scanning skips symlinks, hidden/recycle folders and `SCAN_EXCLUDE` entries. It reads metadata files, not movie binaries, and does not download artwork while scanning. File dates and retained library dates are used where available; uncertain dates are labelled in details. You can override Added dates manually.

## Album CSVs

Choose **Album CSV** for title/artist rows:

```csv
title,artist,dateAdded
First Example,Example Artist,2026-01-01
Second Example,Example Artist,2026-01-02
```

Choose **UPC CSV** when the file also has a `upc` column. Barcodes are strings, so preserve leading zeroes. Optional Spotify values can be album IDs, album URIs or HTTPS album links in a `spotify`, `spotifyId` or `spotifyUrl` column. Dates must be ISO dates/timestamps. Artist is one complete artist name; quote a CSV value when it contains a comma.

Album imports leave existing albums unchanged. Only newly created albums can queue the providers selected at import time. Matching uses available identifiers and falls back conservatively to title and artist.

## Spotify saved albums

Configure and connect Spotify as described in [getting started](getting-started.md#spotify-saved-albums). Preview a small batch first. A bounded preview is a page of saved albums, not necessarily the newest across the account. Reading the whole library requires explicit confirmation and finds the newest by saved date before presenting a selection.

Previewing Spotify makes read-only API requests. It does not import until you confirm selected rows. No playlist writes or playback controls are used.

## Spotify playlists

**Imports → Spotify playlists** lists Liked Songs and the connected account's playlists. Importing one adds its tracks to the Tracks library as a Spotify job; it does not add albums. Only playlists the account owns or collaborates on can be imported. See [tracks and Spotify playlists](tracks-and-playlists.md).

## Limits and job behavior

- CSV files are limited to 20 MB and fewer than 10,000 media rows.
- Previews belong to the signed-in account, expire after an hour and can be committed once.
- Imports queue one explicitly selected item per provider job. More than five operations requires confirmation.
- Already queued/scraped work and items lacking IDs or credentials are skipped and reported.
- Jobs retain request limits, cooldowns and error stops. Retry is an explicit action; successful work is not repeated.

Open **Jobs** to see progress or an error. Inspect a job's stored data without making another provider request. Correct credentials or identifiers before reviewing a retry.

## Migrating an older JSON library

This section is only for installations with the earlier app's JSON exports. New users should use CSV, NFO or Spotify imports.

| Input                            | Location                                      |
| -------------------------------- | --------------------------------------------- |
| Raw albums and provider payloads | `LEGACY_SERVER_DATA_DIR/lib-music.json`       |
| Raw films and provider payloads  | `LEGACY_SERVER_DATA_DIR/lib.json`             |
| Cleaned album browse values      | `apps/web/public/data/lib-music.json`         |
| Cleaned film browse values       | `apps/web/public/data/lib-movie.json`         |
| Optional saved views             | `LEGACY_SERVER_DATA_DIR/smart-playlists.json` |

The raw directory defaults to `apps/server/data`. The cleaned files supply derived browse values; raw inputs preserve provider payloads and library context. Local plugins translate their own data. These folders are ignored by Git.

Back up PostgreSQL first. Start with the **Legacy JSON library** import's two-album/two-film default, or use:

```sh
corepack pnpm --filter @repo/server import:legacy --album-limit=2 --film-limit=2
corepack pnpm --filter @repo/server verify:legacy
```

After reviewing the result, the command below imports **all local records**:

```sh
corepack pnpm --filter @repo/server import:legacy
```

It never queues scraping. Identical inputs do not duplicate canonical records or identical import snapshots. Full imports archive previously imported records absent from the current cleaned files instead of deleting them. Only one legacy import can run at a time.

For older film dates, `pnpm --filter @repo/server backfill:film-added` previews recovery from stored imports; `--apply` updates the date/source fields while preserving manual overrides. See [date recovery](nfo-creation-dates.md).
