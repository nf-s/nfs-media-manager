import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MediaPluginManifestSchema,
  ProviderItemNotFoundError,
  ProviderRequestError,
  type MediaPluginScrapeContext,
  type MediaProviderPlugin,
  type PluginReference,
} from '@repo/media-plugin-sdk'
import { musicbrainzPlugin } from '../musicbrainz'
import { lastfmPlugin } from '../lastfm'
import { discogsPlugin } from '../discogs'
import { getBuiltinScrapePlugin } from '../index'
import { getBuiltinProviderCatalog } from '@/lib/provider-catalog'
import { readAlbumProviderDetails } from '@/lib/album-provider-details'

const mbid = '11111111-1111-4111-8111-111111111111'
const artistMbid = '22222222-2222-4222-8222-222222222222'
const otherMbid = '33333333-3333-4333-8333-333333333333'
const group = {
  id: mbid,
  title: 'Example Album',
  'artist-credit': [
    {
      name: 'Example Artist',
      artist: { id: artistMbid, name: 'Example Artist' },
    },
  ],
  genres: [{ name: 'Ambient', id: otherMbid, count: 2 }],
  tags: [{ name: 'Dreamy', count: 1 }],
  'first-release-date': '2001',
}
const lastFmAlbum = {
  name: 'Example Album',
  artist: 'Example Artist',
  url: 'https://www.last.fm/music/Example+Artist/Example+Album',
  mbid,
  listeners: '0',
  playcount: '0',
  userplaycount: '0',
  tags: { tag: [{ name: 'Ambient' }] },
  tracks: { track: [{ name: 'Song', duration: '0' }] },
}
const release = {
  id: 22,
  title: 'Example Album',
  artists: [{ id: 10, name: 'Example Artist' }],
  country: 'AU',
  genres: ['Ambient'],
  styles: ['Drone'],
  community: { have: 0, want: 0, rating: { average: 0, count: 0 } },
  tracklist: [
    { type_: 'track', title: 'Song', position: 'A1', duration: '3:01' },
  ],
}
const master = { ...release, id: 11, main_release: 22, community: undefined }

function ref(
  provider: string,
  referenceType: string,
  externalId: string,
): PluginReference {
  return {
    referenceType,
    externalId,
    isPrimary: true,
    metadata: { sourceProvider: provider },
  }
}

function replies(...payloads: unknown[]) {
  const queue = [...payloads]
  return vi.fn<MediaPluginScrapeContext['request']>(async () => {
    if (!queue.length) throw new Error('Exceeded mocked request bound')
    return Response.json(queue.shift())
  })
}

function context(
  overrides: Partial<MediaPluginScrapeContext> = {},
): MediaPluginScrapeContext {
  return {
    mediaItemId: 'offline-album',
    mediaType: 'album',
    media: { title: 'Example Album', artists: ['Example Artist'] },
    existingReferences: [],
    secrets: {
      appName: 'OfflineTest',
      appVersion: '1.0',
      contact: 'offline@example.test',
      apiKey: 'offline-key',
      token: 'offline-token',
      username: 'offline-user',
    },
    request: replies(),
    log: vi.fn(async () => undefined),
    ...overrides,
  }
}

