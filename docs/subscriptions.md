# Subscriptions

The Subscriptions library stores the channels one YouTube account subscribes to and the videos they have uploaded, and is built to hold saved Spotify podcasts and their episodes as the same kind of record. A record's **type** follows its provider: **YouTube** or **Podcast**. Search runs locally against stored rows; YouTube itself cannot search across only your subscriptions.

The library is separate from albums, films and tracks. It has no metadata scrapes or tags of its own; a video's tags are the uploader's.

Current state:

- The YouTube **Videos** and **Subscriptions** pages read this library through the `/api/v1/youtube` endpoints.
- The `/api/v1/subscriptions` endpoints browse videos and episodes together. No page uses them yet.
- Podcast sync is not available yet. `/api/v1/subscriptions/sync/spotify` answers 404.

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
5. Open **YouTube → Subscriptions** and choose **Connect YouTube**. Approve the request to view your YouTube account. The app requests only the [`youtube.readonly`](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps) scope and cannot change subscriptions, playlists or videos.

Connecting is an explicit authenticated request. The public callback only relays Google's parameters to `/api/v1/youtube/complete` on the configured API address; completion requires the same signed-in session, a single-use state value, PKCE and a ten-minute expiry. Access and refresh tokens are stored encrypted on the server and never sent to the browser. **Disconnect** deletes the stored tokens and keeps the stored channels and videos; it does not remove the app from the Google account's third-party access list.

## YouTube sync

Choose **Sync now** on the YouTube Subscriptions page. Opening a page only reads stored data.

The sync is a YouTube job with no media item. It appears in the album library's Jobs as **YouTube subscription sync**, with its progress log, cancel and retry. No page needs to stay open.

- A sync first reads the subscription list, then each subscribed channel's uploads, 50 per request.
- The first sync reads every channel's full upload history. Later syncs read each channel from its newest upload and stop at the first page that contains a video already stored, usually one page.
- One job runs at most 300 steps or eight minutes, then succeeds and queues a follow-on job. A long sync is a chain of jobs.
- A page of videos and its checkpoint are saved together. A paused, failed or cancelled run resumes at the next unread page.
- Channels you have unsubscribed from leave the channel list and the search. Their stored videos return if you subscribe again. The YouTube sync never changes podcast records.
- Videos that are private or deleted when read are skipped. A video deleted after it was stored is not removed.
- View, like and comment counts are as of the last sync that read the video. Each sync refreshes the newest page of every channel; older videos keep the counts from when they were first read.
- Cancelling the job stops the sync before the next request and discards a page still in flight.

### Quota

