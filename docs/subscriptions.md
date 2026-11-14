# Subscriptions

The Subscriptions library stores the channels one YouTube account subscribes to and the videos they have uploaded, and the podcasts one Spotify account has saved and their episodes, as the same kind of record. A record's **type** follows its provider: **YouTube** or **Podcast**. Search runs locally against stored rows; YouTube itself cannot search across only your subscriptions.

The library is separate from albums, films and tracks. It has no metadata scrapes or tags of its own; a video's tags are the uploader's.

## Navigation

- **Subscriptions** is a choice in the library selector, with **Browse** (`/subscriptions`), **Channels** (`/subscriptions/channels`), **Imports**, **Jobs** and **Providers**, each scoped with `mediaType=subscription` like the album and film libraries. Tags and Playlists are not shown.
- **Imports** has **YouTube** (`/imports/youtube`: account connection and sync) and **Spotify podcasts** (`/imports/spotify-podcasts`: Spotify account state and sync). There is no import history.
- **Jobs** lists only the YouTube and podcast sync jobs, under **Subscription jobs**; they no longer appear among album jobs. The activity popover counts them under **Subscriptions**.
- **Providers** lists YouTube and Spotify with their credentials and settings. YouTube is no longer listed for albums or films; Spotify is also listed for albums.
- The old `/youtube` links redirect to `/subscriptions`, keeping the search, Titles only, sort, direction, view, open video and published days (as one Published range); channel and duration filters are dropped. `/youtube/subscriptions` redirects to `/imports/youtube`.

## YouTube setup

The sync signs in to Google with read-only access, so private subscriptions work and no YouTube privacy setting needs to change. It needs your own Google OAuth client:

1. In the [Google Cloud console](https://console.cloud.google.com/), create or choose a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen for **External** users. Set its publishing status to **In production**. While the status is **Testing**, Google expires the sign-in after seven days and every sync after that fails until you connect again. An unverified app is sufficient for personal use: Google shows a warning during sign-in, which you can continue past.
3. Create an OAuth client ID of type **Web application**. Add this authorized redirect URI, using the address and port of the API, not the web app:

   ```text
   http://localhost:4000/api/v1/youtube/callback
   ```

   A hosted installation uses its HTTPS API address with the same path. HTTP is accepted only for `localhost`, `127.0.0.1` and `[::1]`.

4. Open **Providers → YouTube → Credentials** and save the client ID, client secret and the same redirect URI. The environment fallbacks are `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` and `YOUTUBE_REDIRECT_URI`; saved values take precedence.
5. Open **Subscriptions → Imports → YouTube** and choose **Connect YouTube**. Approve the request to view your YouTube account. The app requests only the [`youtube.readonly`](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps) scope and cannot change subscriptions, playlists or videos.

Connecting is an explicit authenticated request. The public callback only relays Google's parameters to `/api/v1/youtube/complete` on the configured API address; completion requires the same signed-in session, a single-use state value, PKCE and a ten-minute expiry. Access and refresh tokens are stored encrypted on the server and never sent to the browser. **Disconnect** deletes the stored tokens and keeps the stored channels and videos; it does not remove the app from the Google account's third-party access list.

## YouTube sync

Choose **Sync now** on **Subscriptions → Imports → YouTube**. Opening a page only reads stored data.

The sync is a YouTube job with no media item. It appears in the Subscriptions library's Jobs as **YouTube subscription sync**, with its progress log, cancel and retry. No page needs to stay open.

- A sync first reads the subscription list, then each subscribed channel's Shorts list and uploads, 50 per request.
- A channel is skipped without a request when its history has been read, a sync has recorded its Shorts, the video count in its channel details equals the count at its last read, and none of its stored videos was live or upcoming when last read. A sync where nothing changed makes only the subscription list requests: two per 50 subscriptions.
- Shorts are not stored. A sync reads the Shorts list of each channel it does not skip, from the newest, and stops at the first page that contains a Short it has already recorded. A video on that list is left out of the uploads, and one stored by an earlier sync is deleted. The Data API has no field that marks a Short; the list is the playlist `UUSH` followed by the channel ID without its `UC` prefix, which YouTube does not document. If YouTube stops serving it, Shorts are stored as videos again.
- The first sync reads every channel's full upload history. Later syncs read a changed channel from its newest upload and stop at the first page that contains a video already stored, usually one page.
- One job runs at most 300 steps or eight minutes, then succeeds and queues a follow-on job. A long sync is a chain of jobs.
- A page of videos and its checkpoint are saved together. A paused, failed or cancelled run resumes at the next unread page.
- Channels you have unsubscribed from leave the channel list and the search. Their stored videos return if you subscribe again. The YouTube sync never changes podcast records.
- Videos that are private or deleted when read are skipped. A video deleted after it was stored is not removed.
- View, like and comment counts are as of the last sync that read the video. A sync refreshes the newest page of each channel it reads. The videos of a skipped channel keep their counts, titles and descriptions until the channel's video count changes; older videos keep the counts from when they were first read.
- Cancelling the job stops the sync before the next request and discards a page still in flight.

The video-count check cannot tell when one video was removed and another published between two syncs; that channel is read at its next count change. The count includes Shorts, so a channel that published only a Short is read and stores nothing new. A channel whose details carry no video count is read one page on every sync, as is a channel with a stored live or upcoming video, so a finished stream gets its length.

### Quota

The [YouTube Data API](https://developers.google.com/youtube/v3/determine_quota_cost) allows 10,000 units a day by default, and every request the sync makes costs one unit. The app's own limit is 9,000 requests a day, adjustable in **Providers → YouTube → Settings**; raising it cannot raise the Google quota.

Each 50 uploads cost two requests, and each 50 Shorts on a channel's Shorts list cost one. A first sync of 300 channels with 500 uploads each is about 6,000 requests; channels with long histories can take the first sync past one day. Later syncs cost two requests per 50 subscriptions for the list, and about three more for each channel that is read: one whose video count changed, or that has a stored live or upcoming video. View, like and comment counts on the other channels are not refreshed.

When the daily limit or the Google quota is reached, the sync **pauses** instead of failing. Stored videos are kept and searchable. The schedule resumes a paused sync after the time shown on the page; with the schedule off, choose **Resume sync** after that time. The app's daily count resets at midnight UTC and Google's quota at midnight Pacific time.

Any other error fails the job. A failed job is not retried automatically: retry it in Jobs or choose **Resume sync**. If Google rejects the saved sign-in, connect the account again, then resume.

In the hosted deployment the YouTube dispatcher starts unpaused, unlike a metadata provider's, because it has no backlog of media items: its only jobs are syncs the owner starts or the schedule queues. A failed job can stop it. **Sync now**, **Resume sync** and retrying the job restart it; a deliberate pause, a cooldown and an access halt are not cleared, and the schedule never restarts it.

### Schedule

The page sets how often a sync is queued: off, every 1, 3 or 6 hours, daily (the default) or weekly, measured from the last completed sync. Both runtimes check every five minutes when scraping is enabled.

The schedule follows a completed sync and resumes a paused one. It does not start the first sync, and it does not resume a failed or cancelled run. It queues nothing while a sync job is queued or running, or while YouTube is cooling down or halted.

## Spotify podcast sync

The podcast sync uses the Spotify account connected for albums and playlists (see [Spotify account setup](spotify-album-imports.md#account-setup)). It needs only `user-library-read`, which every connection has, so no reconnection is needed. Saved individual episodes are not read.

**Subscriptions → Imports → Spotify podcasts** shows whether Spotify is configured and connected, with **Connect Spotify** (or **Reconnect Spotify**), which returns to the same page and keeps the playback and playlist change access the connection already has. Below it is the same sync panel as YouTube's, counting podcasts and episodes. A server without the podcast sync says so on the page.

**Sync now** (`POST /api/v1/subscriptions/sync/spotify`) queues the sync. It is a Spotify job with no media item, **Spotify podcast sync**, listed in the Subscriptions library's Jobs, and goes through the same request gate as every other Spotify request: one request at a time with the configured spacing. It is refused while Spotify is not configured or connected, cooling down or halted.

- A sync first reads the saved podcasts, then each podcast's episodes, 50 per request.
- A podcast is skipped without a request when its history has been read and the number of stored episodes equals the episode total in the saved-podcast list. A sync where nothing changed makes only the saved-podcast requests: one per 50 saved podcasts.
- The first sync reads each podcast's full history. Later syncs read a changed podcast from its first page and stop at the first page that contains an episode already stored. A page whose release dates are not newest first, as a serial podcast lists them, does not stop the read, so such a podcast is read to the end.
- Episodes are requested only for podcasts the same sync's saved-podcast list returned. A podcast Spotify answers 404 for is skipped and its stored episodes are kept.
- An episode's publish date is midnight UTC of its release date, with Spotify's precision of year, month or day.
- Podcasts no longer saved leave the podcast list and the search. Their stored episodes return if the podcast is saved again. The podcast sync never changes YouTube records.
- Chunks, checkpoints and cancellation work as in the YouTube sync. If the saved podcasts change while the list is read, the run fails and resuming reads the list from the start.
- A Spotify rate limit pauses the sync until its retry time; the schedule resumes it. A rejected token (HTTP 401 or 403) halts every Spotify request, including album and playlist jobs, and fails the run. Saving the Spotify credentials in Providers clears the halt; then resume the sync. Any other error fails the job.
- The schedule is set per provider with `PUT /api/v1/subscriptions/sync/spotify/settings` and works as the YouTube schedule: daily by default, measured from the last completed sync. It never starts the first sync and does not resume a failed or cancelled run.

The episode-count check cannot tell when one episode was removed and another published between two syncs; that podcast is read at its next count change. A podcast whose stored count differs from Spotify's total for another reason, such as an empty entry Spotify returns, is read one page on every sync.

## Searching

Search runs against stored videos and episodes only and makes no provider requests.

- Every word must match. Word forms are matched, so `orbit` finds "orbits" and "orbital", and a partial word matches the start of a word, so `depres` finds "depression".
- `"quoted phrases"` match adjacent whole words, `or` matches either side, and a leading `-` excludes a word. Other punctuation has no special meaning.
- A search matches the title, tags, channel or podcast name and description. **Titles only** leaves out the description.
- Common words such as "the" are ignored. A search made only of common words or punctuation, such as "the who", falls back to the literal text in the title or channel name.
- In relevance order, title, tag and channel or podcast name matches rank above description matches.

[AI search](ai-search.md#subscriptions) sets the search, filters and sort from a typed or dictated request.

### Filters and sorting

Filters follow the [browse filter rules](requirements/search.md) of the other libraries:

- Text filters match a whole value, ignoring case: **Title**, **Channel** (a YouTube channel or podcast name), **Type** (`YouTube` or `Podcast`) and **Tags**. Each filter is Any, Required or Exclude; all Any filters form one either-or group.
- Ranges include both bounds: **Published** (UTC), **Duration**, **Views**, **Likes** and **Comments**. Podcast episodes have no counts, and a live stream or premiere that has not finished has no duration; these match a range only when missing values are included.
- Sorting is by relevance while searching and otherwise by newest first. It can also sort by published date, title, channel, duration, views, likes or comments, ascending or descending. Missing values sort last in both directions, and ties are ordered by ID.

## Browse page

`/subscriptions` lists YouTube videos and podcast episodes together and works like the Albums and Tracks pages:

- The search box suggests titles, channels and podcasts, types and tags from the whole library, each with its count. Choosing a suggestion adds a filter chip; choosing a title opens it. Typed text applies on Enter as a search. **AI search** and dictation are in the same box. Filter chips cycle between Any, Required and Exclude.
- **Filters** holds **Titles only**, the ranges (Published, Duration, Views, Likes, Comments) and, in the list view, the columns.
- Grid and list views. The results area takes the full height and is the only scroller; it reserves the height of every result and shows a placeholder for each row or card whose page has not loaded, with **Retry** for a failed page. Only the pages near the visible rows are requested, 100 items at a time.
- The list is the shared compact table: thumbnail link, Title, Channel, Type, Published, Duration, Views, Likes, Comments and Tags. Columns can be shown, hidden and resized; widths are saved in the browser. Headers of sortable columns sort.
- A YouTube item shows its thumbnail with the length, or Live or Upcoming. An episode shows its own artwork, or the show's. Missing values show "-". A release date known only to the month or year shows only that much.
- Selecting an item opens a drawer with its channel or podcast (which filters by it), type, dates, length, counts, tags (each a filter), description and a link to YouTube or Spotify. `?item=<id>` opens an item directly, reading it on its own when it is outside the loaded rows.
- The URL carries `q`, `fields`, `filters`, `ranges`, `sortBy`, `direction`, `view` (`grid` or `list`), `columns` and `item`. The last view, search, filters and sort are remembered in the browser and restored when the page is opened without parameters.
- With nothing synced, the page says so and links to Imports.

`/subscriptions/channels` lists subscribed channels and saved podcasts in the shared table, filterable by name and type and sortable by name, type, stored items, latest item and subscribers or episodes. Each name opens the browse page filtered to that source.

## API

Every endpoint requires the owner session and reads stored rows only.

| Endpoint                                                                                                   | Purpose                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/subscriptions?q&fields&filters&ranges&sortBy&direction&page&size`                             | A page of videos and episodes from subscribed sources. `filters` and `ranges` are JSON arrays; `size` is at most 100. |
| `GET /api/v1/subscriptions/facets?q&limitPerField`                                                         | Title, channel, type and tag filter suggestions, labelled `Channel: Name`, with counts over the whole library.        |
| `GET /api/v1/subscriptions/fields`                                                                         | The browse fields for the filter panel and columns.                                                                   |
| `GET /api/v1/subscriptions/sources?type`                                                                   | Subscribed channels and podcasts with their stored item counts.                                                       |
| `GET /api/v1/subscriptions/:id`                                                                            | One video or episode of a subscribed source.                                                                          |
| `GET` and `POST /api/v1/subscriptions/sync/:provider`, `PUT /api/v1/subscriptions/sync/:provider/settings` | Sync status, start or resume a sync, and the schedule, for `youtube` or `spotify`.                                    |

`/api/v1/youtube` holds only the YouTube account connection: `POST /authorize`, the public `GET /callback`, `GET /complete` and `DELETE /account`.

## What is stored

| Table                 | Rows                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription_source` | One per channel or podcast: provider ID, type, title, handle, description, avatar URL, subscriber count, the podcast's episode total or the channel's video count, the channel's video count at its last read, whether it is still subscribed, and whether its history has been read. |
| `subscription_item`   | One per video or episode: provider ID, source, type, title, description, tags, publish time and its precision, duration, live status, the three counts, episode artwork URL and the search text.                                                                                      |
| `subscription_short`  | One per YouTube Short a sync has seen: video ID, channel and the run that first recorded it.                                                                                                                                                                                          |
| `subscription_sync`   | One sync checkpoint per account and provider.                                                                                                                                                                                                                                         |

Video thumbnails are loaded from YouTube by the browser and are not stored. Watch history, playlists and comments are not read.

Migration 0023 renamed the YouTube tables to these and marked every stored row as YouTube. It changes only the catalog, so it does not rewrite stored videos. Before applying it, make sure no YouTube sync job is queued or running, and do not run old and new server code against the same database. A paused or unfinished sync resumes from its checkpoint after the upgrade.

Migration 0025 adds the video count at a channel's last read. The first sync started after it reads every channel as before and records the counts; later syncs skip unchanged channels.

## Verification

- `integration/youtube-sync.integration.ts` runs the connection, the sync through the job dispatcher and the library search over the synced videos against a fake YouTube API and a temporary database. It covers chained jobs, incremental syncs, unchanged channels skipped without a Shorts or uploads request, Shorts left out and removed, renamed and unsubscribed channels, a podcast source left untouched by the YouTube sync, both quota pauses, scheduled and manual resume, failure, cancellation, token renewal, a rejected sign-in, the schedule intervals, search syntax, filters, sorting and paging, migration 0021, and migration 0023 applied to a database holding a paused sync that then resumes.
- `integration/spotify-podcast-sync.integration.ts` runs the podcast sync through the job dispatcher and the Spotify request gate against a fake Spotify API and a temporary database. It covers chained jobs, an unchanged sync that makes only the saved-podcast requests, incremental and oldest-first reads, release-date precision, an unsaved podcast beside YouTube channels, a removed podcast, empty entries, a rate-limit pause and resume, a rejected token, failure, cancellation, a list that changes while it is read, the schedule intervals and podcast search and type filters.
- `integration/subscriptions-library.integration.ts` browses synthetic YouTube and podcast rows: search across both types, every filter field and mode, inclusive ranges and missing values, every sort in both directions across pages, facets beyond the first page, sources and single items.
- Unit tests cover the query and AI plan schemas, the API's authentication and validation, and the AI plans.
- Navigation tests (`utils/media-scope.test.ts`, `utils/youtube-redirects.test.ts`, `components/media-workspaces.test.tsx`, `components/job-activity.test.tsx`, `components/youtube-sync.test.tsx`, `components/subscription-sync.test.tsx`) and `integration/job-history.integration.ts` cover the library scope, old-link redirects, the Imports pages and sync panels, Jobs and Providers in this library and the activity group.
- Web tests (`utils/subscriptions.test.ts`, `components/subscription-browser.test.tsx`) cover the browse URL state, chip labels, title suggestions, date precision, AI plans applied to the URL, the list as the shared compact table with placeholder rows, grid cards, the empty library and the channels list with both types.

No test makes a Google or Spotify request.
