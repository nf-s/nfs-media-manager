import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderItemAmbiguousError,
  ProviderItemNotFoundError,
  type MediaPluginScrapeContext,
} from '@repo/media-plugin-sdk'
import { tidalPlugin } from '../tidal'
import {
  clearTidalTokenCache,
  nextPageCursor,
  tidalDurationSec,
  tidalToken,
} from '@/lib/tidal-api'
import {
  tidalAlbumFixture,
  tidalAlbumId,
  tidalAlbumsDocument,
  tidalItem,
  tidalItemsPage,
  tidalMissDocument,
  tidalTokenFixture,
  tidalTrackFixture,
  tidalTrackRange,
  tidalUpc,
} from './fixtures/tidal'

const upcReference = (
  externalId = tidalUpc,
  sourceProvider = 'spotify',
): MediaPluginScrapeContext['existingReferences'][number] => ({
  referenceType: 'upc',
  externalId,
  isPrimary: false,
  metadata: { sourceProvider },
})
const tidalAlbumReference: MediaPluginScrapeContext['existingReferences'][number] =
  {
    referenceType: 'album',
    externalId: tidalAlbumId,
    isPrimary: true,
    metadata: { sourceProvider: 'tidal' },
  }

function context(
  references: MediaPluginScrapeContext['existingReferences'] = [upcReference()],
  secrets: Record<string, string> = {
    clientId: 'client',
    clientSecret: 'secret',
  },
): MediaPluginScrapeContext {
  return {
    mediaItemId: 'canonical-album',
    mediaType: 'album',
    existingReferences: references,
    media: { title: 'Example Album', artists: ['Example Artist'] },
    secrets,
    request: vi.fn(),
    log: vi.fn(async () => undefined),
  }
}
function scrape(input: MediaPluginScrapeContext) {
  if (!tidalPlugin.scrapeMediaItem)
    throw new Error('TIDAL scraper not registered')
  return tidalPlugin.scrapeMediaItem(input)
}
/** Answers the token request, then each queued API response in order. */
function respond(input: MediaPluginScrapeContext, ...bodies: unknown[]) {
  const request = vi.fn()
  request.mockResolvedValueOnce(Response.json(tidalTokenFixture))
  for (const body of bodies) request.mockResolvedValueOnce(Response.json(body))
  input.request = request
  return request
}
const urlOf = (request: ReturnType<typeof vi.fn>, call: number) =>
  new URL(String(request.mock.calls[call]?.[0]))

function simpleAlbum(count = 2) {
  const { tracks, items } = tidalTrackRange(count)
  return tidalAlbumsDocument([tidalAlbumFixture(items)], tracks)
}

beforeEach(() => {
  clearTidalTokenCache()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No live requests allowed')
    }),
  )
})

describe('TIDAL album lookup', () => {
  it('finds the album by the Spotify UPC only', async () => {
    const input = context([upcReference(tidalUpc, 'other'), upcReference()])
    const request = respond(input, simpleAlbum())
    const result = await scrape(input)
    expect(urlOf(request, 1).searchParams.get('filter[barcodeId]')).toBe(
      tidalUpc,
    )
    expect(result.normalized.references?.[0]).toMatchObject({
      externalId: tidalAlbumId,
      metadata: { matchedBy: 'upc', barcodeId: tidalUpc },
    })
  })

  it('ignores a UPC from another provider', async () => {
    const input = context([upcReference(tidalUpc, 'other')])
    const request = respond(input)
    await expect(scrape(input)).rejects.toThrow('needs the album UPC')
    expect(request).not.toHaveBeenCalled()
  })

  it('throws without a Spotify UPC and without a TIDAL album ID', async () => {
    await expect(scrape(context([]))).rejects.toThrow('needs the album UPC')
  })

  it('looks up an existing tidal album reference by filter[id]', async () => {
    const input = context([tidalAlbumReference, upcReference()])
    const request = respond(input, simpleAlbum())
    const result = await scrape(input)
    const url = urlOf(request, 1)
    expect(url.searchParams.get('filter[id]')).toBe(tidalAlbumId)
    expect(url.searchParams.has('filter[barcodeId]')).toBe(false)
    expect(result.normalized.references?.[0]?.metadata).toMatchObject({
      matchedBy: 'id',
    })
  })

  it('rejects an invalid TIDAL album identifier', async () => {
    const input = context([{ ...tidalAlbumReference, externalId: 'abc' }])
    await expect(scrape(input)).rejects.toThrow('Invalid TIDAL album')
  })

  it('rejects albums only for the album media type', async () => {
    const input = context()
    input.mediaType = 'film'
    await expect(scrape(input)).rejects.toThrow('albums only')
  })
})

