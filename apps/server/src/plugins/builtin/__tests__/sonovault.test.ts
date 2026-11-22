import { describe, expect, it, vi } from 'vitest'
import { sonovaultPlugin } from '../sonovault'
import {
  SONOVAULT_API_BASE,
  SONOVAULT_MIN_SPACING_MS,
  SonovaultBulkResolveResponseSchema,
  SonovaultLinkSchema,
  SonovaultResolveResultSchema,
  SonovaultTrackSchema,
  resolveSonovaultTracks,
  sonovaultGatedPlugin,
  sonovaultLinkReferenceTypes,
  sonovaultLinkUrl,
  sonovaultSettings,
  type SonovaultRequest,
} from '@/lib/sonovault-api'
import {
  sonovaultLookupInput,
  verifySonovaultRecord,
} from '@/services/sonovault-track-lookup'
import {
  sonovaultBulkFixture,
  sonovaultLinksFixture,
  sonovaultMatchedLine,
  sonovaultMissLine,
  sonovaultTrackFixture,
} from './fixtures/sonovault'

const spotifyId = 'FixtureSpotifyTrack001'
const isrc = 'QZSV00000001'

function mockRequest(body: unknown, status = 200) {
  return vi.fn<SonovaultRequest>(async () => Response.json(body, { status }))
}

describe('Sonovault payload schemas', () => {
  it('accepts the specification shapes', () => {
    const track = sonovaultTrackFixture(101)
    expect(SonovaultTrackSchema.parse(track)).toEqual(track)
    const minimal = {
      ...sonovaultTrackFixture(102, { duration: null, isrc: null }),
      bpm: null,
      key_alphanumeric: null,
      key_musical: null,
      key_open: null,
      keys: [],
      artists: [],
      genre: [],
      releases: [],
    }
    expect(SonovaultTrackSchema.parse(minimal)).toEqual(minimal)
    for (const link of sonovaultLinksFixture(101, spotifyId))
      expect(SonovaultLinkSchema.parse(link)).toEqual(link)
    const body = sonovaultBulkFixture([
      sonovaultMatchedLine(
        spotifyId,
        track,
        sonovaultLinksFixture(101, spotifyId),
      ),
      sonovaultMissLine('FixtureSpotifyTrack002'),
      sonovaultMissLine('FixtureSpotifyTrack003', 'skipped_no_credits'),
    ])
    expect(SonovaultBulkResolveResponseSchema.parse(body)).toEqual(body)
    expect(body.partial).toBe(true)
  })

  it.each([
    ['an unknown status', { status: 'pending' }],
    ['a text track ID', { track: { ...sonovaultTrackFixture(1), id: '1' } }],
    [
      'an unknown link source',
      { links: [{ source: 'napster', external_id: '1', url: null }] },
    ],
    [
      'an empty link ID',
      { links: [{ source: 'spotify', external_id: '', url: null }] },
    ],
    [
      'a negative duration',
      { track: sonovaultTrackFixture(1, { duration: -3 }) },
    ],
    ['missing links', { links: undefined }],
  ])('rejects a line with %s', (_label, change) => {
    const line = {
      ...sonovaultMatchedLine(spotifyId, sonovaultTrackFixture(1)),
      ...change,
    }
    expect(SonovaultResolveResultSchema.safeParse(line).success).toBe(false)
  })

  it('rejects a bulk response without its credit counts', () => {
    expect(
      SonovaultBulkResolveResponseSchema.safeParse({
        ...sonovaultBulkFixture([sonovaultMissLine(isrc)]),
        credits_remaining: undefined,
      }).success,
    ).toBe(false)
    expect(
      SonovaultBulkResolveResponseSchema.safeParse({
        ...sonovaultBulkFixture([sonovaultMissLine(isrc)]),
        credits_used: -1,
      }).success,
    ).toBe(false)
  })
})

