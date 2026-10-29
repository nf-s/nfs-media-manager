import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderItemNotFoundError,
  type MediaPluginScrapeContext,
} from '@repo/media-plugin-sdk'
import { ZodError } from 'zod'
import { readAlbumProviderDetails } from '@/lib/album-provider-details'
import { lastfmPlugin } from '../lastfm'
import { lastFmSparseAlbumFixture } from './fixtures/lastfm'

// Synthetic wire-shape cases, not captured responses or live API requests.
// Official XML example: https://www.last.fm/api/show/album.getInfo
// Client types (singleton tags, optional counts/tracks/wiki members):
// https://github.com/ansango/lastfm-api/blob/54494963c25177aaf13a29ec7eeb09efc0d0a85b/src/api/album/schemas.ts
// Client fixtures also exercise tags:{} and empty wiki strings:
// https://github.com/ansango/lastfm-api/blob/54494963c25177aaf13a29ec7eeb09efc0d0a85b/src/__tests__/album.test.ts
// Local audit additionally found empty tags, null durations, singleton tracks,
// empty image text and /music/+noredirect/ album URLs.
const identity = {
  name: lastFmSparseAlbumFixture.album.name,
  artist: lastFmSparseAlbumFixture.album.artist,
  url: lastFmSparseAlbumFixture.album.url,
}
const tag = {
  name: 'Ambient',
  url: 'https://www.last.fm/tag/ambient',
  count: '0',
}
const track = {
  name: 'Only track',
  duration: '123',
  url: 'https://www.last.fm/music/Example+Artist/_/Only+track',
}

