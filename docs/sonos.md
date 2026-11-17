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

**Play on** lists each group of the account's households under **Sonos rooms**: its rooms (coordinator first), whether it is playing, paused or idle, and the music service and track Sonos reports. Opening **Play on** reads the list once, with a loading line while it does.

Choosing a room makes it the playback device. It is marked **Playing here**, the device button shows the **SONOS** mark with the room's name, and the choice is remembered in the browser. What is playing moves with the choice: the current track starts on the room at the same position with the tracks due after it, and the device it came from is paused. Choosing **This browser** or another device moves it back the same way. The room is part of the [saved session](spotify-playback.md#the-shared-session): a reloaded page, or another signed-in browser, shows what the room plays and carries on loading its queue without restarting the track.

A room can be chosen once the Spotify account its household plays with is known. Sonos shows that account only in what a room is playing or has loaded, so Spotify has to have played on one room of the household once, from the Spotify app or the Sonos app. The server then stores the account's identifiers with the Sonos connection and every room of that household can be chosen. Until then the rooms are listed without a button, with a line saying so.

## Playing on a room

- Playing an album, a track or a queue entry starts it on the room. The app loads it into the room's own Sonos queue with the household's Spotify account; no Spotify app or Spotify Connect session is involved.
- A track is followed in the room's queue by the tracks due after it, up to 10 ahead, added one at a time as soon as the source resolves them and topped up as the room plays. Sonos takes about a second for each track added. The room therefore keeps playing with the app closed until those tracks run out.
- Next and Previous move within the room's queue. A Next sent while a track is still being added waits for it. A queue change made here (a track queued, removed or reordered, or shuffle switched) places the track now due directly after the current one. When the room's queue ends and more is due, the next item is started.
- An album plays as an album on the room. Started from a chosen track, it is loaded and skipped forward to that track before it plays. Tracks queued meanwhile play after the album.
- Sonos reports only the URI of a track loaded this way. The dock takes its name, artists, artwork and length from Spotify (one lookup for each track) and, until that answers, the name, artists and artwork from the queued item.
- Position, pause state and volume are read from Sonos, every three seconds while something plays and every ten seconds otherwise, while the app is open and visible. A change made in the Sonos app shows within that time.
- A control shows its expected result at once, before Sonos answers: Next shows the track the room's queue has next, a started track shows as playing once Sonos has accepted it, and pause, seek and volume show as set. The room is read again as soon as Sonos has answered the command. A report read before that answer is discarded, and for six seconds after a start or a skip so is a report that still names the track before. If the command is refused, or the room has not followed by then, the dock returns to what the room reports.
- A refused queue change is reported once and not repeated for 15 seconds.

## Closing every page

The room plays its own queue, so the app can be closed while it plays: the room carries on through the tracks loaded ahead, up to 10. The session is kept on the server with no time limit. The first page opened afterwards, on any computer or phone, reads the room once before it does anything else, and:

- **rejoins it** when the room still holds the queue the app loaded, further along: it plays or is paused on the saved track at or after the saved position, or on a later track the app loaded. Nothing is started or loaded again. The dock shows the room as the device and the track it has reached; the queue and source carry on from there, and pause, Next, Previous and queue changes work on the room. The room's queue is then topped up as usual.
- **leaves the room alone** when it holds anything else: a playlist, a track the app did not load, an earlier track of the queue, or the saved track again from its start. The player shows **This browser** as the device and nothing playing; the queue and source are kept, and the room can be chosen again under **Play on**.
- **does not rejoin** a room that is stopped (Sonos reports it idle or with nothing loaded), which is how a queue that ran out ends. The saved track is shown paused at the saved position, with the room still the device; **Play** starts it there again.

Where the room is not rejoined, the queue is moved on past the tracks of it that the Spotify account's play history lists as played meanwhile, as for a [Spotify device](spotify-playback.md#picking-the-queue-up-again). A room that stops reporting a track while the app is open is treated the same way: the track is kept, shown paused, and the room is followed again when it plays on through the tracks the app loaded.

