# Spotify Playback

Optional in-app playback of library albums and tracks through a connected Spotify Premium account. It is off until connected in Providers. Without it, every Spotify link still opens in Spotify.

## Turning it on

1. Configure Spotify and its redirect URI as described in [Spotify albums and CSV imports](spotify-album-imports.md#account-setup).
2. Open **Providers → Spotify → Settings** and choose **Connect playback**. Spotify asks for consent, then returns to the same page.

Connecting requests the read-only [library and playlist scopes](spotify-album-imports.md#account-setup) plus the playback scopes `streaming`, `user-read-email`, `user-read-private`, `user-read-playback-state` and `user-modify-playback-state`. **Turn off playback** reconnects without the playback scopes, keeping the library and playlist scopes and, if it was granted, [permission to change playlists](tracks-and-playlists.md#adding-an-album-to-a-playlist). Connecting from **Imports → Spotify** keeps whichever access is already granted.

Requirements:

- A Spotify Premium account. Playing in the browser and controlling other devices both need it.
- The Spotify developer app must allow the Web Playback SDK, and in development mode the account must be on the app's user list.
- A browser that supports protected media in a secure context (HTTPS or `localhost`). Other devices can still be controlled when the browser cannot play.

## Using it

- **Grid tiles** show play and add-to-queue buttons over the artwork on hover or focus. Touch devices show the play button only. Album list and table views have no play controls; the Tracks table, the track drawer and the playlist drawer have play and add-to-queue controls on each track.
- **The album drawer** has **Play** and **Add to queue** in its heading. In **Tracks**, a track number plays the album from that track, and each row can queue the single track.
- **The player dock** appears at the bottom once something is played or queued, or while the account is already playing on another device: current track, previous, play/pause, next, a seek bar, the queue, the device, volume and a link to the track in Spotify. Selecting the current track opens its album. On phones the dock is a mini-player above the tab bar that opens a player sheet.
- **Queue:** an album plays in full, then the next queued album or track starts. Entries can be played now, reordered, removed or cleared. The queue is kept in the open page only; reloading clears it. It is the app's own queue, separate from Spotify's.
- **Play on:** **This browser** or any device Spotify lists for the account. Playback that another app moves to a different device is followed there, whichever device was chosen here, so controls always go to the device that has the playback. When that device goes quiet, the device chosen here is the target again.
- **Playback started elsewhere:** when the account is playing on another device, for example from the Spotify app on a phone, the dock shows that track and controls that device: play/pause, previous, next, seek and volume. Playing an album here then plays it on that device; choose **This browser** to move it. Queued items do not start on their own after playback the app did not start: press **Next** or play one from the queue. Paused playback on another device is not picked up, and the dock hides again when that playback stops unless something was played or queued here.
- **Devices apps cannot control:** Spotify marks some speakers, TVs and receivers as restricted and accepts no commands for them. Playback there is shown with the transport, seek bar and volume disabled; playing something here starts it in this browser (or the device chosen before), and **Play on** can move playback to another device. Queued items do not start on their own while playback is on such a device, because starting one would take the sound off it: press **Next**. A speaker that a Spotify app plays to over Spotify Connect is typically restricted. To keep control, play in the Spotify app on a computer (or in this browser) and send the computer's sound to the speaker, for example over AirPlay, so Spotify sees the computer as the device.

Albums and tracks without a valid Spotify album URL or track ID have no play controls.

## How it works

`POST /api/v1/spotify/playback/token` (authenticated, same-origin) returns the account's access token and its expiry. The server refreshes it through the Spotify request gate when it is within a minute of expiring. The refresh token, client secret and PKCE verifier never leave the server. The browser keeps the access token in memory only and asks again shortly before it expires. The endpoint answers 422 unless the stored account has every playback scope.

The browser then talks to Spotify directly:

- The Web Playback SDK script loads from `sdk.scdn.co` only when playback is connected, and registers the browser as a Spotify device named **Media Manager**.
- Player commands and device listings go to `api.spotify.com/v1/me/player`. These calls come from the browser, so they do **not** pass through the server's Spotify request gate and are not recorded as provider requests. While something plays on another device, the browser reads the player state every three seconds so the queue can advance and the dock follows changes made elsewhere; playing in the browser reads state from the SDK without Web API polling. While nothing is playing, or playback is paused, a visible page reads the player state every five seconds to notice playback started or resumed elsewhere; a hidden page does not, and checks once when it is shown again. For five seconds after **Play on** moves playback, a report that still names the old device is ignored.

[`apps/web/utils/playback-engine.ts`](../apps/web/utils/playback-engine.ts) owns the queue, the device target and the session rules in [`playback.ts`](../apps/web/utils/playback.ts); it takes the Spotify API, token source and SDK loader as arguments so it runs under test without a browser. [`playback-provider.tsx`](../apps/web/components/playback-provider.tsx) exposes it to the shell, [`player-dock.tsx`](../apps/web/components/player-dock.tsx) and [`play-controls.tsx`](../apps/web/components/play-controls.tsx).

## Failures

- **Spotify disconnected:** the token endpoint or Spotify rejected the account. The dock offers **Reconnect**, which repeats the playback consent.
- **Other errors** (Premium required, device unavailable, rate limited, playback did not start) appear above the dock with **Open in Spotify**. The queue is kept.
- A command is not retried, except that a browser device Spotify has not registered yet is retried twice. Three failed state reads in a row end the session. A failed background check for playback elsewhere is not reported; the next check repeats it.

## Limits

- The queue and the current session do not survive a reload, and two open tabs each have their own.
- No shuffle or repeat controls.
- Playback started elsewhere is shown as Spotify reports it. Whether a device is restricted is Spotify's decision and cannot be changed here. It is not matched to a library album, Spotify's own queue is not shown, and it can take up to five seconds to appear. A change made on another device or in another open copy of the app shows within three to five seconds.
- When another device jumps straight to the end of an album between two state reads, the album can go unnoticed as finished and the next queue entry does not start.
- Tests use a fake SDK player and fake Spotify responses. Audio, the consent round trip and phone browsers are not covered by automated tests.

## Verification

```bash
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/utils/playback.test.ts apps/web/utils/playback-engine.test.ts apps/web/utils/spotify-player-api.test.ts apps/web/utils/album-links.test.ts apps/web/components/play-controls.test.tsx apps/web/components/player-dock.test.tsx apps/web/components/spotify-playback-setting.test.tsx
pnpm --filter @repo/server exec vitest run src/services/__tests__/spotify-oauth.test.ts src/routes/__tests__/spotify-imports-api.test.ts
```

References: [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) and the Web API [player endpoints](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback).
