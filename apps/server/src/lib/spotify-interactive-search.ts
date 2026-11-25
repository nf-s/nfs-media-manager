import { sql } from 'drizzle-orm'
import { DIRECT_PROVIDER_RESPONSE_SOURCE } from '@repo/schemas/provider-response'
import { SPOTIFY_INTERACTIVE_TRACK_SEARCH } from '@repo/schemas/spotify-track-search'
import { providerSnapshot } from '@/schemas/db'
import { createStableId } from './media-utils'

export function spotifyInteractiveSearchMetadata(userId: string) {
  return {
    kind: SPOTIFY_INTERACTIVE_TRACK_SEARCH,
    ownerKey: createStableId(SPOTIFY_INTERACTIVE_TRACK_SEARCH, userId),
  }
}

export const isInteractiveSpotifyTrackSearchResponse = sql`
  ${providerSnapshot.provider} = 'spotify'
  and ${providerSnapshot.source} = ${DIRECT_PROVIDER_RESPONSE_SOURCE}
  and ${providerSnapshot.normalizedData}->>'kind' = ${SPOTIFY_INTERACTIVE_TRACK_SEARCH}
`
