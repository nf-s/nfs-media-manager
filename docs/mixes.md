# Mixes

The Mixes library stores the archives of radio stations: each station's shows and every episode it has published, with the billed artists, the station's genre tags and links. A row's **station** is **Rinse FM**, **NTS** or **The Lot Radio**. Nothing is played in the app: a mix links to its page on the station's site and, where the station gives one, to the recording itself.

The library is separate from Subscriptions, which holds what one account follows. A station needs no account, key or setup. Search runs locally against stored rows.

## Navigation

- **Mixes** is a choice in the library selector, with **Browse** (`/mixes`), **Shows** (`/mixes/shows`) and **Imports**. Tags, Playlists and Matches are not shown. **Jobs** and **Providers** sit once under System and filter by library; `mediaType=mix` selects Mixes.
- **Imports** has one page per station: `/imports/rinse`, `/imports/nts` and `/imports/lotradio`. Each shows that station's sync and schedule. There is no import history.
- **Jobs** filtered to Mixes (`/jobs?mediaType=mix`) lists the station sync jobs: **Rinse FM mix sync**, **NTS mix sync** and **The Lot Radio mix sync**. The activity popover lists them with every other library's work.
- **Providers** filtered to Mixes lists the three stations. They are not listed for other libraries.

## Stations

No station publishes an API for its archive. Each is read through the JSON its own website loads, one request at a time and at least one second apart. A rate limit pauses the station for an hour. These interfaces are undocumented and can change without notice; a response in an unexpected shape fails the job.

| Station       | Shows                                                        | Mixes                                                                          | Recording link                                       | Duration  |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- | --------- |
| Rinse FM      | The site's show catalogue, 20 per request                    | Each show's episodes; later syncs read the daily schedule                      | The MP3 file the site plays, else its YouTube stream | Stored    |
| NTS           | The show pages in the site's sitemap                         | Each show's episodes, 12 per request; later syncs read the recently added list | The episode's SoundCloud or Mixcloud page            | Not given |
| The Lot Radio | Taken from the sessions; there is no separate show catalogue | The site's index of archived sessions, 100 per request                         | The session's stream                                 | Stored    |

- **Rinse FM.** A rebroadcast and an episode with no recording yet are not stored. The title follows the site's heading. Artists are the names the episode bills, with guests named after "with", "w/", "b2b" and similar in its title.
- **NTS.** An episode's show name is the part of its name before " w/ ", and its artists the names after it. Episodes not yet broadcast are skipped. The recently added list serves about eleven days of episodes. NTS serves no listing past offset 996, so the shows come from the sitemap, which names each by its alias; a show's name, description and artwork arrive with its first page of episodes, and until then the show is listed under its alias. For the same reason a show's episodes stop at its newest 1,008: older episodes of a longer show are not read.
- **The Lot Radio.** The index is read through the page's own server action, whose identifier changes each time the site is deployed. The sync finds it in the page's scripts, and finds it again when a page fails. A session's tracklist is stored as `Artist - Title` lines in its description, so a search finds a session by a track played in it. This station is read only by the server, not by a local worker transport.

## Sync

Choose **Sync now** on a station's Imports page. Opening a page only reads stored data, and nothing is requested from a station until its first sync is started.

The sync is a task job for the station's provider, with no media item, a progress log, cancel and retry. No page needs to stay open.

- The first sync of Rinse FM or NTS reads the show catalogue, then every show's episodes to its last page. The first sync of The Lot Radio reads the whole index.
- Later syncs read only what the station added since the last completed sync: Rinse FM's schedule from 14 days before that sync, NTS's recently added list down to 3 days before it, and The Lot Radio's index down to 14 days before it. The overlap picks up late uploads and edits.
- When the last completed sync is further back than the list reaches (about eleven days for NTS, 60 days for Rinse FM), the sync stores what the list holds, and the next sync reads the catalogue again: every show from its newest page, stopping at the first page that holds a stored mix.
- A show the station no longer lists keeps its mixes. Archives are kept; nothing is removed by a sync.
- One job runs at most 300 steps or eight minutes, then succeeds and queues a follow-on job. A long sync is a chain of jobs.
- A page and its checkpoint are saved together. A paused, failed or cancelled run resumes at the next unread page.
- A rate limit or cooldown **pauses** the sync; the schedule resumes it after the time shown, or choose **Resume sync**. Any other error fails the job. A failed job is not retried automatically.
- Cancelling the job stops the sync before the next request and discards a page still in flight.
- The owner's **Listened** date is never changed by a sync.

