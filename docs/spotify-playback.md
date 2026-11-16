# Spotify Playback

Optional in-app playback of library albums and tracks through a connected Spotify Premium account. It is off until connected from the player bar. Spotify icons open the service; music titles open library details. Play buttons remain visible when playback is disconnected, with a connection explanation.

## Turning it on

1. Configure Spotify and its redirect URI as described in [Spotify albums and CSV imports](spotify-album-imports.md#account-setup).
2. Choose **Connect Spotify** in the player bar at the bottom of the app. Spotify asks for consent, then returns to the app. The bar's prompt can be dismissed; **Player** in the sidebar foot brings it back.

Connecting requests the read-only [library and playlist scopes](spotify-album-imports.md#account-setup) plus the playback scopes `streaming`, `user-read-email`, `user-read-private`, `user-read-playback-state` and `user-modify-playback-state`. **Turn off playback**, under **Play on → Connections** in the player, reconnects without the playback scopes, keeping the library and playlist scopes and, if it was granted, [permission to change playlists](tracks-and-playlists.md#adding-an-album-to-a-playlist). Connecting from **Imports → Spotify** keeps whichever access is already granted.

Requirements:

- A Spotify Premium account. Playing in the browser and controlling other devices both need it.
- The Spotify developer app must allow the Web Playback SDK, and in development mode the account must be on the app's user list.
- A browser that supports protected media in a secure context (HTTPS or `localhost`). Other devices can still be controlled when the browser cannot play.

## Using it

- **Grid tiles** show a visible play button over the artwork. Album and track list/table views also show play controls, and album/playlist track tables use the same controls. Queue actions remain available when playback is connected.
- **The album drawer** has **Play** and **Add to queue** in its heading. In **Tracks**, a track number starts playback from that row using the table's search and sort order, and each row can queue the single track. Returning to this source reopens Tracks with those settings.
- **Playing from a view:** starting playback from a browse view or playlist keeps that view as the playback source, with its filters and sort order. Playback continues through the source even after navigating away or changing the visible view. Starting from another view replaces the source. Unmatched tracks are skipped.
- **The player dock** is always at the bottom once playback is connected: current track, shuffle, previous, play/pause, next, a seek bar, the queue, the device, volume and a link to the track in Spotify. The artwork, track, artists and album are links: to the library album, track and artist when playback came from the library, otherwise to their Spotify pages. On phones the dock is a mini-player above the tab bar that opens a player sheet with the same links.
- **Queue:** manually queued items play in their listed order after the current source track, then playback resumes from the source. A queued album plays in full. Entries can be played now, reordered, removed or cleared. **Back to source** returns to the saved view, and the queue shows up to ten upcoming source tracks below the manual queue. The queue is kept in the open page only; reloading clears it. It is the app's own queue, separate from Spotify's.
- **The queue travels with the playback:** a track is started together with the tracks due after it (queued tracks, then up to 30 from the source), so Spotify keeps playing them on whichever device has the playback, including one moved to from the Spotify app. When the device moves on to the next of those tracks, by itself or through a skip made on it, the queue follows. If the queue was changed since the track started, a device this app can start gets the track now due instead.
- **Shuffle** is remembered in the browser for track lists and playlists, and can be set before anything plays. It shuffles the remaining source without changing the current track or manually queued items; turning it off restores the remaining source order. An album, or a track played from an album or the album library, always starts in order; shuffle can be turned on for it, and that does not change the remembered setting.
- **Play on:** **This browser** or any device Spotify lists for the account, then the account's [Sonos rooms](sonos.md), which play through Sonos and are chosen the same way, and the Spotify and Sonos connections. Playback that another app moves to a different device is followed there as soon as this browser stops playing, so controls always go to the device that has the playback. When that device goes quiet, the device chosen here is the target again.
- **Playback started elsewhere:** when the account is playing on another device, for example from the Spotify app on a phone, the dock shows that track and controls that device: play/pause, previous, next, seek and volume. Playing an album here then plays it on that device; choose **This browser** to move it. Queued items do not start on their own after playback the app did not start: press **Next** or play one from the queue. Paused playback on another device is not picked up.
- **Devices apps cannot start:** Spotify marks some speakers, TVs and receivers as restricted and accepts no commands for them. Playback there is shown with the transport, seek bar and volume disabled, unless a [Sonos connection](sonos.md) controls it; a Sonos room is then also started from here, through Sonos. Nothing new can be started on any other such device: playing an album or track, or a queue entry, is refused with a message and the device keeps its playback. It plays the tracks that were sent with the current one before the playback moved there; queue changes made after that reach it only once playback is started again on another device. **Play on** moves the playback to a device this app can start. A speaker that a Spotify app plays to over Spotify Connect is typically restricted.

Albums and tracks without a valid Spotify album URL or track ID show a disabled play button explaining that no recording is available.

## How it works

`POST /api/v1/spotify/playback/token` (authenticated, same-origin) returns the account's access token and its expiry. The server refreshes it through the Spotify request gate when it is within a minute of expiring. The refresh token, client secret and PKCE verifier never leave the server. The browser keeps the access token in memory only and asks again shortly before it expires. The endpoint answers 422 unless the stored account has every playback scope.

The browser then talks to Spotify directly:

- The Web Playback SDK script loads from `sdk.scdn.co` only when playback is connected, and registers the browser as a Spotify device named **Media Manager**.
- Player commands and device listings go to `api.spotify.com/v1/me/player`. These calls come from the browser, so they do **not** pass through the server's Spotify request gate and are not recorded as provider requests. While something plays on another device, the browser reads the player state every three seconds so the queue can advance and the dock follows changes made elsewhere; playing in the browser reads state from the SDK without Web API polling. While nothing is playing, or playback is paused, a visible page reads the player state every five seconds to notice playback started or resumed elsewhere; a hidden page does not, and checks once when it is shown again. For five seconds after **Play on** moves playback, a report that still names the old device is ignored.

[`apps/web/utils/playback-engine.ts`](../apps/web/utils/playback-engine.ts) owns the queue, the device target and the session rules in [`playback.ts`](../apps/web/utils/playback.ts); it takes the Spotify API, token source and SDK loader as arguments so it runs under test without a browser. [`playback-provider.tsx`](../apps/web/components/playback-provider.tsx) exposes it to the shell, [`player-dock.tsx`](../apps/web/components/player-dock.tsx) and [`play-controls.tsx`](../apps/web/components/play-controls.tsx).

The source belongs to the shared player, so leaving its page does not dispose it. The source captures the view's query and ordering when playback starts; stored library pages and album tracks are loaded as needed for playback and the upcoming list. This reads existing metadata and does not trigger scraping or playlist imports.

A shuffled track list picks tracks spread over the whole list, so it does not read a page for each. The player draws every track it still wants ahead (up to 30) from different rows and reads them in one request, `GET /api/v1/tracks/positions`, which takes the view's query and a comma-separated `positions` list of at most 50 zero-based positions and returns `{ items: [{ position, item }] }`. Rows without a Spotify recording are dropped and another round is drawn for the shortfall; tracks already read are shown as upcoming while that round is read. A list played in order, a playlist and the album library still read pages.

## Failures

- **Spotify disconnected:** the token endpoint or Spotify rejected the account. The dock offers **Reconnect**, which repeats the playback consent.
- **Other errors** (Premium required, device unavailable, rate limited, playback did not start) appear above the dock with a Spotify icon. The queue is kept.
- A command is not retried, except that a browser device Spotify has not registered yet is retried twice. Three failed state reads in a row end the session. A failed background check for playback elsewhere is not reported; the next check repeats it.

## Limits

- The queue, source and current session do not survive a reload, and two open tabs each have their own.
- No repeat control.
- When an album has no stored playable tracks, it plays through Spotify's album context instead; the manual queue resumes after that album and individual upcoming songs cannot be shown.
- Playback started elsewhere is shown as Spotify reports it. Whether a device is restricted is Spotify's decision and cannot be changed here. It is not matched to a library album, Spotify's own queue is not shown, and it can take up to five seconds to appear. A change made on another device or in another open copy of the app shows within three to five seconds.
- A queue change made while a track plays does not change the tracks Spotify was already given. On a device this app can start, the track now due replaces the stale one when the device reaches it, which can be heard for a moment (up to three seconds on another device).
- When another device jumps straight to the end of an album between two state reads, the album can go unnoticed as finished and the next queue entry does not start.
- Tests use a fake SDK player and fake Spotify responses. Audio, the consent round trip and phone browsers are not covered by automated tests.

## Verification

```bash
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/utils/playback.test.ts apps/web/utils/playback-source.test.ts apps/web/utils/playback-engine.test.ts apps/web/utils/spotify-player-api.test.ts apps/web/utils/album-links.test.ts apps/web/components/play-controls.test.tsx apps/web/components/player-dock.test.tsx apps/web/components/player-connections.test.tsx
pnpm --filter @repo/server exec vitest run src/services/__tests__/spotify-oauth.test.ts src/routes/__tests__/spotify-imports-api.test.ts
```

References: [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) and the Web API [player endpoints](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback).
