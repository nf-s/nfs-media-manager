# Last.fm scrobble history

The app can store every scrobble from one Last.fm account and use it for album listening charts, per-track counts and browse filters. This is separate from the [Last.fm album metadata provider](album-providers.md), which looks up one album per job.

## Setup

Add the Last.fm API key and username in Providers → Credentials, or set `LASTFM_API_KEY` and `LASTFM_USERNAME`. The account's recent listening must be public; the sync uses the API key only and has no Last.fm sign-in.

## Syncing

Open Imports → Last.fm scrobbles and choose **Sync scrobbles**. Opening the page only reads stored status.

- The first sync reads the full history through [`user.getRecentTracks`](https://www.last.fm/api/show/user.getRecentTracks), 200 scrobbles per request and one request per second. A history of 200,000 scrobbles is 1,000 requests, about 20 minutes.
- Later syncs read from seven days before the previous sync's end, so scrobbles submitted late with older timestamps are picked up. Scrobbles already stored are not duplicated.
- Each run fixes its time window when it starts. New listening during a run cannot shift page numbers; it is picked up by the next sync.
- A page and its checkpoint are saved together. A failed or stopped run resumes at the next unread page with **Resume sync**.
- A rate limit, access error, invalid response or unexpected page stops the run. Nothing retries automatically. Last.fm cooldowns appear under Providers like any other Last.fm request, and album metadata jobs share the same request gate.
- On the Node server the run continues in the background. On the Cloudflare deployment the open page advances the run.
- On the Cloudflare deployment, when scraping is enabled, the hourly schedule also continues a run in progress and starts a new sync once a day after a completed one. The schedule never starts the first sync and never resumes a failed or stopped one.

Last.fm publishes no numeric rate limit. Its [API introduction](https://www.last.fm/api/intro) asks for an identifiable User-Agent and warns against continuously making several calls per second; the sync sends a User-Agent and stays at one request per second. The [API terms](https://www.last.fm/api/tos) limit stored Last.fm data to 100 MB without written consent, so only names, MusicBrainz IDs and timestamps are stored, not artwork or URLs.

## What is stored

One row per scrobble: UTC timestamp, artist, album and track names as Last.fm returned them, any MusicBrainz IDs, and a link to the matching library album.

- Last.fm has no scrobble ID. A scrobble is identified by account, timestamp, artist, track and album, so two identical scrobbles in the same second are stored once.
- The now-playing entry has no timestamp and is ignored.
- Scrobbles dated before 2002 come from devices with an unset clock and are ignored.
- Scrobbles edited or deleted on Last.fm after they were stored are not corrected. Last.fm provides no change feed.

## Linking scrobbles to albums

After each sync, a scrobble is linked to a library album when the album title matches and the scrobble's artist is one of the album's credited artists. Matching ignores case and repeated spaces. If two library albums share the same title and artist, their scrobbles stay unlinked. Scrobbles with a different edition title, such as a deluxe edition, stay unlinked. Links are recomputed on every sync, so albums added later pick up their existing scrobbles.

The status page shows how many stored scrobbles are linked. Unlinked scrobbles remain stored.

## In the app

- **Album → Listening** shows total scrobbles, first and last listen, and scrobbles per year or month for the album or one of its tracks.
- **Album → Tracks** shows each track's scrobble count. Track counts match scrobbled track names to the album's track titles.
- **Browse** gains three album fields, recomputed at the end of every sync:
  - `Last listened`: date of the most recent linked scrobble.
  - `Scrobbles, last year` and `Scrobbles, last 5 years`: linked scrobbles in a rolling window ending at the last sync.
- `Scrobbles` is set to the linked scrobble count for albums that have linked scrobbles. Other albums keep the count reported by the Last.fm album provider. A later Last.fm album metadata job writes Last.fm's own album count again until the next sync.

To find albums played often but not recently, filter `Scrobbles` with a minimum of 100 and `Last listened` with a maximum date five years ago, or `Scrobbles, last 5 years` with a maximum of 0.

## Verification

`integration/lastfm-scrobbles.integration.ts` covers paging, the fixed window, resume after a rate limit, overlap without duplicates, stopping, album linking, browse fields and the album listening report with mocked HTTP and a temporary database. It makes no Last.fm requests.
