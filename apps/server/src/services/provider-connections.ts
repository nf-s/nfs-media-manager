import { getSonosAccountStatus } from '@/services/sonos-oauth'
import { getSpotifyAccountStatus } from '@/services/spotify-oauth'
import { getYoutubeAccountStatus } from '@/services/youtube-oauth'

interface AccountConnection {
  /** The app credentials for signing in are saved. */
  configured: boolean
  connected: boolean
}

// Providers whose account is signed in with OAuth. Sign-in and disconnect
// stay with their existing flows; this only reads whether they are connected.
const accountConnections = new Map<
  string,
  (userId: string) => Promise<AccountConnection>
>([
  ['spotify', getSpotifyAccountStatus],
  ['youtube', getYoutubeAccountStatus],
  ['sonos', getSonosAccountStatus],
])

/** Providers with account-level syncs but no OAuth sign-in. */
const accountSyncProviders = new Set(['lastfm'])

export function hasAccountSignIn(provider: string): boolean {
  return accountConnections.has(provider)
}

export function isAccountProvider(
  provider: string,
  mediaTypes: readonly string[],
): boolean {
  return (
    mediaTypes.length === 0 ||
    accountConnections.has(provider) ||
    accountSyncProviders.has(provider)
  )
}

export async function readAccountConnection(
  provider: string,
  userId: string,
): Promise<AccountConnection | null> {
  const read = accountConnections.get(provider)
  if (!read) return null
  const status = await read(userId)
  return { configured: status.configured, connected: status.connected }
}