describe('TIDAL requests', () => {
  it('sends the catalogue request with the country, include and bearer token', async () => {
    const input = context()
    const request = respond(input, simpleAlbum())
    await scrape(input)
    const url = urlOf(request, 1)
    expect(url.origin + url.pathname).toBe(
      'https://openapi.tidal.com/v2/albums',
    )
    expect(url.searchParams.get('countryCode')).toBe('AU')
    expect(url.searchParams.get('include')).toBe('items')
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: 'application/vnd.api+json',
        Authorization: 'Bearer fake-tidal-token',
      },
    })
  })

  it('makes the token request with basic auth and client credentials', async () => {
    const input = context()
    const request = respond(input, simpleAlbum())
    await scrape(input)
    expect(String(request.mock.calls[0]?.[0])).toBe(
      'https://auth.tidal.com/v1/oauth2/token',
    )
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: 'grant_type=client_credentials',
      headers: {
        Authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`,
      },
    })
  })

  it('uses the countryCode secret when set', async () => {
    const input = context([upcReference()], {
      clientId: 'client',
      clientSecret: 'secret',
      countryCode: 'GB',
    })
    const request = respond(input, simpleAlbum())
    await scrape(input)
    expect(urlOf(request, 1).searchParams.get('countryCode')).toBe('GB')
  })

  it('throws for an invalid country code before any request', async () => {
    const input = context([upcReference()], {
      clientId: 'client',
      clientSecret: 'secret',
      countryCode: 'australia',
    })
    const request = respond(input, simpleAlbum())
    await expect(scrape(input)).rejects.toThrow('two-letter')
    expect(request).not.toHaveBeenCalled()
  })

  it('throws when credentials are missing', async () => {
    const input = context([upcReference()], {})
    await expect(scrape(input)).rejects.toThrow('credentials are missing')
  })

  it('throws on a failed catalogue request', async () => {
    const input = context()
    const request = vi.fn()
    request.mockResolvedValueOnce(Response.json(tidalTokenFixture))
    request.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    input.request = request
    await expect(scrape(input)).rejects.toThrow('HTTP 500')
  })
})

describe('TIDAL token cache', () => {
  it('requests one token for two scrapes with the same credentials', async () => {
    const first = context()
    const request = respond(first, simpleAlbum())
    await scrape(first)
    request.mockResolvedValueOnce(Response.json(simpleAlbum()))
    const second = context()
    second.request = request
    await scrape(second)
    const tokenCalls = request.mock.calls.filter(
      ([url]) => String(url) === 'https://auth.tidal.com/v1/oauth2/token',
    )
    expect(tokenCalls).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('requests a new token once the cached one is near expiry', async () => {
    const request = vi
      .fn()
      .mockImplementation(async () => Response.json(tidalTokenFixture))
    const secrets = { clientId: 'client', clientSecret: 'secret' }
    const start = 1_000_000
    await tidalToken(secrets, request, start)
    await tidalToken(secrets, request, start + 14_000_000)
    expect(request).toHaveBeenCalledTimes(1)
    // 14400 s minus the 5 minute margin
    await tidalToken(secrets, request, start + 14_400_000 - 300_000)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps tokens separate per credentials', async () => {
    const request = vi
      .fn()
      .mockImplementation(async () => Response.json(tidalTokenFixture))
    await tidalToken({ clientId: 'a', clientSecret: 'x' }, request)
    await tidalToken({ clientId: 'b', clientSecret: 'x' }, request)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects a failed or malformed token response', async () => {
    const secrets = { clientId: 'client', clientSecret: 'secret' }
    await expect(
      tidalToken(
        secrets,
        vi.fn().mockResolvedValue(new Response('', { status: 401 })),
      ),
    ).rejects.toThrow('HTTP 401')
    await expect(
      tidalToken(
        secrets,
        vi.fn().mockResolvedValue(Response.json({ access_token: '' })),
      ),
    ).rejects.toThrow('invalid token response')
  })
})

describe('TIDAL album matching', () => {
  it('reports a miss as not found', async () => {
    const input = context()
    respond(input, tidalMissDocument)
    await expect(scrape(input)).rejects.toBeInstanceOf(
      ProviderItemNotFoundError,
    )
  })

  it('reports a barcode mismatch as not found', async () => {
    const { tracks, items } = tidalTrackRange(1)
    const input = context()
    respond(
      input,
      tidalAlbumsDocument(
        [tidalAlbumFixture(items, { barcodeId: '999999999999' })],
        tracks,
      ),
    )
    await expect(scrape(input)).rejects.toBeInstanceOf(
      ProviderItemNotFoundError,
    )
  })

  it('compares barcodes ignoring leading zeros', async () => {
    const { tracks, items } = tidalTrackRange(1)
    const input = context()
    respond(
      input,
      tidalAlbumsDocument(
        [tidalAlbumFixture(items, { barcodeId: '0012345678901' })],
        tracks,
      ),
    )
    await expect(scrape(input)).resolves.toBeDefined()
  })

  it('reports two albums for one UPC as ambiguous', async () => {
    const first = tidalTrackRange(1)
    const second = tidalTrackRange(1, 1, 10)
    const input = context()
    respond(
      input,
      tidalAlbumsDocument(
        [
          tidalAlbumFixture(first.items),
          tidalAlbumFixture(second.items, { id: '900000002' }),
        ],
        [...first.tracks, ...second.tracks],
      ),
    )
    await expect(scrape(input)).rejects.toBeInstanceOf(
      ProviderItemAmbiguousError,
    )
  })

  it('skips a rejected album and uses the other', async () => {
    const first = tidalTrackRange(1)
    const second = tidalTrackRange(1, 1, 10)
    const input = context()
    input.isRejectedMatch = (ref) => ref.externalId === tidalAlbumId
    respond(
      input,
      tidalAlbumsDocument(
        [
          tidalAlbumFixture(first.items),
          tidalAlbumFixture(second.items, { id: '900000002' }),
        ],
        [...first.tracks, ...second.tracks],
      ),
    )
    const result = await scrape(input)
    expect(result.normalized.references?.[0]?.externalId).toBe('900000002')
  })

  it('reports not found when the only album is rejected', async () => {
    const input = context()
    input.isRejectedMatch = () => true
    respond(input, simpleAlbum())
    await expect(scrape(input)).rejects.toBeInstanceOf(
      ProviderItemNotFoundError,
    )
  })
})

describe('TIDAL album tracks', () => {
  it('follows the cursor across two pages for a 23-track album', async () => {
    const first = tidalTrackRange(20)
    const second = tidalTrackRange(3, 1, 20)
    const secondItems = second.items.map((item, index) =>
      tidalItem(item.id, 21 + index),
    )
    const input = context()
    const request = respond(
      input,
      tidalAlbumsDocument(
        [
          tidalAlbumFixture(first.items, {
            numberOfItems: 23,
            nextCursor: 'cursor-2',
          }),
        ],
        first.tracks,
      ),
      tidalItemsPage(secondItems, second.tracks),
    )
    const result = await scrape(input)
    const page = urlOf(request, 2)
    expect(page.pathname).toBe(`/v2/albums/${tidalAlbumId}/relationships/items`)
    expect(page.searchParams.get('page[cursor]')).toBe('cursor-2')
    expect(page.searchParams.get('include')).toBe('items')
    expect(page.searchParams.get('countryCode')).toBe('AU')
    const tracks = result.normalized.tracks ?? []
    expect(tracks).toHaveLength(23)
    expect(tracks.map((track) => track.position)).toEqual(
      Array.from({ length: 23 }, (_, index) => index + 1),
    )
    expect(tracks[22]?.externalId).toBe('800000023')
    expect(result.payload).toMatchObject({
      album: expect.anything(),
      itemPages: [expect.anything()],
    })
  })

  it('omits itemPages for a single page', async () => {
    const input = context()
    respond(input, simpleAlbum())
    const result = await scrape(input)
    expect(result.payload).not.toHaveProperty('itemPages')
  })

  it('sorts by volume and track number and numbers positions across volumes', async () => {
    const tracks = [
      tidalTrackFixture('800000001', 'Disc 2 Track 1'),
      tidalTrackFixture('800000002', 'Disc 1 Track 2'),
      tidalTrackFixture('800000003', 'Disc 1 Track 1'),
      tidalTrackFixture('800000004', 'Disc 2 Track 2'),
    ]
    const items = [
      tidalItem('800000001', 1, 2),
      tidalItem('800000002', 2, 1),
      tidalItem('800000003', 1, 1),
      tidalItem('800000004', 2, 2),
    ]
    const input = context()
    respond(input, tidalAlbumsDocument([tidalAlbumFixture(items)], tracks))
    const result = await scrape(input)
    expect(
      result.normalized.tracks?.map((track) => [track.position, track.title]),
    ).toEqual([
      [1, 'Disc 1 Track 1'],
      [2, 'Disc 1 Track 2'],
      [3, 'Disc 2 Track 1'],
      [4, 'Disc 2 Track 2'],
    ])
    expect(
      result.normalized.tracks?.[2]?.references?.[0]?.metadata,
    ).toMatchObject({ volumeNumber: 2, trackNumber: 1 })
  })

  it('throws for duplicate positions', async () => {
    const tracks = [
      tidalTrackFixture('800000001', 'One'),
      tidalTrackFixture('800000002', 'Two'),
    ]
    const items = [tidalItem('800000001', 1), tidalItem('800000002', 1)]
    const input = context()
    respond(input, tidalAlbumsDocument([tidalAlbumFixture(items)], tracks))
    await expect(scrape(input)).rejects.toThrow(
      'Duplicate TIDAL track positions',
    )
  })

  it('throws when an included track is missing', async () => {
    const { tracks, items } = tidalTrackRange(2)
    const input = context()
    respond(
      input,
      tidalAlbumsDocument([tidalAlbumFixture(items)], tracks.slice(0, 1)),
    )
    await expect(scrape(input)).rejects.toThrow(
      'Incomplete TIDAL track listing',
    )
  })

  it('throws when an item has no position', async () => {
    const { tracks } = tidalTrackRange(1)
    const input = context()
    const album = tidalAlbumFixture([])
    respond(input, {
      ...tidalAlbumsDocument([album], tracks),
      data: [
        {
          ...album,
          relationships: {
            items: { data: [{ id: '800000001', type: 'tracks' }] },
          },
        },
      ],
    })
    await expect(scrape(input)).rejects.toThrow('no position')
  })

  it('throws when the album has no tracks', async () => {
    const input = context()
    respond(input, tidalAlbumsDocument([tidalAlbumFixture([])]))
    await expect(scrape(input)).rejects.toThrow('has no tracks')
  })

  it('throws for a repeated cursor', async () => {
    const first = tidalTrackRange(2)
    const second = tidalTrackRange(2, 1, 2)
    const input = context()
    respond(
      input,
      tidalAlbumsDocument(
        [tidalAlbumFixture(first.items, { nextCursor: 'same' })],
        first.tracks,
      ),
      tidalItemsPage(
        second.items.map((item, index) => tidalItem(item.id, 3 + index)),
        second.tracks,
        'same',
      ),
    )
    await expect(scrape(input)).rejects.toThrow(
      'Invalid TIDAL track pagination',
    )
  })

  it('throws for an empty continuation page', async () => {
    const first = tidalTrackRange(2)
    const input = context()
    respond(
      input,
      tidalAlbumsDocument(
        [tidalAlbumFixture(first.items, { nextCursor: 'next' })],
        first.tracks,
      ),
      tidalItemsPage([], []),
    )
    await expect(scrape(input)).rejects.toThrow('changed during pagination')
  })

  it('throws for an album that declares more than 500 items', async () => {
    const { tracks, items } = tidalTrackRange(2)
    const input = context()
    respond(
      input,
      tidalAlbumsDocument(
        [tidalAlbumFixture(items, { numberOfItems: 501 })],
        tracks,
      ),
    )
    await expect(scrape(input)).rejects.toThrow('500-track safety limit')
  })

  it('throws when pagination passes 500 items', async () => {
    const first = tidalTrackRange(20)
    const input = context()
    const pages: unknown[] = [
      tidalAlbumsDocument(
        [tidalAlbumFixture(first.items, { nextCursor: 'cursor-0' })],
        first.tracks,
      ),
    ]
    for (let page = 1; page <= 30; page += 1) {
      const range = tidalTrackRange(20, 1, page * 20)
      pages.push(
        tidalItemsPage(
          range.items.map((item, index) =>
            tidalItem(item.id, page * 20 + index + 1),
          ),
          range.tracks,
          `cursor-${page}`,
        ),
      )
    }
    respond(input, ...pages)
    await expect(scrape(input)).rejects.toThrow(
      'Invalid TIDAL track pagination',
    )
  })
})

describe('TIDAL normalized result', () => {
  it('returns the album reference, link and track references', async () => {
    const tracks = [
      tidalTrackFixture('800000001', 'Opening', {
        isrc: 'XXTST0000001',
        duration: 'PT4M28S',
      }),
      tidalTrackFixture('800000002', 'Closing', {
        version: 'Radio Edit',
        isrc: 'XXTST0000002',
        duration: 'PT1H2M3S',
        bpm: 120.5,
        key: 'Ab',
        keyScale: 'MINOR',
      }),
      tidalTrackFixture('800000003', 'Short', {
        duration: 'PT45S',
        bpm: null,
        key: 'UNKNOWN',
        keyScale: 'UNKNOWN',
      }),
    ]
    const items = tracks.map((track, index) => tidalItem(track.id, index + 1))
    const input = context()
    respond(input, tidalAlbumsDocument([tidalAlbumFixture(items)], tracks))
    const result = await scrape(input)
    const url = `https://tidal.com/browse/album/${tidalAlbumId}`
    expect(result.normalized.references).toEqual([
      {
        referenceType: 'album',
        externalId: tidalAlbumId,
        isPrimary: true,
        metadata: { url, matchedBy: 'upc', barcodeId: tidalUpc },
      },
      { referenceType: 'upc', externalId: tidalUpc, isPrimary: false },
    ])
    expect(result.normalized.links).toEqual([
      { provider: 'tidal', label: 'TIDAL', url },
    ])
    const [first, second, third] = result.normalized.tracks ?? []
    expect(first).toMatchObject({
      externalId: '800000001',
      title: 'Opening',
      position: 1,
      durationSec: 268,
      isrc: 'XXTST0000001',
    })
    expect(first).not.toHaveProperty('version')
    expect(first?.references).toEqual([
      {
        referenceType: 'track',
        externalId: '800000001',
        isPrimary: true,
        metadata: {
          url: 'https://tidal.com/browse/track/800000001',
          version: null,
          durationSec: 268,
          popularity: 0.25,
          tidalAlbumId,
          volumeNumber: 1,
          trackNumber: 1,
        },
      },
    ])
    expect(second).toMatchObject({
      title: 'Closing (Radio Edit)',
      version: 'Radio Edit',
      durationSec: 3723,
    })
    expect(second?.references?.[0]?.metadata).toMatchObject({
      version: 'Radio Edit',
      bpm: 120.5,
      key: 'Ab',
      keyScale: 'MINOR',
    })
    expect(third?.durationSec).toBe(45)
    const thirdMetadata = third?.references?.[0]?.metadata ?? {}
    expect(thirdMetadata).not.toHaveProperty('bpm')
    expect(thirdMetadata).not.toHaveProperty('key')
    expect(thirdMetadata).not.toHaveProperty('keyScale')
  })

  it('omits an unknown ISRC and an unreadable duration', async () => {
    const track = tidalTrackFixture('800000001', 'Opening', {
      duration: 'bad',
      isrc: null,
    })
    const input = context()
    respond(
      input,
      tidalAlbumsDocument(
        [tidalAlbumFixture([tidalItem('800000001', 1)])],
        [track],
      ),
    )
    const result = await scrape(input)
    expect(result.normalized.tracks?.[0]).not.toHaveProperty('isrc')
    expect(result.normalized.tracks?.[0]).not.toHaveProperty('durationSec')
  })
})

