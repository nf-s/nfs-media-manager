# Sonos

Optional connection to a Sonos account through the Sonos cloud Control API. It is for playing Spotify on Sonos rooms: Spotify reports most Sonos speakers as restricted devices and refuses app commands for them (see [Spotify playback](spotify-playback.md#using-it)), so the player starts and controls playback on a room through Sonos instead.

With the connection, a Sonos room is chosen under **Play on** like any other device. Albums, tracks and the queue then play on that room, and the dock's controls work for it. Playback that a Spotify app put on a room is controlled too.

## Setup

1. Create a control integration on [developer.sonos.com](https://developer.sonos.com/) and generate a key. The integration name is what Sonos shows on its sign-in screen.
2. Register the redirect URI `https://<app host>/api/v1/sonos/callback` on the key. Sonos only sends sign-in results to a public HTTPS address, so connecting works from the deployed app, not from a local development server.
3. In **Providers → Sonos → Settings** (`/providers/sonos?tab=settings`), save the integration key, secret and the same redirect URI. They can also come from `SONOS_CLIENT_ID`, `SONOS_CLIENT_SECRET` and `SONOS_REDIRECT_URI`.
4. In the player, open **Play on** and choose **Connect Sonos** under **Connections**, then sign in with the Sonos account. Sonos returns to the app and the player reports the result.

**Connections** shows whether Sonos is set up, connected or not. **Disconnect** deletes the stored tokens. Access can also be revoked in the Sonos app.

## Rooms

**Play on** lists each group of the account's households under **Sonos rooms**: its rooms (coordinator first), whether it is playing, paused or idle, and the music service and track Sonos reports. Opening **Play on** asks the account’s playback driver for a fresh list. Menus opened together share one read. Each page shows the result or offers a retry.

Choosing a room makes it the playback device. It is marked **Playing here**, the device button shows the **SONOS** mark with the room's name, and the choice is remembered in the browser. What is playing moves with the choice: the current track starts on the room at the same position with the tracks due after it, and the device it came from is paused. Choosing **This browser** or another device moves it back the same way. The room is part of the [saved session](spotify-playback.md#the-shared-session): a reloaded page, or another signed-in browser, shows what the room plays and carries on loading its queue without restarting the track.

A room can be chosen once the Spotify account its household plays with is known. Sonos shows that account only in what a room is playing or has loaded, so Spotify has to have played on one room of the household once, from the Spotify app or the Sonos app. The server then stores the account's identifiers with the Sonos connection and every room of that household can be chosen. Until then the rooms are listed without a button, with a line saying so.

## Playing on a room

- Playing an album, a track or a queue entry starts it on the room. The app loads it into the room's own Sonos queue with the household's Spotify account; no Spotify app or Spotify Connect session is involved.
- A track is followed in the room's queue by the tracks due after it, up to 10 ahead, added one at a time as soon as the source resolves them and topped up as the room plays. Sonos takes about a second for each track added. The room therefore keeps playing with the app closed until those tracks run out.
- Next and Previous move within the room's queue. A Next sent while a track is still being added waits for it. A queue change made here (a track queued, removed or reordered, or shuffle switched) places the track now due directly after the current one. When the room's queue ends and more is due, the next item is started.
- An album plays as an album on the room. Started from a chosen track, it is loaded and skipped forward to that track before it plays. Tracks queued meanwhile play after the album.
- Sonos reports only the URI of a track loaded this way. The dock takes its name, artists, artwork and length from Spotify (one lookup for each track) and, until that answers, the name, artists and artwork from the queued item.
- One page per account holds the server’s playback lease. That page checks a playing room 15 seconds after the previous read finishes, or 30 seconds when paused or idle and visible. It shares the target, track, position, pause state and volume with the other pages, including music started outside Media Manager. A hidden driver keeps checking while it runs a playing queue. A Sonos control used on another page takes over the lease before sending the command. A page that loses contact with the shared session stops making Sonos requests.
- A control shows its expected result at once, before Sonos answers: Next shows the track the room's queue has next, a started track shows as playing once Sonos has accepted it, and pause, seek and volume show as set. The room is read again as soon as Sonos has answered the command. A report read before that answer is discarded, and for six seconds after a start or a skip so is a report that still names the track before. If the command is refused, or the room has not followed by then, the dock returns to what the room reports.
- A refused queue change is reported once and not repeated for 15 seconds.

## Closing every page

The room plays its own queue, so the app can be closed while it plays: the room carries on through the tracks loaded ahead, up to 10. The session is kept on the server with no time limit. The first page opened afterwards, on any computer or phone, reads the room once before it does anything else, and:

- **rejoins it** when the room still holds the queue the app loaded, further along: it plays or is paused on the saved track at or after the saved position, or on a later track the app loaded. Nothing is started or loaded again. The dock shows the room as the device and the track it has reached; the queue and source carry on from there, and pause, Next, Previous and queue changes work on the room. The room's queue is then topped up as usual.
- **leaves the room alone** when it holds anything else: a playlist, a track the app did not load, an earlier track of the queue, or the saved track again from its start. The player shows **This browser** as the device and nothing playing; the queue and source are kept, and the room can be chosen again under **Play on**.
- **does not rejoin** a room that is stopped (Sonos reports it idle or with nothing loaded), which is how a queue that ran out ends. The saved track is shown paused at the saved position, with the room still the device; **Play** starts it there again.

Where the room is not rejoined, the queue is moved on past the tracks of it that the Spotify account's play history lists as played meanwhile, as for a [Spotify device](spotify-playback.md#picking-the-queue-up-again). A room that stops reporting a track while the app is open is treated the same way: the track is kept, shown paused, and the room is followed again when it plays on through the tracks the app loaded.

While the room is read, a line above the dock says **Rejoining the queue on …**; afterwards it says whether the room was rejoined or why not. A successful rejoin message clears after ten seconds. Nothing is sent to the room before that read, including the tracks normally added ahead.

## Scrobbling to Last.fm

Tracks played on a room from here can be scrobbled to a Last.fm account. Sonos plays them from its own queue, outside any Spotify app, so this app reports them itself. It is off until Last.fm is connected for it:

1. In **Providers → Last.fm → Settings** (`/providers/lastfm?tab=settings`), save the API account's **Shared secret** beside its API key, or set `LASTFM_API_SECRET`. Both are shown on the [Last.fm API account](https://www.last.fm/api/accounts) page.
2. In the player, open **Play on** and choose **Connect Last.fm** under **Connections**, then allow the app on Last.fm. Last.fm returns to the app and the player reports the result. **Connections** then shows **Last.fm: Connected** and names the account the tracks go to; **Disconnect** deletes the stored sign-in and any plays not sent yet.

Only a room chosen under **Play on**, playing tracks this app loaded on it, is scrobbled. Nothing else is: not music started on the room from the Sonos or Spotify app, not [playback a Spotify app put on a room](#playback-a-spotify-app-put-on-a-room) that is only controlled from here, and not playback in this browser or on a Spotify device, which Spotify scrobbles itself when the Spotify account is connected to Last.fm.

- A track is scrobbled once half of it, or four minutes, has been heard on the room. Tracks of 30 seconds or less are not scrobbled. The scrobble carries Spotify's name for the track, its first artist and its album, and the time the track began.
- What was heard is counted from the room's position at each read. Between two reads no more is counted than the time that passed, so a track that was skipped or sought through does not count, and a track that ran out between two reads does.
- The page that runs the queue reports the plays. The count for the playing track is saved with the [shared session](spotify-playback.md#the-shared-session), so a reload or another browser taking over carries on with it and does not scrobble the track again.
- A room keeps playing with every page closed. When a page is opened again and the room is [rejoined](#closing-every-page), the tracks it played meanwhile are scrobbled as far as the time since allows, each dated back from the track the room is on by the lengths of the tracks between. A room found stopped at the start of its queue is scrobbled to the end of that queue. A room that is idle, or plays something else, is scrobbled from the Spotify account's play history where the history lists the queue's tracks and [may be read](spotify-playback.md#picking-the-queue-up-again).
- The server keeps each reported play until Last.fm has taken it. A play Last.fm could not be reached for is sent with the next one reported. A play already kept for the same track at about the same time is not kept twice.
- When Last.fm rejects the stored sign-in, **Connections** shows **Not connected** and the plays wait for the account to be connected again.
- Sign-in is Last.fm's web authentication. Last.fm returns to `/api/v1/lastfm/scrobbling/callback/{state}`, which checks the state against the signed-in session before exchanging the token for a session key. The shared secret and session key stay on the server, encrypted like other provider secrets. Saving a different API key ends the connection.
- Scrobbles are signed requests of up to 50 plays and count against the Last.fm provider like its other requests: a rate limit or a refused API key stops them as it stops the [scrobble sync](lastfm-scrobbles.md), and the plays wait. Plays are kept in `lastfm_play` for about two weeks, to recognise a play reported twice.

## Playback a Spotify app put on a room

When Spotify reports playback on a restricted device, the player asks the server for the Sonos group behind it: the group playing the same Spotify track, and where several groups do (an account can have several households), the one named like the Spotify device. Sonos can lag behind Spotify just after playback moves, so when no group plays the track, the only non-idle group with that name is used if it plays from Spotify, and an unanswered lookup is repeated twice, two seconds apart. While it runs, the device button shows a spinner and **Play on** shows **Finding … on Sonos**; a controlled group shows the **SONOS** mark on the device button.

- Found: play/pause, next, previous, seek and volume go to that group, each only when Sonos accepts it for the current playback. Spotify Connect sessions on Sonos may refuse previous; Previous then restarts the track. **Play on** names the group as controlled through Sonos.
- Not found, or Sonos not connected: the dock shows the playback with its controls disabled, as before.
- Track, position and pause state still come from Spotify's player state. The group plays the tracks Spotify was given with the current one ([the queue travels with the playback](spotify-playback.md#using-it)); Next skips to the following one and the app's queue follows.
- Playing an album, track or queue entry, or pressing Next when the group has no track of its own left, starts it on the group through Sonos. The group becomes the chosen room, as under [Playing on a room](#playing-on-a-room), and the Spotify app's session on it ends.
- When the household's Spotify account is not known, nothing new can be started on the group from here: it is refused with a message, the group keeps playing, and Next is off when the group has no track to skip to.
- A refused command shows an error and the group is looked up again with the next report.

## How it works

- Sign-in is the OAuth authorization-code flow with the `playback-control-all` scope. The callback relays to the authenticated `/api/v1/sonos/complete` endpoint, which checks the state against the signed-in session before exchanging the code. The integration secret, access token and refresh token stay on the server, encrypted like other provider secrets. Access tokens last 24 hours and are refreshed when they are within a minute of expiring.
- `GET /api/v1/sonos/rooms` reads `/households`, each household's `/groups`, and each group's `/playback` and `/playbackMetadata` from `api.ws.sonos.com`. Each refresh makes 1 + households + 2 × groups requests, at most four at a time.
- `GET /api/v1/sonos/playback?trackUri=…&device=…` finds the group: households, then all their groups at once, the metadata of every non-idle group at once, then the matched group's playback actions and volume. `POST /api/v1/sonos/groups/{groupId}/command` sends one `play`, `pause`, `next`, `previous`, `seek` or `volume` command. The API checks the browser’s playback lease before admitting room discovery, state reads, commands and queue changes. Requests admitted before a handover can finish. A tab running an older player must reload to regain Sonos controls. Intentional owner API-key reads remain available.
- Control API requests are sent straight to Sonos instead of through the durable provider request gate, whose database bookkeeping took as long as Sonos itself. They are therefore not paced or counted as provider requests. Each call checks the provider halt and cooldown first. A daily quota response pauses requests until 00:00 UTC. For minute quotas the server honors a valid positive retry delay or quota reset. Spike arrests use capped exponential backoff with jitter and honor any longer retry delay. Other 429s use the supplied delay when available and the same backoff otherwise. A rejected token halts requests until the account is connected again. Only the sign-in code exchange still goes through the gate. A token that is not due for a refresh is read without a lock.
- `GET /api/v1/sonos/groups/{groupId}/state` reads the group's `/playback` and `/playbackMetadata`, and `/groupVolume` with `?volume=true` (the player asks for it on every fifth read).
- `POST /api/v1/sonos/groups/{groupId}/content` loads `spotify:track:…` or `spotify:album:…` URIs into the group's queue with Sonos's `playback/content` command, one request per URI in order: `replace` starts a new queue, `append` adds to its end, `next` places items after the current track. `replace` can skip tracks and seek before playing. It answers 409 when the household's Spotify account is not known.
- The household's Spotify account (Sonos's service and account identifiers for it) is read from the metadata of Spotify tracks while listing rooms or finding a group, and stored encrypted with the connection, per household. Disconnecting deletes it.
- A rejected token or refresh asks for a new sign-in. Connecting again clears the provider's access halt.

## Investigating rate limits

The playback driver asks the Media Manager API for room state. The server sends the requests to Sonos. The provider overview counts requests reserved through the provider gate, including the OAuth code exchange. For individual Control API calls, use the API server's request logs.

In the hosted API Worker's **Observability → Logs**, filter on `event = sonos.request` and `status = 429`. Select a result and filter on its `requestId` to see the initiating API route and every Sonos call it caused. The API Worker is configured to persist 100% of application log events. Retention and ingestion limits depend on the Workers plan. For self-hosted Node installations, use the same fields in the API process's JSON-line stdout logs. Local retention depends on the process supervisor. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

| Event              | What it records                                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.request`      | One incoming API request, with route template, method, final HTTP status and elapsed milliseconds. A Sonos rate limit or an existing cooldown can surface here as HTTP 422.                                                                                                                              |
| `sonos.dispatch`   | The server started a fetch to Sonos. Count these events for outbound volume. The matching `sonos.request` result has the same `attemptId`. A dispatch can be the only record of a fetch interrupted when the Worker or process exits.                                                                    |
| `sonos.request`    | One server fetch to the Sonos Control or OAuth API. `operation` identifies the endpoint, `status` records Sonos's HTTP response, and `durationMs` measures time to response headers or a transport failure. A failed fetch has a null status. `retryAfterMs` records a positive delay supplied by Sonos. |
| `sonos.rate-limit` | The 429 classification and the effective cooldown deadline. The attempt ID links this event to the response.                                                                                                                                                                                             |
| `sonos.blocked`    | A call stopped at the local provider gate. `reason` identifies a cooldown or access halt. `retryAt`, when present, is the retry time in Unix milliseconds.                                                                                                                                               |

To find what kept polling, filter the room-state route and group `api.request` by `page` and `visibility`. To count active player pages in a time window, filter successful `api.request` events on `/api/v1/playback/session` and count distinct `page` values. The server records `playbackRole` as `driver` or `follower` on successful heartbeats. The page label changes on reload. A hidden, sleeping or closed page may send no heartbeat. Better Auth’s unexpired session count measures valid sign-ins, which can be shared by several tabs. `stateReason` distinguishes a page running a playing or paused queue, a page watching a room, and a page checking whether to rejoin. These fields describe what the browser knew when it requested the read. Older pages, redirects and other callers can lack the browser fields. The application records route templates and operation names and omits headers, raw URLs, bodies, room and account identifiers, and track details.

## Limits

- Sonos reports the track a room plays, its container (an album or playlist), its position and whether it is playing, paused or idle; it does not report an identifier for the queue itself. Rejoining therefore recognises the app's queue by those tracks: a queue replaced in the Sonos app by the same tracks, further along, is taken for the app's queue. How Sonos reports a queue that has run out (idle on its first track is assumed) and whether it reports a container for tracks loaded one by one have not been checked against a real household.
- Sonos's `playback/content` command is not listed in the Control API reference; its behaviour here was established against a real household. Sonos answers 200 for a wrong or missing Spotify account and then loads nothing, so a room that stays silent after a start usually means the stored account no longer matches (for example after the household's Spotify account was replaced). Play Spotify on a room once from the Spotify app and open **Play on**: the stored account is replaced when the rooms report a different one.
- Spotify does not know about playback Sonos started: the Spotify app does not show it, and it cannot be moved to another device from the Spotify app. Spotify cannot transfer a session to or from a room either, so moving restarts the track at the same position, with a short gap.
- A room started here plays from its own Sonos queue. The Sonos app shows that queue without titles or artists, and "No information available" for the playing track, because Sonos has no details for tracks loaded by ID. Edits made to the queue in the Sonos app are not read back.
- Every Sonos cloud request takes about a second from start to answer. The dock does not wait for it, but the sound follows a control by a second or two, and the room list takes a few seconds to load the first time **Play on** is opened; after that the rooms read before are shown while they are read again.
- Each state read costs two Sonos requests, plus volume every fifth read. At the 15-second playing cadence, routine checks for one continuously playing room use about 12,672 requests in 24 hours before network latency. Room discovery, commands, queue loading and command follow-ups also count toward Sonos’s 20,000 daily requests per integration and user. [Sonos quotas and spike arrests](https://docs.sonos.com/docs/quotas-and-spike-arrests)
- Group IDs can change when rooms are regrouped; a command then fails once and the group is looked up again.
- Scrobbling counts what a page can tell from the room. A room paused for a long time and then skipped through from the Sonos app while no page was open looks like one that played on, and those tracks are scrobbled. Tracks a room played unread are not scrobbled when the room is never rejoined and the play history does not list them, or once they are more than two weeks old, which Last.fm refuses. For an album played as an album, tracks between two reads more than one track apart are not scrobbled.
- Waiting plays are sent only when another play is reported; nothing retries in the background. Plays waiting when a sign-in is rejected go to whichever account is connected next.
- Last.fm's documentation does not state how old a scrobble may be or show its JSON answers. The two-week limit and the answer format follow common client practice and have not been checked against the live service.
- Whether Spotify scrobbles what Sonos plays from its own queue has not been established. If it does for an account, those tracks reach Last.fm twice with this connection; disconnect Last.fm scrobbling here in that case. A track moved part-way between this browser and a room can be scrobbled by both.
- Tests use fake Sonos and Last.fm responses only.

## Verification

```bash
pnpm --filter @repo/server exec vitest run src/lib/sonos-api.test.ts src/services/__tests__/sonos-oauth.test.ts src/lib/lastfm-scrobble-api.test.ts src/services/__tests__/lastfm-scrobbling.test.ts src/routes/__tests__/lastfm-scrobbling-api.test.ts
pnpm --filter @repo/server exec vitest run --config vitest.integration.config.ts integration/lastfm-scrobbling.integration.ts
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/components/player-connections.test.tsx apps/web/components/player-dock.test.tsx apps/web/utils/playback-engine.test.ts apps/web/utils/room-listen.test.ts apps/web/utils/scrobble-reporter.test.ts
```