describe('resolveSonovaultTracks', () => {
  it('sends one POST with the key header and the JSON body', async () => {
    const track = sonovaultTrackFixture(101)
    const request = mockRequest(
      sonovaultBulkFixture([
        sonovaultMatchedLine(spotifyId, track),
        sonovaultMissLine('FixtureSpotifyTrack002'),
      ]),
    )
    const result = await resolveSonovaultTracks(
      request,
      'fixture-key',
      'spotify_id',
      [spotifyId, 'FixtureSpotifyTrack002'],
    )
    expect(result.results.map((line) => line.status)).toEqual([
      'matched',
      'not_found',
    ])
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0] ?? []
    expect(String(url)).toBe(`${SONOVAULT_API_BASE}/v1/tracks/resolve`)
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('x-api-key')).toBe('fixture-key')
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({
      input_type: 'spotify_id',
      items: [spotifyId, 'FixtureSpotifyTrack002'],
    })
  })

  it('refuses a response with a different number of lines', async () => {
    const request = mockRequest(sonovaultBulkFixture([sonovaultMissLine(isrc)]))
    await expect(
      resolveSonovaultTracks(request, 'fixture-key', 'isrc', [
        isrc,
        'QZSV00000002',
      ]),
    ).rejects.toThrow('different number of lines')
  })

  it('refuses a malformed response and a failed request', async () => {
    await expect(
      resolveSonovaultTracks(
        mockRequest({ results: 'none' }),
        'fixture-key',
        'isrc',
        [isrc],
      ),
    ).rejects.toThrow()
    await expect(
      resolveSonovaultTracks(
        mockRequest({ message: 'Unauthorized' }, 401),
        'fixture-key',
        'isrc',
        [isrc],
      ),
    ).rejects.toThrow('HTTP 401')
  })

  it('refuses empty, oversized and mismatched inputs without a request', async () => {
    const request = mockRequest(sonovaultBulkFixture([]))
    await expect(
      resolveSonovaultTracks(request, 'fixture-key', 'isrc', []),
    ).rejects.toThrow()
    await expect(
      resolveSonovaultTracks(
        request,
        'fixture-key',
        'isrc',
        Array.from(
          { length: 101 },
          (_, index) => `QZSV${String(index).padStart(8, '0')}`,
        ),
      ),
    ).rejects.toThrow()
    await expect(
      resolveSonovaultTracks(request, 'fixture-key', 'track_name', [isrc]),
    ).rejects.toThrow('track_name')
    await expect(
      resolveSonovaultTracks(request, 'fixture-key', 'isrc', [
        { artist: 'Fixture Artist', title: 'Fixture Track' },
      ]),
    ).rejects.toThrow('track_name')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('Sonovault settings', () => {
  it('uses the Starter plan defaults', () => {
    expect(sonovaultSettings({ apiKey: ' fixture-key ' })).toEqual({
      apiKey: 'fixture-key',
      requestsPerMinute: 60,
      monthlyCredits: 50000,
      creditReserve: 2000,
    })
    expect(
      sonovaultSettings({
        apiKey: 'fixture-key',
        requestsPerMinute: ' ',
        monthlyCredits: '',
      }),
    ).toMatchObject({ requestsPerMinute: 60, monthlyCredits: 50000 })
  })

  it('reads set values, including a zero reserve', () => {
    expect(
      sonovaultSettings({
        apiKey: 'fixture-key',
        requestsPerMinute: '30',
        monthlyCredits: '100000',
        creditReserve: '0',
      }),
    ).toEqual({
      apiKey: 'fixture-key',
      requestsPerMinute: 30,
      monthlyCredits: 100000,
      creditReserve: 0,
    })
  })

  it.each([
    [{}, 'API key is missing'],
    [{ apiKey: '  ' }, 'API key is missing'],
    [{ apiKey: 'k', requestsPerMinute: '0' }, 'requests per minute'],
    [{ apiKey: 'k', requestsPerMinute: '1.5' }, 'requests per minute'],
    [{ apiKey: 'k', monthlyCredits: 'many' }, 'monthly credits'],
    [{ apiKey: 'k', creditReserve: '-1' }, 'credit reserve'],
  ])('rejects %j', (secrets, message) => {
    expect(() => sonovaultSettings(secrets)).toThrow(message)
  })
})

describe('Sonovault request spacing', () => {
  it.each([
    [60, 1100],
    [120, 1100],
    [50, 1200],
    [30, 2000],
    [7, 8572],
  ])('spaces requests for %i a minute %i ms apart', (rpm, spacing) => {
    const gated = sonovaultGatedPlugin(sonovaultPlugin, {
      requestsPerMinute: rpm,
    })
    expect(gated.manifest.rateLimit.minTimeMs).toBe(spacing)
    expect(gated.manifest.rateLimit).toMatchObject({
      maxConcurrent: 12,
      concurrentRequests: true,
      respectRateLimitHeaders: true,
      retryAfterIsAuthoritative: true,
      ietfRateLimitHeaders: true,
    })
    expect(sonovaultPlugin.manifest.rateLimit.minTimeMs).toBe(
      SONOVAULT_MIN_SPACING_MS,
    )
  })
})

describe('Sonovault links', () => {
  it('maps every link source to its reference type', () => {
    expect(sonovaultLinkReferenceTypes).toEqual({
      spotify: 'spotify-track',
      applemusic: 'applemusic-track',
      tidal: 'tidal-track',
      beatport: 'beatport-track',
      musicbrainz: 'musicbrainz-recording',
      discogs: 'discogs-release-track',
      youtube: 'youtube-video',
    })
  })

  it.each([
    ['https://tidal.com/browse/track/1', 'https://tidal.com/browse/track/1'],
    ['http://tidal.com/browse/track/1', null],
    ['javascript:alert(1)', null],
    ['not a url', null],
    [null, null],
  ])('keeps only https URLs: %s', (url, expected) => {
    expect(sonovaultLinkUrl({ source: 'tidal', external_id: '1', url })).toBe(
      expected,
    )
  })
})

describe('verifySonovaultRecord', () => {
  const library = { title: 'Fixture Song', durationSec: 200 }
  it.each([
    [205, true],
    [195, true],
    [206, false],
    [194, false],
  ])('compares durations within five seconds: %i', (duration, expected) => {
    expect(
      verifySonovaultRecord(library, { title: 'Fixture Song', duration }),
    ).toBe(expected)
  })

  it('passes unknown durations', () => {
    expect(
      verifySonovaultRecord(
        { title: 'Fixture Song', durationSec: null },
        { title: 'Fixture Song', duration: 999 },
      ),
    ).toBe(true)
    expect(
      verifySonovaultRecord(library, { title: 'Fixture Song', duration: null }),
    ).toBe(true)
  })

  it('ignores case, punctuation and how version text is written', () => {
    expect(
      verifySonovaultRecord(
        { title: 'Fixture Song - Extended Mix', durationSec: 200 },
        { title: 'Fixture Song (Extended Mix)', duration: 200 },
      ),
    ).toBe(true)
    expect(
      verifySonovaultRecord(
        { title: "fixture song's", durationSec: 200 },
        { title: "FIXTURE SONG'S", duration: 200 },
      ),
    ).toBe(true)
  })

  it('fails another version', () => {
    expect(
      verifySonovaultRecord(
        { title: 'Fixture Song (Radio Edit)', durationSec: 200 },
        { title: 'Fixture Song', duration: 200 },
      ),
    ).toBe(false)
    expect(
      verifySonovaultRecord(
        { title: 'Fixture Song', durationSec: 200 },
        { title: 'Other Fixture Song', duration: 200 },
      ),
    ).toBe(false)
  })
})

describe('sonovaultLookupInput', () => {
  it('prefers a valid Spotify track ID', () => {
    expect(sonovaultLookupInput({ spotifyTrackId: spotifyId, isrc })).toEqual({
      inputType: 'spotify_id',
      input: spotifyId,
    })
    expect(
      sonovaultLookupInput({ spotifyTrackId: ` ${spotifyId} `, isrc: null }),
    ).toEqual({ inputType: 'spotify_id', input: spotifyId })
  })

  it.each([null, '', 'short', `${spotifyId}X`, 'FixtureSpotifyTrack-01'])(
    'falls back to the ISRC when the Spotify ID is %j',
    (spotifyTrackId) => {
      expect(sonovaultLookupInput({ spotifyTrackId, isrc })).toEqual({
        inputType: 'isrc',
        input: isrc,
      })
    },
  )

  it('normalizes the ISRC', () => {
    expect(
      sonovaultLookupInput({ spotifyTrackId: null, isrc: 'qz-sv0-00-00001' }),
    ).toEqual({ inputType: 'isrc', input: isrc })
  })

  it('returns null without a valid identifier', () => {
    expect(sonovaultLookupInput({ spotifyTrackId: null, isrc: null })).toBe(
      null,
    )
    expect(
      sonovaultLookupInput({ spotifyTrackId: 'short', isrc: 'NOT-AN-ISRC' }),
    ).toBe(null)
  })
})
