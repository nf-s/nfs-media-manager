# YouTube subscriptions

The YouTube library stores the channels one YouTube account subscribes to and the videos those channels have uploaded, then searches them locally. YouTube itself cannot search across only your subscriptions.

Choose **YouTube** in the library selector. It has two pages:

- **Videos**: search, filter and sort the stored videos.
- **Subscriptions**: connect the account, run the sync and list the subscribed channels.

The library is separate from albums and films. It has no metadata providers, imports or tags.

## Setup

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

## Syncing

Choose **Sync now** on the Subscriptions page. Opening either page only reads stored data.

The sync is a YouTube job with no media item. It appears in the album library's Jobs as **YouTube subscription sync**, with its progress log, cancel and retry. No page needs to stay open.

- A sync first reads the subscription list, then each subscribed channel's uploads, 50 per request.
- The first sync reads every channel's full upload history. Later syncs read each channel from its newest upload and stop at the first page that contains a video already stored, usually one page.
- One job runs at most 300 steps or eight minutes, then succeeds and queues a follow-on job. A long sync is a chain of jobs.
- A page of videos and its checkpoint are saved together. A paused, failed or cancelled run resumes at the next unread page.
- Channels you have unsubscribed from leave the channel list and the search. Their stored videos return if you subscribe again.
- Videos that are private or deleted when read are skipped. A video deleted after it was stored is not removed.
- View, like and comment counts are as of the last sync that read the video. Each sync refreshes the newest page of every channel; older videos keep the counts from when they were first read.
- Cancelling the job stops the sync before the next request and discards a page still in flight.

### Quota

The [YouTube Data API](https://developers.google.com/youtube/v3/determine_quota_cost) allows 10,000 units a day by default, and every request the sync makes costs one unit. The app's own limit is 9,000 requests a day, adjustable in **Providers → YouTube → Settings**; raising it cannot raise the Google quota.

Each 50 uploads cost two requests. A first sync of 300 channels with 500 uploads each is about 6,000 requests; channels with long histories can take the first sync past one day. Later syncs cost about two requests per channel.

When the daily limit or the Google quota is reached, the sync **pauses** instead of failing. Stored videos are kept and searchable. The schedule resumes a paused sync after the time shown on the page; with the schedule off, choose **Resume sync** after that time. The app's daily count resets at midnight UTC and Google's quota at midnight Pacific time.

Any other error fails the job. A failed job is not retried automatically: retry it in Jobs or choose **Resume sync**. If Google rejects the saved sign-in, connect the account again, then resume.

### Schedule

The page sets how often a sync is queued: off, every 1, 3 or 6 hours, daily (the default) or weekly, measured from the last completed sync. Both runtimes check every five minutes when scraping is enabled.

The schedule follows a completed sync and resumes a paused one. It does not start the first sync, and it does not resume a failed or cancelled run. It queues nothing while a sync job is queued or running, or while YouTube is cooling down or halted.

## Searching

Search runs against the stored videos only and makes no YouTube requests.

- Every word must match. Word forms are matched, so `orbit` finds "orbits" and "orbital".
- `"quoted phrases"` match adjacent words, `or` matches either side, and a leading `-` excludes a word.
- A search matches the video title, tags, channel name and description. **Titles only**, in Filters, leaves out the description.
- A search made only of common words such as "the who" falls back to the literal text in the title or channel name.

Results sort by relevance while searching, with title, tag and channel-name matches above description matches, and otherwise newest first. They can also sort by published date, views or duration.

Filters:

- **Channels**: one or more subscribed channels, at most 50. Selecting a channel name on a video or on the Subscriptions page filters to that channel.
- **Duration**: under 4 minutes, 4 to 20 minutes, or over 20 minutes. Live streams and premieres that have not finished have no duration and match none of these.
- **Published**: from and to dates, inclusive, in UTC.

Results show as a grid or a list. The title and thumbnail open the video on YouTube. The details panel shows the description, publish time, duration and the view, like and comment counts. Search, filters, sort and view are kept in the URL.

## What is stored

For each channel: ID, title, handle, description, avatar URL and subscriber count. For each video: ID, title, description, tags, publish time, duration, live status and the three counts. Thumbnails are loaded from YouTube by the browser and are not stored. Watch history, playlists and comments are not read.

## Verification

`integration/youtube-sync.integration.ts` runs the connection, the sync through the job dispatcher and the search against a fake YouTube API and a temporary database. It covers chained jobs, incremental syncs, renamed and unsubscribed channels, both quota pauses, scheduled and manual resume, failure, cancellation, token renewal, a rejected sign-in, the schedule intervals, and search syntax, filters, sorting and paging. It makes no Google requests. Unit tests cover the API helpers, the query schema and the web helpers.
