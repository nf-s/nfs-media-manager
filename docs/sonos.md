# Sonos

Optional connection to a Sonos account through the Sonos cloud Control API. It is for controlling Spotify playback that already runs on a Sonos room: Spotify reports most Sonos speakers as restricted devices and refuses app commands for them (see [Spotify playback](spotify-playback.md#using-it)).

With the connection, the player dock controls Spotify playback on a Sonos group: start it from a Spotify app (on a phone or computer), or play here and move it to the room in the Spotify app, and the dock's controls work for that group.

## Setup

1. Create a control integration on [developer.sonos.com](https://developer.sonos.com/) and generate a key. The integration name is what Sonos shows on its sign-in screen.
2. Register the redirect URI `https://<app host>/api/v1/sonos/callback` on the key. Sonos only sends sign-in results to a public HTTPS address, so connecting works from the deployed app, not from a local development server.
3. In **Providers → Sonos → Credentials**, save the integration key, secret and the same redirect URI. They can also come from `SONOS_CLIENT_ID`, `SONOS_CLIENT_SECRET` and `SONOS_REDIRECT_URI`.
4. In the player, open **Play on** and choose **Connect Sonos** under **Connections**, then sign in with the Sonos account. Sonos returns to the app and the player reports the result.

**Connections** shows whether Sonos is set up, connected or not. **Disconnect** deletes the stored tokens. Access can also be revoked in the Sonos app.

## Rooms

**Play on** lists each group of the account's households under **Sonos rooms**: its rooms (coordinator first), whether it is playing, paused or idle, and the music service and track Sonos reports. The group the player controls is marked **Controlled here**. Opening **Play on** reads the list once, with a loading line while it does; nothing polls in the background. Rooms are not selectable: neither Spotify nor the Sonos Control API lets this app start Spotify playback on a room.

## In the player

When Spotify reports playback on a restricted device, the player asks the server for the Sonos group behind it: the group playing the same Spotify track, and where several groups do (an account can have several households), the one named like the Spotify device. Sonos can lag behind Spotify just after playback moves, so when no group plays the track, the only non-idle group with that name is used if it plays from Spotify, and an unanswered lookup is repeated twice, two seconds apart. While it runs, the device button shows a spinner and **Play on** shows **Finding … on Sonos**; a controlled group shows the **SONOS** mark on the device button.

- Found: play/pause, next, previous, seek and volume go to that group, each only when Sonos accepts it for the current playback. Spotify Connect sessions on Sonos may refuse previous; Previous then restarts the track. **Play on** names the group as controlled through Sonos.
- Not found, or Sonos not connected: the dock shows the playback with its controls disabled, as before.
- Track, position and pause state still come from Spotify's player state. The group plays the tracks Spotify was given with the current one ([the queue travels with the playback](spotify-playback.md#using-it)); Next skips to the following one and the app's queue follows. Next is off when the group has no track to skip to.
- Nothing new can be started on the group from here: playing an album, track or queue entry is refused with a message, and the group keeps playing. Queue changes made after playback moved to the group do not reach it.
- A refused command shows an error and the group is looked up again with the next report.

## How it works

- Sign-in is the OAuth authorization-code flow with the `playback-control-all` scope. The callback relays to the authenticated `/api/v1/sonos/complete` endpoint, which checks the state against the signed-in session before exchanging the code. The integration secret, access token and refresh token stay on the server, encrypted like other provider secrets. Access tokens last 24 hours and are refreshed when they are within a minute of expiring.
- `GET /api/v1/sonos/rooms` reads `/households`, each household's `/groups`, and each group's `/playback` and `/playbackMetadata` from `api.ws.sonos.com` through the provider request gate. Each refresh makes 1 + households + 2 × groups requests.
- `GET /api/v1/sonos/playback?trackUri=…&device=…` finds the group: households, then all their groups at once, the metadata of every non-idle group at once, then the matched group's playback actions and volume. `POST /api/v1/sonos/groups/{groupId}/command` sends one `play`, `pause`, `next`, `previous`, `seek` or `volume` command. Commands go browser → API → Sonos through the request gate, which has no error backoff for Sonos so one refused command does not block the others.
- A rejected token or refresh asks for a new sign-in. Connecting again clears the provider's access halt.

## Limits

- The Control API can start only Sonos favourites, Sonos playlists or radio streams. It cannot start an arbitrary Spotify album or track, and Spotify accepts no start or transfer onto these speakers from this app, so the app controls playback that a Spotify app put on the room, and the room plays at most the tracks sent with the current one before the move (queued tracks plus up to 30 from the source).
- Group IDs can change when rooms are regrouped; a command then fails once and the group is looked up again.
- Tests use fake Sonos responses only.

## Verification

```bash
pnpm --filter @repo/server exec vitest run src/lib/sonos-api.test.ts src/services/__tests__/sonos-oauth.test.ts
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/components/player-connections.test.tsx apps/web/components/player-dock.test.tsx apps/web/utils/playback-engine.test.ts
```
