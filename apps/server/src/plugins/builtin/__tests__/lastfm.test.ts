import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type MediaPluginScrapeContext } from '@repo/media-plugin-sdk'
import { ZodError } from 'zod'
import { readAlbumProviderDetails } from '@/lib/album-provider-details'
import { lastfmPlugin } from '../lastfm'
import { lastFmSparseAlbumFixture } from './fixtures/lastfm'

function context(payload: unknown): MediaPluginScrapeContext {
  return {
    mediaItemId: 'canonical-album',
    mediaType: 'album',
    existingReferences: [],
    media: { title: 'Example Album', artists: ['Example Artist'] },
    secrets: { apiKey: 'offline-key' },
    request: vi.fn(async () => Response.json(payload)),
    log: vi.fn(async () => undefined),
  }
}

function scrape(input: MediaPluginScrapeContext) {
  if (!lastfmPlugin.scrapeMediaItem)
    throw new Error('Last.fm scraper not registered')
  return lastfmPlugin.scrapeMediaItem(input)
}

describe('Last.fm sparse response boundary', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('No live requests allowed')
      }),
    ),
  )
  afterEach(() => vi.unstubAllGlobals())

  it('normalizes the sanitized stored empty tags and null durations without changing raw evidence', async () => {
    const input = context(lastFmSparseAlbumFixture)
    const result = await scrape(input)
    expect(result.payload).toEqual(lastFmSparseAlbumFixture)
    expect(result.normalized.tags).toEqual([])
    expect(result.normalized.tracks).toEqual([
      { title: 'Track 1', position: 1 },
      { title: 'Track 2', position: 2 },
    ])
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({})
    expect(input.request).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts empty tags independently of missing tracks and retains populated top tags', async () => {
    const result = await scrape(
      context({
        album: {
          ...lastFmSparseAlbumFixture.album,
          tracks: undefined,
          toptags: { tag: [{ name: 'Ambient' }] },
        },
      }),
    )
    expect(result.normalized.tracks).toEqual([])
    expect(result.normalized.tags).toEqual([
      {
        name: 'Ambient',
        kind: 'general',
        source: 'lastfm',
        rawName: 'Ambient',
      },
    ])
  })

  it.each([null, undefined, 0, '0', '123'])(
    'accepts a validated singleton track with duration %j without changing raw evidence',
    async (duration) => {
      // The retained failed-job error identifies an object at album.tracks.track;
      // the failed response body was not stored, so this is synthetic evidence.
      const payload = {
        album: {
          ...lastFmSparseAlbumFixture.album,
          tracks: {
            track: {
              name: 'Only track',
              ...(duration === undefined ? {} : { duration }),
              url: 'https://www.last.fm/music/Example+Artist/_/Only+track',
            },
          },
        },
      }
      const before = structuredClone(payload)
      const input = context(payload)
      const result = await scrape(input)
      expect(result.normalized.tracks).toEqual([
        {
          title: 'Only track',
          position: 1,
          ...(duration === null || duration === undefined
            ? {}
            : { durationSec: Number(duration) }),
        },
      ])
      expect(result.payload).toEqual(before)
      expect(payload).toEqual(before)
      expect(result.normalized.tags).toEqual([])
      const details = readAlbumProviderDetails('lastfm', result.payload)
      expect(details?.tracks).toEqual([
        {
          title: 'Only track',
          position: '1',
          url: payload.album.tracks.track.url,
        },
      ])
      expect(
        result.normalized.mediaPatch?.metadata?.['plugin.lastfm.details'],
      ).toEqual(details)
      expect(input.request).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each(
    [
      null,
      '',
      0,
      false,
      {},
      { duration: '123' },
      { name: '' },
      { name: 'Only track', duration: 'invalid' },
      { name: 'Only track', duration: -1 },
      { name: 'Only track', url: 'javascript:alert(1)' },
      [{ name: 'Valid track' }, {}],
    ].map((track) => ({ track })),
  )(
    'rejects malformed singleton or array track data: $track',
    async ({ track }) => {
      const payload = {
        album: { ...lastFmSparseAlbumFixture.album, tracks: { track } },
      }
      const input = context(payload)
      await expect(scrape(input)).rejects.toBeInstanceOf(ZodError)
      expect(readAlbumProviderDetails('lastfm', payload)).toBeNull()
      expect(input.request).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps unknown duration absent while preserving zero and valid numeric durations', async () => {
    const durations = [null, undefined, 0, '0', 123, '234']
    const result = await scrape(
      context({
        album: {
          ...lastFmSparseAlbumFixture.album,
          tags: { tag: [] },
          tracks: {
            track: durations.map((duration, index) => ({
              name: `Track ${index + 1}`,
              duration,
            })),
          },
        },
      }),
    )
    expect(result.normalized.tracks).toEqual([
      { title: 'Track 1', position: 1 },
      { title: 'Track 2', position: 2 },
      { title: 'Track 3', position: 3, durationSec: 0 },
      { title: 'Track 4', position: 4, durationSec: 0 },
      { title: 'Track 5', position: 5, durationSec: 123 },
      { title: 'Track 6', position: 6, durationSec: 234 },
    ])
  })

  it.each([
    { tags: 'not empty' },
    { tags: null },
    { tags: [] },
    { tags: { tag: [{ name: '' }] } },
    { tags: { tag: [{ name: 'Ambient', url: 'javascript:void(0)' }] } },
  ])('still rejects malformed tags: $tags', async ({ tags }) => {
    const input = context({
      album: { ...lastFmSparseAlbumFixture.album, tracks: undefined, tags },
    })
    await expect(scrape(input)).rejects.toBeInstanceOf(ZodError)
    expect(input.request).toHaveBeenCalledTimes(1)
  })

  it.each([-1, '-1', '', 'unknown', false, {}, 1.5])(
    'still rejects invalid duration %j instead of treating it as unknown',
    async (duration) => {
      const input = context({
        album: {
          ...lastFmSparseAlbumFixture.album,
          tags: { tag: [] },
          tracks: { track: [{ name: 'Track 1', duration }] },
        },
      })
      await expect(scrape(input)).rejects.toBeInstanceOf(ZodError)
      expect(input.request).toHaveBeenCalledTimes(1)
    },
  )
})
