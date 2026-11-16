# Sonos

Optional connection to a Sonos account through the Sonos cloud Control API. It is for controlling Spotify playback that already runs on a Sonos room: Spotify reports most Sonos speakers as restricted devices and refuses app commands for them (see [Spotify playback](spotify-playback.md#using-it)).

This first stage connects the account and lists its rooms. The player does not use the connection yet.

## Setup

1. Create a control integration on [developer.sonos.com](https://developer.sonos.com/) and generate a key. The integration name is what Sonos shows on its sign-in screen.
2. Register the redirect URI `https://<app host>/api/v1/sonos/callback` on the key. Sonos only sends sign-in results to a public HTTPS address, so connecting works from the deployed app, not from a local development server.
3. In **Providers → Sonos → Credentials**, save the integration key, secret and the same redirect URI. They can also come from `SONOS_CLIENT_ID`, `SONOS_CLIENT_SECRET` and `SONOS_REDIRECT_URI`.
4. In **Providers → Sonos → Settings**, choose **Connect Sonos** and sign in with the Sonos account.

**Disconnect Sonos** deletes the stored tokens. Access can also be revoked in the Sonos app.

## Rooms

Settings lists each group of the account's households: its rooms (coordinator first), whether it is playing, paused or idle, the music service and track Sonos reports, and the controls Sonos accepts for that playback (pause, play, next, previous, seek). Opening Settings or choosing **Refresh rooms** reads the list once; nothing polls in the background.

## How it works

- Sign-in is the OAuth authorization-code flow with the `playback-control-all` scope. The callback relays to the authenticated `/api/v1/sonos/complete` endpoint, which checks the state against the signed-in session before exchanging the code. The integration secret, access token and refresh token stay on the server, encrypted like other provider secrets. Access tokens last 24 hours and are refreshed when they are within a minute of expiring.
- `GET /api/v1/sonos/rooms` reads `/households`, each household's `/groups`, and each group's `/playback` and `/playbackMetadata` from `api.ws.sonos.com` through the provider request gate. Each refresh makes 1 + households + 2 × groups requests.
- A rejected token or refresh asks for a new sign-in. Connecting again clears the provider's access halt.

## Limits

- The Control API can start only Sonos favourites, Sonos playlists or radio streams. It cannot start an arbitrary Spotify album, and Spotify cannot move playback onto these speakers, so the app will only control playback started on Sonos from a Spotify app.
- Whether Sonos accepts seek and skip for Spotify Connect playback is shown per group under **Rooms**; it has not been checked against a real household in automated tests.
- Tests use fake Sonos responses only.

## Verification

```bash
pnpm --filter @repo/server exec vitest run src/lib/sonos-api.test.ts src/services/__tests__/sonos-oauth.test.ts
apps/server/node_modules/.bin/tsx --tsconfig apps/web/tsconfig.test.json --test apps/web/components/sonos-connection.test.tsx
```
