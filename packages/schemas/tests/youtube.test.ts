import { describe, expect, it } from 'vitest'
import {
  YoutubeCallbackSchema,
  youtubeChannelUrl,
  youtubeThumbnailUrl,
  youtubeVideoUrl,
} from '../src/youtube'

const CHANNEL = 'UCabcdefghijklmnopqrstuv'

describe('YouTube account connection', () => {
  const state = 'a'.repeat(43)

  it('accepts a callback with exactly one of a code or an error', () => {
    expect(YoutubeCallbackSchema.safeParse({ state, code: 'c' }).success).toBe(
      true,
    )
    expect(
      YoutubeCallbackSchema.safeParse({ state, error: 'access_denied' })
        .success,
    ).toBe(true)
    expect(YoutubeCallbackSchema.safeParse({ state }).success).toBe(false)
    expect(
      YoutubeCallbackSchema.safeParse({ state, code: 'c', error: 'e' }).success,
    ).toBe(false)
    expect(
      YoutubeCallbackSchema.safeParse({ state: 'short', code: 'c' }).success,
    ).toBe(false)
  })
})

describe('YouTube links', () => {
  it('builds watch, channel and thumbnail URLs from IDs', () => {
    expect(youtubeVideoUrl('abcdefghijk')).toBe(
      'https://www.youtube.com/watch?v=abcdefghijk',
    )
    expect(youtubeChannelUrl(CHANNEL)).toBe(
      `https://www.youtube.com/channel/${CHANNEL}`,
    )
    expect(youtubeThumbnailUrl('abcdefghijk')).toBe(
      'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg',
    )
  })
})