While the room is read, a line above the dock says **Rejoining the queue on …**; afterwards it says whether the room was rejoined or why not. Nothing is sent to the room before that read, including the tracks normally added ahead.

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
- `GET /api/v1/sonos/playback?trackUri=…&device=…` finds the group: households, then all their groups at once, the metadata of every non-idle group at once, then the matched group's playback actions and volume. `POST /api/v1/sonos/groups/{groupId}/command` sends one `play`, `pause`, `next`, `previous`, `seek` or `volume` command. Commands go browser → API → Sonos. Sonos has no error backoff, so one refused command does not block the others.
- Control API requests are sent straight to Sonos instead of through the durable provider request gate, whose database bookkeeping took as long as Sonos itself. They are therefore not paced or counted as provider requests. Each one first reads whether the Sonos provider is halted or cooling down and is refused if so, and a failure is recorded as the gate records it: HTTP 429 starts the one-minute cooldown and a rejected token halts Sonos requests until the account is connected again. Only the sign-in code exchange still goes through the gate. A token that is not due for a refresh is read without a lock.
- `GET /api/v1/sonos/groups/{groupId}/state` reads the group's `/playback` and `/playbackMetadata`, and `/groupVolume` with `?volume=true` (the player asks for it on every fifth read).
- `POST /api/v1/sonos/groups/{groupId}/content` loads `spotify:track:…` or `spotify:album:…` URIs into the group's queue with Sonos's `playback/content` command, one request per URI in order: `replace` starts a new queue, `append` adds to its end, `next` places items after the current track. `replace` can skip tracks and seek before playing. It answers 409 when the household's Spotify account is not known.
- The household's Spotify account (Sonos's service and account identifiers for it) is read from the metadata of Spotify tracks while listing rooms or finding a group, and stored encrypted with the connection, per household. Disconnecting deletes it.
- A rejected token or refresh asks for a new sign-in. Connecting again clears the provider's access halt.

## Limits

- Sonos reports the track a room plays, its container (an album or playlist), its position and whether it is playing, paused or idle; it does not report an identifier for the queue itself. Rejoining therefore recognises the app's queue by those tracks: a queue replaced in the Sonos app by the same tracks, further along, is taken for the app's queue. How Sonos reports a queue that has run out (idle on its first track is assumed) and whether it reports a container for tracks loaded one by one have not been checked against a real household.
- Sonos's `playback/content` command is not listed in the Control API reference; its behaviour here was established against a real household. Sonos answers 200 for a wrong or missing Spotify account and then loads nothing, so a room that stays silent after a start usually means the stored account no longer matches (for example after the household's Spotify account was replaced). Play Spotify on a room once from the Spotify app and open **Play on**: the stored account is replaced when the rooms report a different one.
- Spotify does not know about playback Sonos started: the Spotify app does not show it, and it cannot be moved to another device from the Spotify app. Spotify cannot transfer a session to or from a room either, so moving restarts the track at the same position, with a short gap.
- A room started here plays from its own Sonos queue. The Sonos app shows that queue without titles or artists, and "No information available" for the playing track, because Sonos has no details for tracks loaded by ID. Edits made to the queue in the Sonos app are not read back.
- Every Sonos cloud request takes about a second from start to answer. The dock does not wait for it, but the sound follows a control by a second or two, and the room list takes a few seconds to load the first time **Play on** is opened; after that the rooms read before are shown while they are read again.
- Each state read costs two Sonos requests (three with the volume), so an open, visible player on a playing room makes about 45 a minute.
- Group IDs can change when rooms are regrouped; a command then fails once and the group is looked up again.
- Tests use fake Sonos responses only.

## Verification

```bash
pnpm --filter @repo/server exec vitest run src/lib/sonos-api.test.ts src/services/__tests__/sonos-oauth.test.ts
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/components/player-connections.test.tsx apps/web/components/player-dock.test.tsx apps/web/utils/playback-engine.test.ts
```