function context(payload: unknown): MediaPluginScrapeContext {
  return {
    mediaItemId: 'canonical-album',
    mediaType: 'album',
    existingReferences: [],
    media: { title: identity.name, artists: [identity.artist] },
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

async function accepted(fields: Record<string, unknown>) {
  const payload = { album: { ...identity, ...fields } }
  const before = structuredClone(payload)
  const input = context(payload)
  const result = await scrape(input)
  expect(input.request).toHaveBeenCalledTimes(1)
  expect(result.payload).toEqual(before)
  expect(payload).toEqual(before)
  const details = readAlbumProviderDetails('lastfm', result.payload)
  expect(details).not.toBeNull()
  expect(readAlbumProviderDetails('lastfm', payload.album)).toEqual(details)
  expect(
    result.normalized.mediaPatch?.metadata?.['plugin.lastfm.details'],
  ).toEqual(details)
  return { result, details }
}

async function rejected(fields: Record<string, unknown>) {
  const payload = { album: { ...identity, ...fields } }
  const before = structuredClone(payload)
  const input = context(payload)
  await expect(scrape(input)).rejects.toBeInstanceOf(ZodError)
  expect(readAlbumProviderDetails('lastfm', payload)).toBeNull()
  expect(payload).toEqual(before)
  expect(input.request).toHaveBeenCalledTimes(1)
}

describe('Last.fm offline response matrix', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('No live requests allowed')
      }),
    ),
  )
  afterEach(() => {
    try {
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts identity alone without inventing optional metadata', async () => {
    const { result, details } = await accepted({})
    expect(result.normalized.tags).toEqual([])
    expect(result.normalized.tracks).toEqual([])
    expect(result.normalized.mediaPatch?.artworkUrl).toBeUndefined()
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({})
    expect(details?.facts).toEqual([
      { label: 'Source title', value: identity.name },
      { label: 'Source artists', value: identity.artist },
    ])
    expect(details?.notes).toEqual([])
  })

  it('projects the official example shape while retaining unprojected wire fields', async () => {
    const { result, details } = await accepted({
      id: '123456',
      releasedate: '1 Jan 2000, 00:00',
      listeners: '42',
      playcount: '123',
      toptags: { tag: [{ name: tag.name, url: tag.url }] },
      tracks: {
        track: [
          {
            ...track,
            mbid: '',
            '@attr': { rank: '1' },
            streamable: { '#text': '1', fulltrack: '0' },
            artist: {
              name: identity.artist,
              mbid: '22222222-2222-4222-8222-222222222222',
              url: 'https://www.last.fm/music/Example+Artist',
            },
          },
        ],
      },
    })
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      popularityLastFm: 42,
      'plugin.lastfm.playcount': 123,
    })
    expect(result.normalized.tracks).toEqual([
      { title: track.name, position: 1, durationSec: 123 },
    ])
    expect(details?.tags).toEqual([{ name: tag.name, kind: 'toptag' }])
    expect(details?.notes).toEqual([])
  })

  describe.each(['tags', 'toptags'])('%s collection', (field) => {
    it.each([
      { label: 'outer empty string', value: '', expected: [] },
      { label: 'empty object from client fixture', value: {}, expected: [] },
      { label: 'empty array', value: { tag: [] }, expected: [] },
      { label: 'singleton', value: { tag }, expected: [tag] },
      { label: 'one-element array', value: { tag: [tag] }, expected: [tag] },
      {
        label: 'multiple tags',
        value: { tag: [tag, { name: 'Drone' }] },
        expected: [tag, { name: 'Drone' }],
      },
    ])('normalizes $label', async ({ value, expected }) => {
      const { result, details } = await accepted({ [field]: value })
      expect(result.normalized.tags).toEqual(
        expected.map(({ name }) => ({
          name,
          rawName: name,
          source: 'lastfm',
          kind: 'general',
        })),
      )
      expect(details?.tags).toHaveLength(expected.length)
      for (const detail of details?.tags ?? []) {
        expect(detail.kind).toBe(field === 'tags' ? 'tag' : 'toptag')
      }
      if (expected.length) {
        expect(details?.tags[0]).toMatchObject({
          count: 0,
          countLabel: 'tag count',
        })
        expect(details?.links).toContainEqual({
          label: `${field === 'tags' ? 'tag' : 'toptag'}: ${tag.name}`,
          url: tag.url,
        })
      }
    })

    it.each(
      [
        null,
        false,
        0,
        'not empty',
        [],
        { unexpected: [] },
        { tag: null },
        { tag: '' },
        { tag: false },
        { tag: {} },
        { tag: { name: '' } },
        { tag: { name: 123 } },
        { tag: { name: 'Ambient', count: -1 } },
        { tag: { name: 'Ambient', count: 'unknown' } },
        { tag: { name: 'Ambient', url: 'javascript:alert(1)' } },
        { tag: { name: 'Ambient', url: '' } },
        { tag: [tag, {}] },
      ].map((value) => ({ value })),
    )('rejects malformed collection $value', async ({ value }) => {
      await rejected({ [field]: value })
    })
  })

  it.each([
    {
      label: 'singleton tags with singleton null-duration track',
      tags: { tag },
    },
    { label: 'empty tags with singleton null-duration track', tags: '' },
  ])('combines reported failures: $label', async ({ tags }) => {
    const { result, details } = await accepted({
      tags,
      toptags: { tag: { name: 'Drone' } },
      tracks: { track: { ...track, duration: null } },
    })
    expect(result.normalized.tracks).toEqual([
      { title: track.name, position: 1 },
    ])
    expect(details?.tracks).toEqual([
      { title: track.name, position: '1', url: track.url },
    ])
    expect(result.normalized.tags?.map(({ name }) => name)).toEqual(
      tags === '' ? ['Drone'] : ['Ambient', 'Drone'],
    )
  })

  describe.each(['singleton', 'array'])('%s track', (shape) => {
    it.each([
      { label: 'missing', duration: undefined, expected: undefined },
      { label: 'null', duration: null, expected: undefined },
      { label: 'numeric zero', duration: 0, expected: 0 },
      { label: 'string zero', duration: '0', expected: 0 },
      { label: 'number', duration: 123, expected: 123 },
      { label: 'string number', duration: '123', expected: 123 },
    ])(
      'preserves $label duration semantics',
      async ({ duration, expected }) => {
        const item = {
          name: track.name,
          url: track.url,
          ...(duration === undefined ? {} : { duration }),
        }
        const { result } = await accepted({
          tracks: { track: shape === 'singleton' ? item : [item] },
        })
        expect(result.normalized.tracks).toEqual([
          {
            title: track.name,
            position: 1,
            ...(expected === undefined ? {} : { durationSec: expected }),
          },
        ])
      },
    )

    it.each(
      [
        '',
        -1,
        '-1',
        'unknown',
        false,
        {},
        1.5,
        '1.5',
        '1e3',
        Number.MAX_SAFE_INTEGER + 1,
      ].map((duration) => ({ duration })),
    )('rejects invalid duration $duration', async ({ duration }) => {
      const item = { ...track, duration }
      await rejected({
        tracks: { track: shape === 'singleton' ? item : [item] },
      })
    })
  })

  it('preserves array track ordering and source URLs', async () => {
    const { result, details } = await accepted({
      tracks: { track: [track, { name: 'Second track', duration: 0 }] },
    })
    expect(result.normalized.tracks).toEqual([
      { title: track.name, position: 1, durationSec: 123 },
      { title: 'Second track', position: 2, durationSec: 0 },
    ])
    expect(details?.tracks).toEqual([
      { title: track.name, position: '1', url: track.url },
      { title: 'Second track', position: '2' },
    ])
  })

  it('accepts an empty track array', async () => {
    const { result } = await accepted({ tracks: { track: [] } })
    expect(result.normalized.tracks).toEqual([])
  })

  it.each(
    [
      null,
      '',
      [],
      {},
      { track: null },
      { track: '' },
      { track: {} },
      { track: { name: '' } },
      { track: [track, {}] },
    ].map((tracks) => ({ tracks })),
  )('rejects unsupported track containers $tracks', async ({ tracks }) => {
    await rejected({ tracks })
  })

  describe.each([
    { field: 'listeners', browse: 'popularityLastFm' },
    { field: 'playcount', browse: 'plugin.lastfm.playcount' },
    { field: 'userplaycount', browse: 'scrobbles' },
  ])('$field count', ({ field, browse }) => {
    it.each([0, '0', 42, '42', Number.MAX_SAFE_INTEGER])(
      'normalizes %j',
      async (value) => {
        const { result } = await accepted({ [field]: value })
        expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({
          [browse]: Number(value),
        })
      },
    )
    it.each([
      null,
      '',
      'unknown',
      -1,
      '-1',
      0.5,
      '0.5',
      false,
      {},
      '1e3',
      Number.MAX_SAFE_INTEGER + 1,
    ])('rejects %j instead of coercing to zero', async (value) => {
      await rejected({ [field]: value })
    })
  })

  it.each([
    { label: 'empty array', image: [], artwork: undefined },
    {
      label: 'empty image text',
      image: [{ '#text': '', size: 'small' }],
      artwork: undefined,
    },
    {
      label: 'empty size',
      image: [{ '#text': 'https://images.example.test/cover.jpg', size: '' }],
      artwork: 'https://images.example.test/cover.jpg',
    },
    {
      label: 'trailing empty image',
      image: [
        { '#text': 'https://images.example.test/cover.jpg', size: 'large' },
        { '#text': '', size: 'mega' },
      ],
      artwork: 'https://images.example.test/cover.jpg',
    },
    {
      label: 'largest available image',
      image: [
        { '#text': 'http://images.example.test/small.jpg', size: 'small' },
        { '#text': 'https://images.example.test/cover.jpg', size: 'large' },
      ],
      artwork: 'https://images.example.test/cover.jpg',
    },
  ])(
    'handles $label without URL refinement throwing',
    async ({ image, artwork }) => {
      const { result } = await accepted({ image })
      expect(result.normalized.mediaPatch?.artworkUrl).toBe(artwork)
    },
  )

  it.each(
    [
      null,
      '',
      {},
      { '#text': 'https://images.example.test/cover.jpg', size: 'large' },
      [{ '#text': null, size: 'large' }],
      [{ '#text': '', size: null }],
      [{ size: 'large' }],
    ].map((image) => ({ image })),
  )('rejects unsupported image shapes $image', async ({ image }) => {
    await rejected({ image })
  })

  describe.each(['album', 'image', 'track', 'tag'])(
    '%s URL boundary',
    (field) => {
      it.each([
        'not a URL',
        'javascript:alert(1)',
        'file:///tmp/cover.jpg',
        'https://user:password@www.last.fm/music/Artist/Album',
      ])('rejects %s with ZodError, not TypeError', async (url) => {
        const fields =
          field === 'album'
            ? { url }
            : field === 'image'
              ? { image: [{ '#text': url, size: 'large' }] }
              : field === 'track'
                ? { tracks: { track: { ...track, url } } }
                : { tags: { tag: { ...tag, url } } }
        await rejected(fields)
      })
    },
  )

  it.each([identity.artist, { name: identity.artist }])(
    'retains the established artist representation %j',
    async (artist) => {
      const { details } = await accepted({ artist })
      expect(details?.facts).toContainEqual({
        label: 'Source artists',
        value: identity.artist,
      })
    },
  )

  it.each([
    null,
    '',
    false,
    1,
    [],
    {},
    { name: '' },
    { '#text': identity.artist },
  ])('rejects unsupported album artist %j', async (artist) => {
    await rejected({ artist })
  })

  it.each([
    { wiki: {}, expected: { summary: null, content: null, published: null } },
    {
      wiki: { summary: '', content: '', published: '' },
      expected: { summary: null, content: null, published: null },
    },
    {
      wiki: { summary: 'Summary only' },
      expected: { summary: 'Summary only', content: null, published: null },
    },
    {
      wiki: { content: 'Content only', published: '28 Oct 2026, 00:00' },
      expected: {
        summary: null,
        content: 'Content only',
        published: '28 Oct 2026, 00:00',
      },
    },
  ])('preserves partial wiki fields $wiki', async ({ wiki, expected }) => {
    const { details } = await accepted({ wiki })
    expect(details?.notes).toEqual([
      ...(expected.summary
        ? [{ label: 'Wiki summary', text: expected.summary }]
        : []),
      ...(expected.content
        ? [{ label: 'Wiki content', text: expected.content }]
        : []),
    ])
    expect(
      details?.facts.filter(({ label }) => label === 'Wiki published'),
    ).toEqual(
      expected.published
        ? [{ label: 'Wiki published', value: expected.published }]
        : [],
    )
  })

  it.each([
    null,
    '',
    [],
    { summary: null },
    { summary: 1 },
    { content: {} },
    { published: false },
  ])('rejects unsupported wiki %j', async (wiki) => {
    await rejected({ wiki })
  })

  it.each(['', '11111111-1111-4111-8111-111111111111'])(
    'handles MBID %j without inventing an identifier',
    async (mbid) => {
      const { result } = await accepted({ mbid })
      expect(result.normalized.references).toEqual([
        ...(mbid
          ? [{ referenceType: 'mbid', externalId: mbid, isPrimary: true }]
          : []),
        { referenceType: 'url', externalId: identity.url, isPrimary: !mbid },
      ])
    },
  )

  it.each([null, 'invalid', 123])('rejects malformed MBID %j', async (mbid) => {
    await rejected({ mbid })
  })

  it.each([
    'https://www.last.fm/music/+noredirect/Example+Artist/Example+Album',
    'http://last.fm/music/+noredirect/Example%20Artist/Example%20Album/',
  ])(
    'accepts and correctly looks up retained noredirect URL %s',
    async (url) => {
      const payload = { album: { ...identity, url } }
      const input = context(payload)
      const request = vi.fn<MediaPluginScrapeContext['request']>(async () =>
        Response.json(payload),
      )
      input.request = request
      input.existingReferences = [
        {
          referenceType: 'url',
          externalId: url,
          isPrimary: true,
          metadata: { sourceProvider: 'lastfm' },
        },
      ]
      const result = await scrape(input)
      expect(request).toHaveBeenCalledTimes(1)
      const requested = new URL(String(request.mock.calls[0]?.[0]))
      expect(requested.origin).toBe('https://ws.audioscrobbler.com')
      expect(requested.searchParams.get('artist')).toBe(identity.artist)
      expect(requested.searchParams.get('album')).toBe(identity.name)
      expect(requested.searchParams.get('method')).toBe('album.getInfo')
      expect(requested.searchParams.has('mbid')).toBe(false)
      expect(result.payload).toEqual(payload)
      expect(result.normalized.links).toEqual([
        { provider: 'lastfm', label: 'Last.fm', url },
      ])
      expect(readAlbumProviderDetails('lastfm', payload)?.url).toBe(url)
    },
  )

  it.each([
    'https://attacker.test/music/+noredirect/Artist/Album',
    'https://www.last.fm/music/+noredirect/Artist',
    'https://www.last.fm/music/+noredirect/Artist/Album/extra',
    'https://www.last.fm/music/Artist/Album/extra',
  ])('rejects malformed album routing URL %s', async (url) => {
    await rejected({ url })
  })

  it.each([
    'not a URL',
    'javascript:alert(1)',
    'https://attacker.test/music/+noredirect/Artist/Album',
    'https://www.last.fm/music/+noredirect/Artist',
    'https://user:password@www.last.fm/music/Artist/Album',
  ])('rejects unsafe corrected URL before any request: %s', async (url) => {
    const input = context({ album: identity })
    input.existingReferences = [
      {
        referenceType: 'url',
        externalId: url,
        isPrimary: true,
        metadata: { sourceProvider: 'lastfm' },
      },
    ]
    await expect(scrape(input)).rejects.toBeInstanceOf(ZodError)
    expect(input.request).not.toHaveBeenCalled()
  })

  it.each([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 16, 26, 29])(
    'does not mistake official service error %i for an album',
    async (error) => {
      const input = context({ error, message: 'Service error' })
      await expect(scrape(input)).rejects.toBeInstanceOf(Error)
      expect(input.request).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps an explicit album-not-found distinct from malformed album data', async () => {
    const input = context({ error: 6, message: 'Album not found' })
    await expect(scrape(input)).rejects.toBeInstanceOf(
      ProviderItemNotFoundError,
    )
    expect(input.request).toHaveBeenCalledTimes(1)
  })
})