The [YouTube Data API](https://developers.google.com/youtube/v3/determine_quota_cost) allows 10,000 units a day by default, and every request the sync makes costs one unit. The app's own limit is 9,000 requests a day, adjustable in **Providers → YouTube → Settings**; raising it cannot raise the Google quota.

Each 50 uploads cost two requests. A first sync of 300 channels with 500 uploads each is about 6,000 requests; channels with long histories can take the first sync past one day. Later syncs cost about two requests per channel.

When the daily limit or the Google quota is reached, the sync **pauses** instead of failing. Stored videos are kept and searchable. The schedule resumes a paused sync after the time shown on the page; with the schedule off, choose **Resume sync** after that time. The app's daily count resets at midnight UTC and Google's quota at midnight Pacific time.

Any other error fails the job. A failed job is not retried automatically: retry it in Jobs or choose **Resume sync**. If Google rejects the saved sign-in, connect the account again, then resume.

In the hosted deployment the YouTube dispatcher starts unpaused, unlike a metadata provider's, because it has no backlog of media items: its only jobs are syncs the owner starts or the schedule queues. A failed job can stop it. **Sync now**, **Resume sync** and retrying the job restart it; a deliberate pause, a cooldown and an access halt are not cleared, and the schedule never restarts it.

### Schedule

The page sets how often a sync is queued: off, every 1, 3 or 6 hours, daily (the default) or weekly, measured from the last completed sync. Both runtimes check every five minutes when scraping is enabled.

The schedule follows a completed sync and resumes a paused one. It does not start the first sync, and it does not resume a failed or cancelled run. It queues nothing while a sync job is queued or running, or while YouTube is cooling down or halted.

## Searching

Search runs against stored videos and episodes only and makes no provider requests.

- Every word must match. Word forms are matched, so `orbit` finds "orbits" and "orbital", and a partial word matches the start of a word, so `depres` finds "depression".
- `"quoted phrases"` match adjacent whole words, `or` matches either side, and a leading `-` excludes a word. Other punctuation has no special meaning.
- A search matches the title, tags, channel or podcast name and description. **Titles only** leaves out the description.
- Common words such as "the" are ignored. A search made only of common words or punctuation, such as "the who", falls back to the literal text in the title or channel name.

[AI search](ai-search.md#subscriptions) sets the search, filters and sort from a typed or dictated request.

### Filters and sorting

Filters follow the [browse filter rules](requirements/search.md) of the other libraries:

- Text filters match a whole value, ignoring case: **Title**, **Channel** (a YouTube channel or podcast name), **Type** (`YouTube` or `Podcast`) and **Tags**. Each filter is Any, Required or Exclude; all Any filters form one either-or group.
- Ranges include both bounds: **Published** (UTC), **Duration**, **Views**, **Likes** and **Comments**. Podcast episodes have no counts, and a live stream or premiere that has not finished has no duration; these match a range only when missing values are included.
- Sorting is by relevance while searching and otherwise by newest first. It can also sort by published date, title, channel, duration, views, likes or comments, ascending or descending. Missing values sort last in both directions, and ties are ordered by ID.

The YouTube Videos page keeps its own channel picker and duration buckets: under 4 minutes, 4 to 20 minutes, and over 20 minutes.

## API

Every endpoint requires the owner session and reads stored rows only.

| Endpoint                                                                                                   | Purpose                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/subscriptions?q&fields&filters&ranges&sortBy&direction&page&size`                             | A page of videos and episodes from subscribed sources. `filters` and `ranges` are JSON arrays; `size` is at most 100. |
| `GET /api/v1/subscriptions/facets?q&limitPerField`                                                         | Title, channel, type and tag filter suggestions, labelled `Channel: Name`, with counts over the whole library.        |
| `GET /api/v1/subscriptions/fields`                                                                         | The browse fields for the filter panel and columns.                                                                   |
| `GET /api/v1/subscriptions/sources?type`                                                                   | Subscribed channels and podcasts with their stored item counts.                                                       |
| `GET /api/v1/subscriptions/:id`                                                                            | One video or episode of a subscribed source.                                                                          |
| `GET` and `POST /api/v1/subscriptions/sync/:provider`, `PUT /api/v1/subscriptions/sync/:provider/settings` | Sync status, start or resume a sync, and the schedule, for `youtube`.                                                 |

`/api/v1/youtube` keeps the account connection and the endpoints the YouTube pages use.

## What is stored

| Table                 | Rows                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subscription_source` | One per channel or podcast: provider ID, type, title, handle, description, avatar URL, subscriber count, the podcast's episode total, whether it is still subscribed, and whether its history has been read. |
| `subscription_item`   | One per video or episode: provider ID, source, type, title, description, tags, publish time and its precision, duration, live status, the three counts, episode artwork URL and the search text.             |
| `subscription_sync`   | One sync checkpoint per account and provider.                                                                                                                                                                |

Video thumbnails are loaded from YouTube by the browser and are not stored. Watch history, playlists and comments are not read.

Migration 0023 renamed the YouTube tables to these and marked every stored row as YouTube. It changes only the catalog, so it does not rewrite stored videos. Before applying it, make sure no YouTube sync job is queued or running, and do not run old and new server code against the same database. A paused or unfinished sync resumes from its checkpoint after the upgrade.

## Verification

- `integration/youtube-sync.integration.ts` runs the connection, the sync through the job dispatcher and the YouTube search against a fake YouTube API and a temporary database. It covers chained jobs, incremental syncs, renamed and unsubscribed channels, a podcast source left untouched by the YouTube sync, both quota pauses, scheduled and manual resume, failure, cancellation, token renewal, a rejected sign-in, the schedule intervals, search syntax, filters, sorting and paging, migration 0021, and migration 0023 applied to a database holding a paused sync that then resumes.
- `integration/subscriptions-library.integration.ts` browses synthetic YouTube and podcast rows: search across both types, every filter field and mode, inclusive ranges and missing values, every sort in both directions across pages, facets beyond the first page, sources and single items.
- Unit tests cover the query and AI plan schemas, the API's authentication and validation, and the AI plans.

No test makes a Google or Spotify request.
