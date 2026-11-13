import {
  YoutubeAuthorizeInputSchema,
  YoutubeAuthorizeResultSchema,
} from '@repo/schemas/youtube'
import { fetchApiData } from './api'

/** Asks the server for a Google consent URL and checks that it leads to Google. */
export async function youtubeAuthorizationUrl(
  apiBaseUrl: string,
): Promise<string> {
  const result = await fetchApiData(
    apiBaseUrl,
    '/api/v1/youtube/authorize',
    YoutubeAuthorizeResultSchema,
    {
      method: 'POST',
      body: JSON.stringify(YoutubeAuthorizeInputSchema.parse({})),
    },
  )
  const url = new URL(result.url)
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com')
    throw new Error('The authorization URL was not a Google URL.')
  return url.href
}