describe('TIDAL helpers', () => {
  it('reads ISO durations', () => {
    expect(tidalDurationSec('PT4M28S')).toBe(268)
    expect(tidalDurationSec('PT1H2M3S')).toBe(3723)
    expect(tidalDurationSec('PT45S')).toBe(45)
    expect(tidalDurationSec('PT1.6S')).toBe(2)
    expect(tidalDurationSec('P1DT1S')).toBe(86401)
    expect(tidalDurationSec('PT0S')).toBe(0)
  })

  it('returns null for missing or invalid durations', () => {
    expect(tidalDurationSec(undefined)).toBeNull()
    expect(tidalDurationSec('')).toBeNull()
    expect(tidalDurationSec('P')).toBeNull()
    expect(tidalDurationSec('PT')).toBeNull()
    expect(tidalDurationSec('4:28')).toBeNull()
    expect(tidalDurationSec('PT-5S')).toBeNull()
  })

  it('reads the next cursor from links.meta, then from links.next', () => {
    expect(nextPageCursor({ meta: { nextCursor: 'abc' } })).toBe('abc')
    expect(
      nextPageCursor({
        next: '/albums/1/relationships/items?countryCode=AU&page%5Bcursor%5D=xyz',
      }),
    ).toBe('xyz')
    expect(nextPageCursor({ next: '/albums/1/relationships/items' })).toBeNull()
    expect(nextPageCursor({ self: '/x' })).toBeNull()
    expect(nextPageCursor(undefined)).toBeNull()
  })
})
