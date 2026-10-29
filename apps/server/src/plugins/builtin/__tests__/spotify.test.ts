import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderRequestError,
  type MediaPluginScrapeContext,
} from '@repo/media-plugin-sdk'
import { spotifyPlugin } from '../spotify'
import {
  normalizeSpotifyAlbum,
  spotifyAlbumId as parseId,
  spotifyAuthorization,
  spotifyRedirectUri,
} from '@/lib/spotify-api'
import {
  spotifyAlbumFixture,
  spotifyAlbumId,
  spotifyTokenFixture,
} from './fixtures/spotify'

function context(
  references: MediaPluginScrapeContext['existingReferences'],
): MediaPluginScrapeContext {
  return {
    mediaItemId: 'canonical-album',
    mediaType: 'album',
    existingReferences: references,
    media: { title: 'Example Album', artists: ['Example Artist'] },
    secrets: { clientId: 'client', clientSecret: 'secret' },
    request: vi.fn(),
    log: vi.fn(async () => undefined),
  }
}
function scrape(input: MediaPluginScrapeContext) {
  if (!spotifyPlugin.scrapeMediaItem)
    throw new Error('Spotify scraper not registered')
  return spotifyPlugin.scrapeMediaItem(input)
}

describe('Spotify read-only album adapter', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('No live requests allowed')
      }),
    ),
  )
  afterEach(() => vi.unstubAllGlobals())

  it('uses legacy Spotify-owned album IDs directly and preserves missing UPCs', async () => {
    const input = context([
      {
        referenceType: 'album',
        externalId: spotifyAlbumId,
        isPrimary: true,
        metadata: { sourceProvider: 'spotify' },
      },
      {
        referenceType: 'upc',
        externalId: '012345678901',
        isPrimary: false,
        metadata: { sourceProvider: 'spotify' },
      },
    ])
    const album = {
      ...spotifyAlbumFixture(),
      external_ids: undefined,
      popularity: undefined,
    }
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(spotifyTokenFixture))
      .mockResolvedValueOnce(Response.json(album))
    input.request = request
    const result = await scrape(input)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      body: 'grant_type=client_credentials',
      headers: {
        Authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`,
      },
    })
    expect(String(request.mock.calls[1]?.[0])).toBe(
      `https://api.spotify.com/v1/albums/${spotifyAlbumId}`,
    )
    expect(result.normalized.references).toEqual([
      { referenceType: 'album', externalId: spotifyAlbumId, isPrimary: true },
      { referenceType: 'upc', externalId: '012345678901', isPrimary: false },
    ])
    expect(result.normalized.albumPatch?.dateAdded).toBeUndefined()
    expect(result.normalized.albumPatch?.metadata?.['browse']).toEqual({})
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never consumes another provider generic album ID and requires an exact name match', async () => {
    const input = context([
      {
        referenceType: 'album',
        externalId: spotifyAlbumId,
        isPrimary: true,
        metadata: { sourceProvider: 'other' },
      },
    ])
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(spotifyTokenFixture))
      .mockResolvedValueOnce(
        Response.json({
          albums: {
            items: [{ ...spotifyAlbumFixture(), name: 'Example Album Deluxe' }],
            total: 1,
          },
        }),
      )
    input.request = request
    await expect(scrape(input)).rejects.toThrow('No exact Spotify album match')
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe(
      '/v1/search',
    )
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects ambiguous exact matches instead of choosing the first release', async () => {
    const input = context([])
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(spotifyTokenFixture))
      .mockResolvedValueOnce(
        Response.json({
          albums: {
            items: [
              spotifyAlbumFixture(),
              { ...spotifyAlbumFixture(), id: 'abcdefghijklmnopqrstuv' },
            ],
            total: 2,
          },
        }),
      )
    input.request = request
    await expect(scrape(input)).rejects.toThrow('ambiguous')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('accepts exact artist/title matches and confirms UPC search against full album metadata', async () => {
    for (const refs of [
      [],
      [{ referenceType: 'upc', externalId: '012345678901', isPrimary: true }],
    ]) {
      const input = context(refs)
      input.request = vi
        .fn()
        .mockResolvedValueOnce(Response.json(spotifyTokenFixture))
        .mockResolvedValueOnce(
          Response.json({
            albums: { items: [spotifyAlbumFixture()], total: 1 },
          }),
        )
        .mockResolvedValueOnce(Response.json(spotifyAlbumFixture()))
      expect((await scrape(input)).normalized.mediaPatch?.title).toBe(
        'Example Album',
      )
    }
  })

  it('does not mistake one name-matched search result for the requested UPC', async () => {
    const input = context([
      { referenceType: 'upc', externalId: '999999999999', isPrimary: true },
    ])
    input.request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(spotifyTokenFixture))
      .mockResolvedValueOnce(
        Response.json({ albums: { items: [spotifyAlbumFixture()], total: 1 } }),
      )
      .mockResolvedValueOnce(Response.json(spotifyAlbumFixture()))
    await expect(scrape(input)).rejects.toThrow('identity does not match')
  })

  it('paginates tracks through fixed trusted endpoints and preserves disc order', async () => {
    const input = context([
      { referenceType: 'spotify', externalId: spotifyAlbumId, isPrimary: true },
    ])
    const album = spotifyAlbumFixture()
    const first = album.tracks.items[0]
    if (!first) throw new Error('Fixture track missing')
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(spotifyTokenFixture))
      .mockResolvedValueOnce(
        Response.json({
          ...album,
          total_tracks: 2,
          tracks: {
            ...album.tracks,
            total: 2,
            next: 'https://untrusted.invalid/steal',
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          offset: 1,
          total: 2,
          next: null,
          items: [{ ...first, name: 'Disc two', disc_number: 2 }],
        }),
      )
    input.request = request
    const result = await scrape(input)
    expect(String(request.mock.calls[2]?.[0])).toBe(
      `https://api.spotify.com/v1/albums/${spotifyAlbumId}/tracks?limit=50&offset=1`,
    )
    expect(result.normalized.tracks.map((track) => track.position)).toEqual([
      1, 2,
    ])
    expect(result.normalized.albumPatch?.durationSec).toBe(241)
  })

  it('stops immediately on gate failures without retries or further album calls', async () => {
    const input = context([
      { referenceType: 'spotify', externalId: spotifyAlbumId, isPrimary: true },
    ])
    const request = vi
      .fn()
      .mockRejectedValue(new ProviderRequestError('Rate limit', 'rate-limit'))
    input.request = request
    await expect(scrape(input)).rejects.toThrow('Rate limit')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('sanitizes malformed token responses instead of leaking a response fragment', async () => {
    const input = context([
      { referenceType: 'spotify', externalId: spotifyAlbumId, isPrimary: true },
    ])
    input.request = vi
      .fn()
      .mockResolvedValue(
        new Response('{"access_token":"sensitive-fragment",broken'),
      )
    await expect(scrape(input)).rejects.toThrow(
      'Spotify returned an invalid token response',
    )
  })

  it('does not write incomplete tracks or derived durations and strips playback/audio fields', () => {
    const album = spotifyAlbumFixture()
    const result = normalizeSpotifyAlbum({
      ...album,
      audioFeatures: [{ energy: 0.5 }],
      tracks: { ...album.tracks, next: 'next', total: 2 },
    })
    expect(result.normalized.tracks).toEqual([])
    expect(result.normalized.albumPatch?.durationSec).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('audioFeatures')
    expect(result.normalized.albumPatch?.metadata?.['browse']).toEqual({
      popularitySpotify: 0,
    })
    expect(result.normalized.links[0]?.url).toBe(
      `https://open.spotify.com/album/${spotifyAlbumId}`,
    )
  })

  it('validates Spotify IDs, not arbitrary URLs or track URIs', () => {
    expect(parseId(`spotify:album:${spotifyAlbumId}`)).toBe(spotifyAlbumId)
    expect(
      parseId(`https://open.spotify.com/album/${spotifyAlbumId}?si=example`),
    ).toBe(spotifyAlbumId)
    for (const value of [
      `spotify:track:${spotifyAlbumId}`,
      `https://evil.invalid/album/${spotifyAlbumId}`,
      `https://user@open.spotify.com/album/${spotifyAlbumId}`,
    ])
      expect(parseId(value)).toBeNull()
  })

  it('requests only saved-album read scope with fresh cryptographic state and PKCE', () => {
    const first = spotifyAuthorization(
      'client',
      'http://127.0.0.1:4001/api/v1/spotify/callback',
    )
    const next = spotifyAuthorization(
      'client',
      'http://127.0.0.1:4001/api/v1/spotify/callback',
    )
    expect(first.state).not.toBe(next.state)
    expect(first.verifier).not.toBe(next.verifier)
    const params = new URL(first.url).searchParams
    expect(params.get('scope')).toBe('user-library-read')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toHaveLength(43)
    expect(first.url).not.toContain(first.verifier)
  })

  it('rejects legacy localhost and wrong callback paths without changing configuration', () => {
    for (const value of [
      'http://localhost:4001/api/v1/spotify/callback',
      'http://127.0.0.1:8080/callback',
      'http://example.com/api/v1/spotify/callback',
      'https://example.com/api/v1/spotify/callback?next=evil',
    ])
      expect(() => spotifyRedirectUri(value)).toThrow()
    expect(
      spotifyRedirectUri('https://example.com/api/v1/spotify/callback'),
    ).toBe('https://example.com/api/v1/spotify/callback')
  })
})