While a sync reads shows, the page counts shows read of the total. While it reads a station-wide list, it counts pages read.

### Size of a first sync

Requests are spaced at least a second apart. Saving each page takes longer than that: in the hosted deployment a step took four to nine seconds in November 2026, so the first sync of Rinse FM runs for about four hours and of NTS for about eleven, as a chain of jobs. Requests observed then:

| Station       | Requests       |
| ------------- | -------------- |
| Rinse FM      | About 1,700    |
| NTS           | 8,000 to 9,000 |
| The Lot Radio | About 50       |

A later sync makes a handful of requests.

### Schedule

Each station's page sets how often a sync is queued: off, every 1, 3 or 6 hours, daily (the default) or weekly, measured from the last completed sync. Both runtimes check every five minutes when scraping is enabled. The schedule follows a completed sync and resumes a paused one. It does not start the first sync and does not resume a failed or cancelled run.

The stations sync at the same time. In the hosted deployment each station has a queue of its own, so one station's sync never waits for another's or holds back metadata jobs.

## Artists

A mix stores the names the station bills, as text. No artist is created from them.

- A billed name, or the show's name, that equals a library artist's name links to that artist. Names are compared ignoring case and surrounding spaces. Only artists with a visible album or track are linked.
- Mix details list the billed artists. A linked name opens the artist; any other name filters Mixes by that name.
- An artist with at least one such mix has a **Mixes** tab listing them, searchable and sortable. Artist details carry `mixCount`.
- The link is made when the page is read, so an artist added later is linked without a new sync, and a renamed artist follows its new name.

Two different artists with the same name both link. A name the station spells differently from the library does not link; the **Artist** filter still finds its mixes.

## Tags

A mix's tags are the station's genre names, stored as text on the mix. They are not library tags and do not appear on the Tags pages.

The **Tags** filter in Mixes reads the [album tag hierarchy](tag-hierarchy.md): a filter on a tag matches mixes carrying that tag or any visible album tag beneath it, compared by normalized name. A filter on `Techno` finds a mix tagged only `Dub Techno` when `Dub Techno` sits under `Techno` in Albums. A station tag with no album tag of the same name matches only itself. Mixes never change the hierarchy.

## Searching

