import { describe, expect, it } from 'vitest'
import {
  YoutubeCallbackSchema,
  YoutubeSyncInputSchema,
  YoutubeVideoQuerySchema,
  youtubeChannelUrl,
  youtubeThumbnailUrl,
  youtubeVideoUrl,
} from '../src/youtube'

const CHANNEL = 'UCabcdefghijklmnopqrstuv'
const OTHER = 'UC0123456789_-abcdefghij'

describe('YouTube video search query', () => {
  it('defaults to every field, newest-first direction and the first page', () => {
    expect(YoutubeVideoQuerySchema.parse({})).toEqual({
      fields: 'all',
      sortDirection: 'desc',
      page: 1,
      size: 48,
    })
  })

  it('reads URL values, with one or repeated channels', () => {
    expect(
      YoutubeVideoQuerySchema.parse({
        q: '  transfer orbits ',
        fields: 'title',
        channelId: CHANNEL,
        duration: 'long',
        publishedFrom: '2026-01-01',
        publishedTo: '2026-12-31',
        sortBy: 'viewCount',
        sortDirection: 'asc',
        page: '3',
        size: '24',
      }),
    ).toEqual({
      q: 'transfer orbits',
      fields: 'title',
      channelId: [CHANNEL],
      duration: 'long',
      publishedFrom: '2026-01-01',
      publishedTo: '2026-12-31',
      sortBy: 'viewCount',
      sortDirection: 'asc',
      page: 3,
      size: 24,
    })
    expect(
      YoutubeVideoQuerySchema.parse({ channelId: [CHANNEL, OTHER] }).channelId,
    ).toEqual([CHANNEL, OTHER])
  })

  it('rejects values the search cannot use', () => {
    for (const input of [
      { channelId: 'not-a-channel' },
      { channelId: Array.from({ length: 51 }, () => CHANNEL) },
      { q: 'x'.repeat(201) },
      { fields: 'description' },
      { duration: 'tiny' },
      { publishedFrom: '2026-1-1' },
      { publishedTo: '2026-13-40' },
      { sortBy: 'likes' },
      { page: '0' },
      { size: '101' },
    ]) {
      expect(YoutubeVideoQuerySchema.safeParse(input).success).toBe(false)
    }
  })
})

describe('YouTube account and sync inputs', () => {
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

  it('takes no sync options', () => {
    expect(YoutubeSyncInputSchema.safeParse({}).success).toBe(true)
    expect(YoutubeSyncInputSchema.safeParse({ full: true }).success).toBe(false)
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
