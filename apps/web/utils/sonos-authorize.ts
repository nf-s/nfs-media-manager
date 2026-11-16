import {
  SonosAuthorizeInputSchema,
  SonosAuthorizeResultSchema,
} from '@repo/schemas/sonos'
import { fetchApiData } from './api'

/** Asks the server for a Sonos sign-in URL and checks that it leads to Sonos. */
export async function sonosAuthorizationUrl(
  apiBaseUrl: string,
): Promise<string> {
  const result = await fetchApiData(
    apiBaseUrl,
    '/api/v1/sonos/authorize',
    SonosAuthorizeResultSchema,
    {
      method: 'POST',
      body: JSON.stringify(SonosAuthorizeInputSchema.parse({})),
    },
  )
  const url = new URL(result.url)
  if (url.protocol !== 'https:' || url.hostname !== 'api.sonos.com')
    throw new Error('The authorization URL was not a Sonos URL.')
  return url.href
}

/** The callback address to register on the Sonos integration key; Sonos requires HTTPS. */
export function sonosCallbackUrl(apiBaseUrl: string, appUrl: string) {
  try {
    const callback = new URL('/api/v1/sonos/callback', apiBaseUrl || appUrl)
    return callback.protocol === 'https:' ? callback.href : null
  } catch {
    return null
  }
}