Search uses the same syntax and ranking as [Subscriptions](subscriptions.md#searching). A search matches the title, show name, tags, billed artists and description; **Titles only** leaves out the description. [AI search](ai-search.md#mixes) sets the search, filters and sort from a typed or dictated request.

Filters follow the [browse filter rules](requirements/search.md):

- Text filters match a whole value, ignoring case: **Title**, **Show**, **Station**, **Artist**, **Tags** and **Listened** (`Yes` or `No`). Tags also match subtags, as above.
- Ranges include both bounds: **Broadcast** (UTC), **Duration** and **Listened** (UTC). NTS mixes have no duration and match a Duration range only when missing values are included.
- Sorting is by relevance while searching and otherwise by newest first. It can also sort by broadcast date, title, show, duration or listened date. Missing values sort last, and ties are ordered by ID.

## Pages

`/mixes` works like the other Browse pages: Grid, List and Table views, suggestions with counts for titles, shows, stations, artists and tags, filter chips, ranges, AI search and URL state (`q`, `fields`, `filters`, `ranges`, `sortBy`, `direction`, `view`, `columns`, `item`).

- **Grid** is the default: square artwork with the length as a badge, then title, show, broadcast date and tags. A mix without artwork uses its show's.
- **Table** columns default to Title, Show, Station, Artist, Broadcast, Duration and Listened; Tags can be added.
- Selecting a mix opens details: its show (which opens show details), station, broadcast date, length, artists, tags (each a filter), description, **Open on** the station and, when there is a recording link, **Open recording**. The header leads with **Listened**, which records or clears the current time. `/mixes/:id` is the standalone page.
- With nothing synced, the page says "No mixes yet" with Open Imports.

`/mixes/shows` lists every stored show in the shared table, filterable by name and station, with Stored mixes and Latest mix; Episodes (the station's own count), Description and History can be added. A name opens show details with its mixes and a **Filter mixes** action. `/mixes/shows/:id` is the standalone page.

## API

Mixes are served by the Subscriptions endpoints with `library=mixes`; without it the endpoints read Subscriptions. A row belongs to exactly one library. Every endpoint requires the owner session.

| Endpoint                                                                                                   | Purpose                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /api/v1/subscriptions?library=mixes&q&fields&filters&ranges&sortBy&direction&page&size`               | A page of mixes. Filters are `title`, `source`, `type`, `artist`, `genre` and `watched`. |
| `GET /api/v1/subscriptions/facets?library=mixes&q&limitPerField`                                           | Title, show, station, artist and tag suggestions with counts.                            |
| `GET /api/v1/subscriptions/fields?library=mixes`                                                           | The Mixes browse fields.                                                                 |
| `GET /api/v1/subscriptions/sources?library=mixes&type`                                                     | Stored shows with their mix counts; `type` is one station.                               |
| `GET /api/v1/subscriptions/:id`                                                                            | One mix, with `artists`, `audioUrl` and the `libraryArtists` its names match.            |
| `PATCH /api/v1/subscriptions/:id`                                                                          | Sets or clears the listened date (`watchedAt`).                                          |
| `GET` and `POST /api/v1/subscriptions/sync/:provider`, `PUT /api/v1/subscriptions/sync/:provider/settings` | Sync status, start or resume a sync, and the schedule, for `rinse`, `nts` or `lotradio`. |
| `GET /api/v1/artists/:id/mixes?q&sortBy&direction&page&size`                                               | The mixes that bill the artist or whose show carries the artist's name.                  |

A filter, range or sort that the selected library does not have, such as `artist` in Subscriptions or `viewCount` in Mixes, is rejected with HTTP 422. Pages of mixes leave `libraryArtists` empty; it is filled when one mix is read.

A show's ID is `<station>.<the station's identifier>`, as is a mix's.

## What is stored

Mixes share the Subscriptions tables; a row's type decides its library.

| Table                 | Station rows                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription_source` | One per show: station, title, slug, description, artwork URL, page URL, the station's episode count and whether its history has been read.                           |
| `subscription_item`   | One per mix: show, station, title, description, tags, billed artists, page URL, recording URL, broadcast time, duration, artwork URL, listened date and search text. |
| `subscription_sync`   | One checkpoint per account and station, with whether the archive has been read in full.                                                                              |

Artwork is loaded from the station by the browser and is not stored. Recordings are not downloaded.

Migration `0038_mix_stations.sql` adds the page URL to sources, the artists, page URL and recording URL to items, and two checkpoint columns, and allows the station types. It rewrites no stored rows.

The hosted deployment binds one queue per station (`apps/server/wrangler.jsonc`): `nfs-media-scrape-rinse`, `nfs-media-scrape-nts` and `nfs-media-scrape-lotradio`. Create each before the deploy that binds it, for example `wrangler queues create nfs-media-scrape-rinse`. `nfs-media-scrape-mixes`, which the stations shared at first, receives nothing and keeps a consumer only for messages sent before the change.

## Verification

- `src/lib/rinse-api.test.ts`, `src/lib/nts-api.test.ts` and `src/lib/lotradio-api.test.ts` read each station's responses from synthetic fixtures: paging, skipped episodes, billed artists, dates and time zones, recording links, the reach of each recent list and a changed action identifier.
- `integration/mix-station-sync.integration.ts` runs the sync through the job dispatcher against fake stations and a temporary database: a first sync in chained jobs, a catalogue that names its shows without details, later syncs from the recent list, a list that does not reach the last sync, a feed-only station, renamed shows, a rate-limit pause and resume, failure, cancellation and the schedule.
- `integration/mixes-library.integration.ts` browses synthetic rows: both libraries kept apart, every filter, range and sort, the tag hierarchy, artist links and the artist's mixes.
- Web tests (`utils/subscriptions.test.ts`, `components/subscription-browser.test.tsx`, `components/subscription-sync.test.tsx`, `components/creator-details.test.tsx`, `utils/media-scope.test.ts`) cover the Mixes pages, station sync panels, show and mix details and navigation.

No test makes a request to a station.
