# Last.fm scrobble history

The app can store every scrobble from one Last.fm account and use it for album listening charts, per-track counts, browse filters and the [Tracks library](tracks-and-playlists.md#lastfm-tracks). This is separate from the [Last.fm album metadata provider](album-providers.md), which looks up one album per job.

## Setup

Add the Last.fm API key and username in Providers → Credentials, or set `LASTFM_API_KEY` and `LASTFM_USERNAME`. The account's recent listening must be public; the sync uses the API key only and has no Last.fm sign-in.

## Syncing

The sync is a Last.fm job. It has no media item and appears in Jobs as **Scrobble sync**, with its status, progress log, cancel and retry. No page needs to stay open.

Open Imports → Last.fm scrobbles and choose **Sync now**. Opening the page only reads stored status.

- The first sync reads the full history through [`user.getRecentTracks`](https://www.last.fm/api/show/user.getRecentTracks), 200 scrobbles per request and one request per second. A history of 200,000 scrobbles is 1,000 requests, about 20 minutes.
- One job fetches at most 300 pages or eight minutes, then succeeds and queues a follow-on job in the same transaction. A long sync is a chain of jobs; each follow-on records the job it continues.
- Sync jobs go through the Last.fm dispatcher like album metadata jobs: one Last.fm job runs at a time, in queue order, and pausing Last.fm, a cooldown or an access halt holds them.
- Later syncs read from seven days before the previous sync's end, so scrobbles submitted late with older timestamps are picked up. Scrobbles already stored are not duplicated.
- Each run fixes its time window when it is queued. New listening during a run cannot shift page numbers; it is picked up by the next sync.
- A page and its checkpoint are saved together. A failed or cancelled run resumes at the next unread page.
- A failed request, a timeout, an HTTP 5xx response or a temporary Last.fm service error repeats the same page up to three times, after 5, 20 and 60 seconds. Each retry is written to the job log. These failures delay the next Last.fm request by five seconds and do not open a provider cooldown.
- A rate limit, access error, invalid response, unexpected page or a temporary failure that outlasts its retries fails the job. A failed job is not retried automatically. Retry the job in Jobs, or choose **Resume sync**, once any Last.fm cooldown has passed.
- A failed job can stop the Last.fm dispatcher in the hosted deployment. **Sync now**, **Resume sync** and retrying the job restart it; a deliberate pause, a cooldown and an access halt are not cleared. The schedule never restarts it.
- Cancelling the job stops the sync before the next request and discards a page still in flight. Stored scrobbles are kept.
- An interrupted worker leaves the job failed, like any other job.

### Schedule

The page sets how often a sync is queued: off, every 10 or 30 minutes, every 1, 3 or 6 hours, daily (the default), or weekly, measured from the last completed sync. Both runtimes check every five minutes when scraping is enabled, so a due sync may start up to five minutes later, plus any provider queue or cooldown delay.

The schedule only follows a completed sync. It does not start the first sync, and it does not resume a failed or cancelled run: resolve that run first. It queues nothing while a sync job is queued or running, or while Last.fm is cooling down.

Last.fm publishes no numeric rate limit. Its [API introduction](https://www.last.fm/api/intro) asks for an identifiable User-Agent and warns against continuously making several calls per second; the sync sends a User-Agent and stays at one request per second. The [API terms](https://www.last.fm/api/tos) limit stored Last.fm data to 100 MB without written consent, so only names, MusicBrainz IDs and timestamps are stored, not artwork or URLs.

## What is stored

One row per scrobble: UTC timestamp, artist, album and track names as Last.fm returned them, any MusicBrainz IDs, and a link to the matching library album.

- Last.fm has no scrobble ID. A scrobble is identified by account, timestamp, artist, track and album, so two identical scrobbles in the same second are stored once.
- The now-playing entry has no timestamp and is ignored.
- Scrobbles dated before 2002 come from devices with an unset clock and are ignored.
- Scrobbles edited or deleted on Last.fm after they were stored are not corrected. Last.fm provides no change feed.

## Linking scrobbles to albums

After each sync, every scrobbled artist and album name is compared with the library's album titles, credited artists and track titles, and links to at most one album. Several scrobbled names can link to the same album, so a standard and a deluxe edition are counted together. Links are recomputed on every sync, so albums added later pick up their existing scrobbles. **Relink** on the page does the same from stored scrobbles without contacting Last.fm.

The rules apply in this order; the first rule that any album satisfies decides.

| Rule                                        | Links when                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same title and artist                       | The title matches and the scrobbled artist is a credited artist, ignoring case and repeated spaces.                                                                                                                                |
| Same title and artist, ignoring punctuation | As above, also ignoring accents, punctuation, apostrophes, `&` against "and", and a leading "The" on the artist.                                                                                                                   |
| Another edition or artist credit            | The titles match once edition, disc and format qualifiers are removed, such as "(Deluxe Edition)", "[2011 Remaster]", "- Disc 1", "CD2" or "EP". The scrobbled artist is credited, or names a credited artist among collaborators. |
| Same title and shared tracks                | The title matches under an artist the album does not credit, and at least half of the scrobbled tracks are on the album. A track named after the album does not count. This links compilation and mix tracks.                      |
| Similar title and shared tracks             | One title starts with the other, the artist matches, and at least half of the scrobbled tracks are on the album.                                                                                                                   |
| Same artist and shared tracks               | The artist matches, at least three scrobbled tracks are on the album, and they are at least three quarters of the scrobbled tracks. This links misspelled and translated titles.                                                   |

- Between several fitting albums, the one sharing the most scrobbled tracks is chosen, then the one whose own title has no edition qualifier. If they still tie, nothing is linked and the name is listed under **Several albums match**.
- The last two rules do not link a live, remix or compilation title to an album that is not one, or the reverse.
- Track titles are compared without bracketed qualifiers or a "- Remastered" style suffix.
- Scrobbles without an album name are not linked.

Scrobbles also link to library tracks by artist and track name, with or without an album name. Those links are recomputed at the same times. Tracks not already represented by an unambiguous Spotify library match become Last.fm tracks, with unknown metadata left empty. In **Tracks**, **Import Last.fm tracks** brings already-stored history into the library without another Last.fm request. A completed sync or **Relink** also refreshes these tracks. Use the **Source** filter to include or exclude Last.fm alongside Spotify playlists and Liked Songs; a track can belong to several sources. See [Last.fm tracks](tracks-and-playlists.md#lastfm-tracks) and the separate [listening-attribution rules](tracks-and-playlists.md#scrobbles).

### Manual links

Each name on the page has **Link** or **Change**, which opens a side panel with library search, possible matching albums, **Unlink** and **Automatic** where applicable. The table keeps its position while the panel is open. On phones the panel opens from the bottom.

Unlinked names also have **Add new album**, which opens the panel's Spotify search with the scrobbled artist and album filled in and starts the search. Saved bulk-search results are reused when available. The library tab starts with the album title filled in and searches only while that tab is open.

Choose a release and add it to the library; that scrobbled name is then linked to it. The panel closes immediately while the add and link finish, with a progress indicator on the page. A failure restores the panel when it is free, or offers recovery without interrupting another open album. If the album is added but linking fails, retrying uses the existing album instead of adding it again. A result already in the library can be linked directly. Spotify provider credentials are required; the operation does not save albums to a Spotify account.

The album's Listening tab has **Remove** on each linked name, **Add** on each similar unlinked name, and **Add scrobbled name** to search every scrobbled name.

A manual link, and a name kept unlinked, are stored and survive every later sync and relink. **Automatic** on the page returns a name to automatic matching. A manual link is removed when its album is deleted.

### Link report

The page lists every scrobbled artist and album name with its scrobble count, most played first, and one of these outcomes:

| Outcome                    | Meaning                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| Linked                     | Linked automatically. Shows the library album and the rule used. |
| Linked manually            | Linked by the owner.                                             |
| Several albums match       | The equally fitting albums are listed. Choose one with **Link**. |
| No matching album          | No album fits. Most are albums that are not in the library.      |
| Kept unlinked              | Unlinked by the owner; automatic matching skips it.              |
| Scrobbled without an album | Last.fm stored no album name.                                    |

A summary gives the number of names and scrobbles for each outcome. The list filters by outcome and searches artist and album names. Unlinked scrobbles remain stored.

The report uses the same table primitives and selection behavior as album metadata: sortable columns, individual checkboxes, inclusive Shift-click ranges and select-all-loaded with a mixed state. Filtering or sorting clears the selection. Nothing is selected initially, and selection alone makes no provider requests.

Filter to **Unlinked**, select the albums to investigate, then choose **Search Spotify albums**. More than five searches require confirmation. Large selections are submitted in serial groups of at most 100. Each eligible group creates a separate Spotify album-search job with no library item; existing active searches and linked names are skipped. An uncertain submission error stops further groups and leaves the unconfirmed selection for review.

Searches use the existing Spotify dispatcher, request spacing, cooldowns and access limits. Their status is shown in the report and Jobs, where they can be cancelled or explicitly retried. Each search saves its first page of candidates against the scrobbled artist/album group. Opening **Add new album** reads those candidates without repeating the search. No album is added or linked until you choose one.

## In the app

- **Added** uses the earlier of the stored library date and the first linked Last.fm scrobble, including in album sorting and date ranges. If the stored date is unknown, the first linked scrobble is used. This is calculated from the current links when reading the library; it does not overwrite the stored date or provider history and does not require another sync. Unlinking or moving scrobbles updates Added immediately. Album details identify the date's source, and Edit keeps the original field under **Stored date added**.
- **Album → Listening** shows total scrobbles, first and last listen, and scrobbles per month or year for the album or one of its tracks, as a line or bars; it opens on the monthly line. Pointing at or focusing the chart shows one period's count; the arrow keys move between periods. It lists the scrobbled names linked to the album, and unlinked names that resemble it: the same title under another artist, or a credited artist with a title that starts with the album's title or the reverse. Names can be added and removed there; see [manual links](#manual-links).
- **Album → Tracks** shows each track's scrobble count. Track counts match scrobbled track names to the album's track titles.
- **Browse** gains three album fields, recomputed at the end of every sync:
  - `Last listened`: date of the most recent linked scrobble.
  - `Scrobbles, last year` and `Scrobbles, last 5 years`: linked scrobbles in a rolling window ending at the last sync.
- `Scrobbles` is set to the linked scrobble count for albums that have linked scrobbles. Other albums keep the count reported by the Last.fm album provider. A later Last.fm album metadata job writes Last.fm's own album count again until the next sync.

### Custom listening filters and sorting

Open **Filters** in the album browse toolbar, then expand **Listening** to filter linked, stored Last.fm scrobbles. Each rule has a period and an inclusive minimum and/or maximum count:

- **In the last**: a chosen number of days, weeks, months or years, ending now. Months and years use calendar boundaries in UTC, clamping to the last valid day when necessary.
- **Date range**: start and/or end dates, including the whole end date in UTC. Leave a bound blank to include everything before or after the other bound.
- **All time**: all linked stored scrobbles.

Add up to ten rules and choose to match **all** or **any** of them. Listening rules also respect the other active search, tag and range filters. **Apply rules** applies the draft rules together. Each applied rule appears among the active filters, where it can be removed; **Clear all** removes listening filters too.

For fewer than ten scrobbles in the last two years, choose **In the last**, **2 years**, and a maximum of **9**. To require an established listening history as well, add an **All time** rule with a minimum of **100** and match **all** rules. Set both bounds to **10** for exactly ten scrobbles, or maximum **0** for no stored scrobbles in the period.

The separate sort period in **Listening** orders albums by their scrobble count in that period, using the existing ascending/descending control. The selected period count is available as a table column and as the grid's sort value. Rules and sort period persist in the URL and saved browse preferences. Existing fixed-year fields and saved views remain supported; those fixed fields still reflect the last sync.

These are **track scrobbles, not complete album plays**. Albums without linked history count as zero, and provider-reported album totals are never substituted. Results reflect only the history already synced and linked; a zero does not prove an album was never played. Browsing does not contact Last.fm or start a sync.

## Verification

`integration/browse-listening.integration.ts` verifies custom periods, zero counts, all/any rules, date boundaries, sorting and pagination against synthetic scrobbles in a temporary database. Schema, API and UI helper tests cover invalid periods/counts, album-only controls and saved state.

`integration/lastfm-scrobbles.integration.ts` runs the sync through the job dispatcher with mocked HTTP and a temporary database. It covers chained jobs, the fixed window, failure and resume from Jobs and from the page, cancellation, overlap without duplicates, the schedule, album linking, manual links, the link report, browse fields and the album listening report. It makes no Last.fm requests. `src/lib/lastfm-album-matching.test.ts` covers each linking rule with synthetic albums.

`integration/lastfm-spotify-search.integration.ts` verifies explicit selection, duplicate suppression, stored candidates, cancellation, retry, account isolation, stale library identities, provider cooldowns and sorting before pagination with mocked Spotify requests. UI tests cover selection, schedule options, cached results and background add/link recovery.
