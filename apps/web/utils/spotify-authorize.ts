import {
  SpotifyAuthorizeInputSchema,
  SpotifyAuthorizeResultSchema,
} from '@repo/schemas/spotify'
import type { z } from 'zod'
import { fetchApiData } from './api'

/** Asks the server for a Spotify consent URL and checks that it leads to Spotify. */
export async function spotifyAuthorizationUrl(
  apiBaseUrl: string,
  input: z.infer<typeof SpotifyAuthorizeInputSchema>,
): Promise<string> {
  const result = await fetchApiData(
    apiBaseUrl,
    '/api/v1/spotify/authorize',
    SpotifyAuthorizeResultSchema,
    {
      method: 'POST',
      body: JSON.stringify(SpotifyAuthorizeInputSchema.parse(input)),
    },
  )
  const url = new URL(result.url)
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.spotify.com')
    throw new Error('The authorization URL was not a Spotify URL.')
  return url.href
}