async function scrape(
  plugin: MediaProviderPlugin,
  ctx: MediaPluginScrapeContext,
) {
  if (!plugin.scrapeMediaItem) throw new Error('Missing scraper')
  return plugin.scrapeMediaItem(ctx)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Live HTTP is forbidden')
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('MusicBrainz album adapter', () => {
  it('keeps canonical identity while exposing release-group details and tag weights', async () => {
    const payload = {
      ...group,
      'primary-type': 'Album',
      'secondary-types': ['Live'],
      disambiguation: 'Festival recording',
      relations: [
        {
          type: 'official homepage',
          url: { resource: 'https://example.test/album' },
        },
      ],
    }
    const request = replies(payload)
    const result = await scrape(
      musicbrainzPlugin,
      context({
        media: {
          title: 'Canonical title',
          artists: ['Canonical artist'],
          releaseDate: '2000-01-01',
        },
        existingReferences: [ref('musicbrainz', 'release-group', mbid)],
        request,
      }),
    )
    expect(result.normalized.mediaPatch?.title).toBeUndefined()
    expect(result.normalized.mediaPatch?.releaseDate).toBeUndefined()
    expect(result.normalized.credits).toEqual([])
    expect(
      result.normalized.mediaPatch?.metadata?.['plugin.musicbrainz.details'],
    ).toMatchObject({
      notes: [{ label: 'Disambiguation', text: 'Festival recording' }],
      tags: [
        expect.objectContaining({ name: 'Ambient', kind: 'genre', count: 2 }),
        expect.objectContaining({ name: 'Dreamy', kind: 'tag', count: 1 }),
      ],
      links: [
        { label: 'official homepage', url: 'https://example.test/album' },
      ],
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('uses a corrected owned release-group directly, identifies the application and normalizes provenance', async () => {
    const request = replies(group)
    const result = await scrape(
      musicbrainzPlugin,
      context({
        existingReferences: [ref('musicbrainz', 'release-group', mbid)],
        request,
      }),
    )
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0] ?? []
    expect(String(url)).toContain(`/release-group/${mbid}?`)
    expect(new URL(String(url)).searchParams.get('inc')).toBe(
      'artists+tags+genres+url-rels',
    )
    expect(new Headers(init?.headers).get('user-agent')).toBe(
      'OfflineTest/1.0 (offline@example.test)',
    )
    expect(result.normalized.tags).toContainEqual({
      name: 'Ambient',
      kind: 'genre',
      source: 'musicbrainz',
      sourceId: otherMbid,
      rawName: 'Ambient',
    })
    expect(result.normalized.references[0]?.referenceType).toBe('release-group')
  })

  it('uses shared UPC then exact name lookup with a three-request upper bound', async () => {
    const request = replies(
      { releases: [] },
      { 'release-groups': [group] },
      group,
    )
    await scrape(
      musicbrainzPlugin,
      context({
        existingReferences: [ref('spotify', 'upc', '123456789012')],
        request,
      }),
    )
    expect(request).toHaveBeenCalledTimes(3)
    expect(
      new URL(String(request.mock.calls[0]?.[0])).searchParams.get('query'),
    ).toBe('barcode:123456789012')
    expect(
      new URL(String(request.mock.calls[1]?.[0])).searchParams.get('query'),
    ).toBe('releasegroup:"Example Album" AND artist:"Example Artist"')
  })

  it('accepts a unique barcode release group without requiring name context', async () => {
    const request = replies(
      { releases: [{ ...group, 'release-group': { id: mbid } }] },
      group,
    )
    await scrape(
      musicbrainzPlugin,
      context({
        media: undefined,
        existingReferences: [ref('spotify', 'upc', '123456789012')],
        request,
      }),
    )
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each(
    [[], [{ ...group, title: 'Unrelated' }]].map((groups) => ({ groups })),
  )('treats no exact search match as benign: $groups', async ({ groups }) => {
    const request = replies({ 'release-groups': groups })
    await expect(
      scrape(musicbrainzPlugin, context({ request })),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('escapes Lucene punctuation in names', async () => {
    const request = replies({ 'release-groups': [] })
    await expect(
      scrape(
        musicbrainzPlugin,
        context({ media: { title: 'A" OR *:*', artists: ['A/B'] }, request }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(
      new URL(String(request.mock.calls[0]?.[0])).searchParams.get('query'),
    ).toBe('releasegroup:"A\\" OR \\*\\:\\*" AND artist:"A\\/B"')
  })

  it('does not select a possibly ambiguous result outside the bounded search window', async () => {
    const request = replies({ count: 6, 'release-groups': [group] })
    await expect(
      scrape(musicbrainzPlugin, context({ request })),
    ).rejects.toThrow('bounded matching window')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not mark multiple exact matches as a definitive not-found', async () => {
    const request = replies({
      'release-groups': [group, { ...group, id: otherMbid }],
    })
    const result = scrape(musicbrainzPlugin, context({ request }))
    await expect(result).rejects.toThrow('ambiguous')
    await expect(result).rejects.not.toBeInstanceOf(ProviderItemNotFoundError)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('treats an unmatched shared barcode without names as a benign miss', async () => {
    const request = replies({ releases: [] })
    await expect(
      scrape(
        musicbrainzPlugin,
        context({
          media: undefined,
          existingReferences: [ref('spotify', 'upc', '123456789012')],
          request,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('Last.fm album adapter', () => {
  it('preserves zero counts and seconds with one MBID request', async () => {
    const request = replies({ album: lastFmAlbum })
    const result = await scrape(
      lastfmPlugin,
      context({ existingReferences: [ref('lastfm', 'mbid', mbid)], request }),
    )
    expect(request).toHaveBeenCalledTimes(1)
    expect(
      new URL(String(request.mock.calls[0]?.[0])).searchParams.get('mbid'),
    ).toBe(mbid)
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      scrobbles: 0,
      popularityLastFm: 0,
      'plugin.lastfm.playcount': 0,
    })
    expect(result.normalized.tracks).toEqual([
      { title: 'Song', position: 1, durationSec: 0 },
    ])
  })

  it('respects a corrected URL ahead of an older MBID and never fetches the URL directly', async () => {
    const request = replies({ album: lastFmAlbum })
    await scrape(
      lastfmPlugin,
      context({
        existingReferences: [
          ref('lastfm', 'url', lastFmAlbum.url),
          ref('lastfm', 'mbid', otherMbid),
        ],
        request,
      }),
    )
    const url = new URL(String(request.mock.calls[0]?.[0]))
    expect(url.hostname).toBe('ws.audioscrobbler.com')
    expect(url.searchParams.get('artist')).toBe('Example Artist')
    expect(url.searchParams.has('mbid')).toBe(false)
  })

  it('does not confuse a release-group with a Last.fm MBID', async () => {
    const request = replies({ album: lastFmAlbum })
    await scrape(
      lastfmPlugin,
      context({
        existingReferences: [ref('musicbrainz', 'release-group', mbid)],
        request,
      }),
    )
    const url = new URL(String(request.mock.calls[0]?.[0]))
    expect(url.searchParams.has('mbid')).toBe(false)
    expect(url.searchParams.get('album')).toBe('Example Album')
  })

  it.each([
    [{ error: 29, message: 'Rate limit exceeded' }, 'rate-limit'],
    [{ error: 10, message: 'Invalid API key' }, 'access-denied'],
    [{ error: 26, message: 'Suspended API key' }, 'access-denied'],
  ])(
    'classifies structured errors without retries: %j',
    async (payload, code) => {
      const request = replies(payload)
      await expect(
        scrape(lastfmPlugin, context({ request })),
      ).rejects.toMatchObject({ code })
      expect(request).toHaveBeenCalledTimes(1)
    },
  )

  it('distinguishes album-not-found from invalid parameters sharing error code 6', async () => {
    await expect(
      scrape(
        lastfmPlugin,
        context({ request: replies({ error: 6, message: 'Album not found' }) }),
      ),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    await expect(
      scrape(
        lastfmPlugin,
        context({
          request: replies({ error: 6, message: 'Missing parameter' }),
        }),
      ),
    ).rejects.not.toBeInstanceOf(ProviderItemNotFoundError)
  })

  it('sets an immediate shared cooldown for a successful HTTP response containing error 29', async () => {
    const request = vi.fn(async () =>
      Response.json(
        { error: 29, message: 'Rate limit exceeded' },
        { headers: { 'Retry-After': '180' } },
      ),
    )
    await expect(
      scrape(lastfmPlugin, context({ request })),
    ).rejects.toMatchObject({
      code: 'rate-limit',
      retryAt: Date.now() + 180000,
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects a different MBID instead of saving a mismatched corrected lookup', async () => {
    await expect(
      scrape(
        lastfmPlugin,
        context({
          existingReferences: [ref('lastfm', 'mbid', otherMbid)],
          request: replies({ album: lastFmAlbum }),
        }),
      ),
    ).rejects.toThrow('different MBID')
  })
})

describe('Discogs album adapter', () => {
  it('does not label a release country as artist country', async () => {
    const request = replies(release)
    const result = await scrape(
      discogsPlugin,
      context({
        existingReferences: [ref('discogs', 'release', '22')],
        request,
      }),
    )
    expect(
      result.normalized.mediaPatch?.metadata?.['browse'],
    ).not.toHaveProperty('country')
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      'plugin.discogs.releaseCountry': 'AU',
      'plugin.discogs.have': 0,
      'plugin.discogs.want': 0,
    })
    expect(result.normalized.tracks[0]).not.toHaveProperty('externalId')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('looks up master then only its main release, with explicit rating scope', async () => {
    const request = replies(master, { ...release, master_id: 11 })
    const result = await scrape(
      discogsPlugin,
      context({
        existingReferences: [ref('discogs', 'master', '11')],
        request,
      }),
    )
    expect(request).toHaveBeenCalledTimes(2)
    expect(
      request.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(['/masters/11', '/releases/22'])
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get('authorization'),
    ).toBe('Discogs token=offline-token')
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingDiscogsValue: 0,
      ratingDiscogsVotes: 0,
      popularityDiscogs: 0,
      'plugin.discogs.releaseCountry': 'AU',
      'plugin.discogs.have': 0,
      'plugin.discogs.want': 0,
      'plugin.discogs.ratingScope': 'Main release 22 only',
    })
    expect(result.normalized.tags).toContainEqual({
      name: 'Drone',
      kind: 'style',
      source: 'discogs',
      rawName: 'Drone',
    })
    expect(result.normalized.tracks[0]?.durationSec).toBe(181)
  })

  it('respects a corrected release ahead of an older master and ignores another provider release', async () => {
    const request = replies(release)
    await scrape(
      discogsPlugin,
      context({
        existingReferences: [
          ref('musicbrainz', 'release', mbid),
          ref('discogs', 'release', '22'),
          ref('discogs', 'master', '11'),
        ],
        request,
      }),
    )
    expect(request).toHaveBeenCalledTimes(1)
    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe(
      '/releases/22',
    )
  })

  it('bounds barcode, master search, release search and release detail to four requests', async () => {
    const request = replies(
      { results: [] },
      { results: [] },
      {
        results: [
          { id: 22, type: 'release', title: 'Example Artist - Example Album' },
        ],
      },
      release,
    )
    await scrape(
      discogsPlugin,
      context({
        existingReferences: [ref('spotify', 'upc', '123456789012')],
        request,
      }),
    )
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('uses the search result master id, not master_id=0, and rejects unrelated main releases', async () => {
    const request = replies(
      {
        results: [
          {
            id: 11,
            type: 'master',
            master_id: 0,
            title: 'Example Artist - Example Album',
          },
        ],
      },
      master,
      { ...release, id: 99 },
    )
    await expect(scrape(discogsPlugin, context({ request }))).rejects.toThrow(
      'unrelated main release',
    )
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe(
      '/masters/11',
    )
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('reports a validated empty search benignly without versions or ratings fanout', async () => {
    const request = replies({ results: [] }, { results: [] })
    await expect(
      scrape(discogsPlugin, context({ request })),
    ).rejects.toBeInstanceOf(ProviderItemNotFoundError)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects ambiguous truncated search results without requesting another page', async () => {
    const request = replies({
      pagination: { items: 6 },
      results: [
        { id: 11, type: 'master', title: 'Example Artist - Example Album' },
      ],
    })
    await expect(scrape(discogsPlugin, context({ request }))).rejects.toThrow(
      'bounded matching window',
    )
    expect(request).toHaveBeenCalledTimes(1)
  })
})

const plugins = [musicbrainzPlugin, lastfmPlugin, discogsPlugin]

it.each([
  {
    plugin: musicbrainzPlugin,
    reference: ref('musicbrainz', 'release-group', mbid),
    payload: group,
    stored: { releaseGroup: group },
  },
  {
    plugin: discogsPlugin,
    reference: ref('discogs', 'release', '22'),
    payload: release,
    stored: { release },
  },
  {
    plugin: lastfmPlugin,
    reference: ref('lastfm', 'mbid', mbid),
    payload: { album: lastFmAlbum },
    stored: { album: lastFmAlbum },
  },
])(
  'persists the same readonly details without changing canonical identity: $plugin.manifest.id',
  async ({ plugin, reference, payload, stored }) => {
    const request = replies(payload)
    const input = context({
      media: {
        title: 'Canonical title',
        artists: ['Canonical artist'],
        releaseDate: '1999-01-01',
      },
      existingReferences: [reference],
      request,
    })
    const originalMedia = structuredClone(input.media)
    const originalReferences = structuredClone(input.existingReferences)
    const result = await scrape(plugin, input)
    expect(result.payload).toEqual(stored)
    expect(
      result.normalized.mediaPatch?.metadata?.[
        `plugin.${plugin.manifest.id}.details`
      ],
    ).toEqual(readAlbumProviderDetails(plugin.manifest.id, result.payload))
    expect(result.normalized.mediaPatch).not.toHaveProperty('title')
    expect(result.normalized.mediaPatch).not.toHaveProperty('releaseDate')
    expect(result.normalized.mediaPatch).not.toHaveProperty('summary')
    expect(result.normalized.credits).toEqual([])
    expect(
      result.normalized.tracks.every((track) => track.externalId === undefined),
    ).toBe(true)
    expect(input.media).toEqual(originalMedia)
    expect(input.existingReferences).toEqual(originalReferences)
    expect(request).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  },
)

describe.each(plugins)('$manifest.displayName shared safety', (plugin) => {
  it('registers the same validated manifest and never relaxes legacy request spacing', () => {
    expect(MediaPluginManifestSchema.safeParse(plugin.manifest).success).toBe(
      true,
    )
    expect(getBuiltinScrapePlugin(plugin.manifest.id)).toBe(plugin)
    expect(
      getBuiltinProviderCatalog().find(
        (entry) => entry.id === plugin.manifest.id,
      ),
    ).toMatchObject({
      ...plugin.manifest,
      supportsScrape: true,
      supportsLegacyImport: true,
    })
    expect(plugin.manifest.rateLimit.maxConcurrent).toBe(1)
  })
  it.each([400, 401, 403, 404, 429, 500, 503])(
    'never retries HTTP %i or calls it a benign miss',
    async (status) => {
      const request = vi.fn(
        async () =>
          new Response('not a success', {
            status,
            headers: { 'Retry-After': '120' },
          }),
      )
      const error = scrape(plugin, context({ request }))
      await expect(error).rejects.toBeInstanceOf(ProviderRequestError)
      await expect(error).rejects.toMatchObject({
        code:
          status === 429
            ? 'rate-limit'
            : [401, 403].includes(status)
              ? 'access-denied'
              : 'request-failed',
      })
      if (status === 429)
        await expect(error).rejects.toMatchObject({
          retryAt: Date.now() + 120000,
        })
      expect(request).toHaveBeenCalledTimes(1)
    },
  )
  it.each(
    [null, [], {}, { error: 'unexpected failure' }].map((body) => ({ body })),
  )(
    'rejects malformed bodies rather than marking them benign: $body',
    async ({ body }) => {
      const request = replies(body)
      await expect(
        scrape(plugin, context({ request })),
      ).rejects.not.toBeInstanceOf(ProviderItemNotFoundError)
      expect(request).toHaveBeenCalledTimes(1)
    },
  )
  it('preserves gateway error identity, retry time and recorded state', async () => {
    const error = new ProviderRequestError(
      'Gateway stopped request',
      'rate-limit',
      123456789,
      true,
    )
    const request = vi.fn(async () => {
      throw error
    })
    await expect(scrape(plugin, context({ request }))).rejects.toBe(error)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('guards missing names and film contexts before transport', async () => {
    const request = replies()
    await expect(
      scrape(plugin, context({ media: undefined, request })),
    ).rejects.toThrow()
    await expect(
      scrape(plugin, context({ mediaType: 'film', request })),
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('stops on malformed JSON and transport failures with no fallback', async () => {
    const invalidJson = vi.fn(async () => new Response('{bad'))
    await expect(
      scrape(plugin, context({ request: invalidJson })),
    ).rejects.toThrow()
    expect(invalidJson).toHaveBeenCalledTimes(1)
    const failure = new Error('Offline connection failure')
    const request = vi.fn(async () => {
      throw failure
    })
    await expect(scrape(plugin, context({ request }))).rejects.toBe(failure)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

it.each([
  {
    plugin: musicbrainzPlugin,
    reference: ref('musicbrainz', 'release-group', '../bad'),
  },
  { plugin: lastfmPlugin, reference: ref('lastfm', 'mbid', '../bad') },
  {
    plugin: lastfmPlugin,
    reference: ref('lastfm', 'url', 'https://attacker.test/music/a/b'),
  },
  { plugin: discogsPlugin, reference: ref('discogs', 'release', '22?bad') },
  { plugin: discogsPlugin, reference: ref('discogs', 'master', '0') },
])(
  'rejects invalid owned $reference.referenceType before HTTP rather than searching',
  async ({ plugin, reference }) => {
    const request = replies()
    await expect(
      scrape(plugin, context({ existingReferences: [reference], request })),
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  },
)
