# Last.fm scrobble history

The app can store every scrobble from one Last.fm account and use it for album listening charts, per-track counts and browse filters. This is separate from the [Last.fm album metadata provider](album-providers.md), which looks up one album per job.

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

The page sets how often a sync is queued: off, every 6 hours, daily (the default) or weekly, measured from the last completed sync. The hosted deployment checks hourly and the Node server every five minutes, when scraping is enabled.

The schedule only follows a completed sync. It does not start the first sync, and it does not resume a failed or cancelled run: resolve that run first. It queues nothing while a sync job is queued or running, or while Last.fm is cooling down.

Last.fm publishes no numeric rate limit. Its [API introduction](https://www.last.fm/api/intro) asks for an identifiable User-Agent and warns against continuously making several calls per second; the sync sends a User-Agent and stays at one request per second. The [API terms](https://www.last.fm/api/tos) limit stored Last.fm data to 100 MB without written consent, so only names, MusicBrainz IDs and timestamps are stored, not artwork or URLs.

## What is stored

One row per scrobble: UTC timestamp, artist, album and track names as Last.fm returned them, any MusicBrainz IDs, and a link to the matching library album.

- Last.fm has no scrobble ID. A scrobble is identified by account, timestamp, artist, track and album, so two identical scrobbles in the same second are stored once.
- The now-playing entry has no timestamp and is ignored.
- Scrobbles dated before 2002 come from devices with an unset clock and are ignored.
- Scrobbles edited or deleted on Last.fm after they were stored are not corrected. Last.fm provides no change feed.

## Linking scrobbles to albums

After each sync, a scrobble is linked to a library album when the album title matches and the scrobble's artist is one of the album's credited artists. Matching ignores case and repeated spaces. Links are recomputed on every sync, so albums added later pick up their existing scrobbles. **Relink** on the page does the same from stored scrobbles without contacting Last.fm.

The page lists every scrobbled artist and album name with its scrobble count, most played first, and one of these outcomes:

| Outcome                       | Meaning                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Linked                        | Shows the library album.                                                                                               |
| Links at next sync            | Exactly one album matches but the link has not been applied yet, for example an album added since the last sync.       |
| Several albums match          | More than one library album has this title and artist. The candidates are listed.                                      |
| Title matches, artist differs | A library album has this title but does not credit the scrobbled artist. The candidates are listed with their artists. |
| No album with this title      | Includes different edition titles, such as a deluxe edition.                                                           |
| Scrobbled without an album    | Last.fm stored no album name.                                                                                          |

A summary gives the number of names and scrobbles for each outcome. The list filters by outcome and searches artist and album names. Unlinked scrobbles remain stored. There is no manual link; to link a name, correct the library album's title or credited artists and relink.

## In the app

- **Album → Listening** shows total scrobbles, first and last listen, and scrobbles per year or month for the album or one of its tracks. It lists the scrobbled names linked to the album, and unlinked names that resemble it: the same title under another artist, or a credited artist with a title that starts with the album's title or the reverse.
- **Album → Tracks** shows each track's scrobble count. Track counts match scrobbled track names to the album's track titles.
- **Browse** gains three album fields, recomputed at the end of every sync:
  - `Last listened`: date of the most recent linked scrobble.
  - `Scrobbles, last year` and `Scrobbles, last 5 years`: linked scrobbles in a rolling window ending at the last sync.
- `Scrobbles` is set to the linked scrobble count for albums that have linked scrobbles. Other albums keep the count reported by the Last.fm album provider. A later Last.fm album metadata job writes Last.fm's own album count again until the next sync.

To find albums played often but not recently, filter `Scrobbles` with a minimum of 100 and `Last listened` with a maximum date five years ago, or `Scrobbles, last 5 years` with a maximum of 0.

## Verification

`integration/lastfm-scrobbles.integration.ts` runs the sync through the job dispatcher with mocked HTTP and a temporary database. It covers chained jobs, the fixed window, failure and resume from Jobs and from the page, cancellation, overlap without duplicates, the schedule, album linking, the link report, browse fields and the album listening report. It makes no Last.fm requests.
