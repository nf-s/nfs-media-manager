import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  ArtistSearchAmbiguousError,
  lookupArtistProvider,
} from '../artist-providers'
import { corroborateLastFmArtist } from '../lastfm-artist-recordings'

const artistName = 'Fixture Ensemble'
const artistUrl = 'https://www.last.fm/music/Fixture+Ensemble'
const artistMbid = '11111111-1111-4111-8111-111111111111'
const otherMbid = '22222222-2222-4222-8222-222222222222'
const artist = { name: artistName, mbid: artistMbid, url: artistUrl }
const candidate = { id: artistMbid, name: artistName, url: artistUrl }
const firstTitle = 'Fixture Track One'
const secondTitle = 'Fixture Track Two'
const albumTitle = 'Fixture Release'
const trackMbid = '33333333-3333-4333-8333-333333333333'
const trackInfo = {
  name: firstTitle,
  mbid: trackMbid,
  artist,
  url: artistUrl + '/_/Fixture+Track+One',
  album: { title: albumTitle, artist: artistName },
}

const knownRecordings = (...titles: string[]) =>
  titles.map((title) => ({ title, albumName: null }))

function lastFmContext(response: Response) {
  return {
    request: vi.fn<MediaPluginTestContext['request']>(async () => response),
    secrets: { apiKey: 'fixture-lastfm-key' },
    recordDiagnostic: vi.fn(),
    searched: vi.fn(async () => undefined),
  }
}

function catalog(...tracks: unknown[]) {
  return lastFmContext(
    Response.json({
      toptracks: { '@attr': { artist: artistName }, track: tracks },
    }),
  )
}

describe('Last.fm artist recording evidence', () => {
  it('verifies one linked recording through its exactly credited release', async () => {
    const context = lastFmContext(Response.json({ track: trackInfo }))
    await expect(
      corroborateLastFmArtist(
        artistName,
        [candidate],
        async () => [{ title: firstTitle, albumName: albumTitle, trackMbid }],
        context,
      ),
    ).resolves.toMatchObject({
      artistMbid,
      artistUrl,
      matchedTitles: [firstTitle],
      releaseEvidence: { albumTitle, albumArtist: artistName, trackMbid },
    })
    expect(context.request).toHaveBeenCalledTimes(1)
    const url = new URL(String(context.request.mock.calls[0]?.[0]))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      method: 'track.getInfo',
      mbid: trackMbid,
      autocorrect: '0',
    })
    expect(url.searchParams.has('track')).toBe(false)
  })

  it('verifies a release with a URL-only candidate and a stored track title', async () => {
    const context = lastFmContext(
      Response.json({
        track: {
          ...trackInfo,
          mbid: '',
          artist: { ...artist, mbid: '' },
          album: { ...trackInfo.album, url: artistUrl + '/Fixture+Release' },
        },
      }),
    )
    await expect(
      corroborateLastFmArtist(
        artistName,
        [{ ...candidate, id: artistUrl }],
        async () => [{ title: firstTitle, albumName: albumTitle }],
        context,
      ),
    ).resolves.toMatchObject({
      artistUrl,
      matchedTitles: [firstTitle],
      releaseEvidence: { albumTitle, trackMbid: null },
    })
    const url = new URL(String(context.request.mock.calls[0]?.[0]))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      method: 'track.getInfo',
      artist: artistName,
      track: firstTitle,
      autocorrect: '0',
    })
    expect(context.request).toHaveBeenCalledTimes(1)
  })

  it.each([
    { album: undefined },
    { album: { title: albumTitle } },
    { album: { title: albumTitle, artist: 'Various Artists' } },
    { album: { title: albumTitle + ' (Deluxe Edition)', artist: artistName } },
    {
      album: {
        ...trackInfo.album,
        url: 'https://www.last.fm/music/Other+Fixture/Fixture+Release',
      },
    },
    { artist: { ...artist, name: artistName + ' & Other Fixture' } },
    { artist: { ...artist, mbid: otherMbid } },
    { artist: { ...artist, url: 'https://www.last.fm/music/Other+Fixture' } },
    { name: secondTitle },
    { mbid: otherMbid },
  ])(
    'leaves single-track corroboration unresolved when the track or release disagrees',
    async (override) => {
      const context = lastFmContext(
        Response.json({ track: { ...trackInfo, ...override } }),
      )
      await expect(
        corroborateLastFmArtist(
          artistName,
          [candidate],
          async () => [{ title: firstTitle, albumName: albumTitle, trackMbid }],
          context,
        ),
      ).resolves.toBeNull()
      expect(context.request).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { recordings: [{ title: firstTitle, albumName: null }] },
    {
      recordings: [
        { title: firstTitle, albumName: albumTitle, trackMbid: 'invalid-mbid' },
      ],
    },
    {
      recordings: [
        { title: firstTitle, albumName: albumTitle },
        { title: firstTitle, albumName: 'Other Fixture Release' },
      ],
    },
    {
      recordings: [
        { title: firstTitle, albumName: albumTitle, trackMbid },
        { title: firstTitle, albumName: albumTitle, trackMbid: otherMbid },
      ],
    },
  ])(
    'skips track requests when stored release evidence is missing or ambiguous',
    async ({ recordings }) => {
      const context = lastFmContext(Response.json({ track: trackInfo }))
      await expect(
        corroborateLastFmArtist(
          artistName,
          [candidate],
          async () => recordings,
          context,
        ),
      ).resolves.toBeNull()
      expect(context.request).not.toHaveBeenCalled()
    },
  )

  it('stops an incomplete name search with one exact candidate and no library recording evidence', async () => {
    const context = lastFmContext(
      Response.json({
        results: {
          'opensearch:totalResults': '8',
          artistmatches: {
            artist: [
              { name: artistName, mbid: artistMbid, url: artistUrl },
              ...[1, 2, 3, 4].map((index) => ({
                name: `Fixture Ensemble ${index}`,
                url: `${artistUrl}+${index}`,
              })),
            ],
          },
        },
      }),
    )
    await expect(
      lookupArtistProvider('lastfm', artistName, null, context),
    ).rejects.toBeInstanceOf(ArtistSearchAmbiguousError)
    expect(context.request).toHaveBeenCalledTimes(1)
    expect(context.recordDiagnostic).toHaveBeenCalledWith({
      stage: 'artist.candidates',
      evidence: { total: 8, candidates: expect.any(Array) },
    })
  })

  it('corroborates a native MBID with two distinct matching recordings in one request', async () => {
    const context = catalog(
      { name: firstTitle, artist },
      { name: secondTitle.toUpperCase(), artist },
      {
        name: 'Unrelated Fixture Title',
        artist: { ...artist, mbid: otherMbid },
      },
    )
    await expect(
      corroborateLastFmArtist(
        artistName,
        [candidate, { ...candidate, name: 'Other Fixture' }],
        async () => knownRecordings(firstTitle, secondTitle),
        context,
      ),
    ).resolves.toMatchObject({
      candidate,
      artistMbid,
      artistUrl,
      matchedTitleCount: 2,
      matchedTitles: [firstTitle, secondTitle.toUpperCase()],
    })
    expect(context.request).toHaveBeenCalledTimes(1)
    const url = new URL(String(context.request.mock.calls[0]?.[0]))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      method: 'artist.getTopTracks',
      mbid: artistMbid,
      autocorrect: '0',
      page: '1',
      limit: '50',
    })
    expect(url.searchParams.has('artist')).toBe(false)
  })

  it('uses canonical Last.fm track links when the artist has no MBID', async () => {
    const context = catalog(
      { name: firstTitle, url: artistUrl + '/_/Fixture+Track+One' },
      { name: secondTitle, url: artistUrl + '/_/Fixture+Track+Two' },
    )
    await expect(
      corroborateLastFmArtist(
        artistName,
        [{ ...candidate, id: artistUrl }],
        async () => knownRecordings(firstTitle, secondTitle),
        context,
      ),
    ).resolves.toMatchObject({ artistUrl, matchedTitleCount: 2 })
    expect(context.request).toHaveBeenCalledTimes(1)
    const url = new URL(String(context.request.mock.calls[0]?.[0]))
    expect(url.searchParams.get('artist')).toBe(artistName)
    expect(url.searchParams.has('mbid')).toBe(false)
  })

  it('rejects duplicate exact-name candidates before reading the library or provider', async () => {
    const context = catalog()
    const loadTitles = vi.fn(async () =>
      knownRecordings(firstTitle, secondTitle),
    )
    await expect(
      corroborateLastFmArtist(
        artistName,
        [candidate, { ...candidate, id: otherMbid }],
        loadTitles,
        context,
      ),
    ).resolves.toBeNull()
    expect(loadTitles).not.toHaveBeenCalled()
    expect(context.request).not.toHaveBeenCalled()
  })

  it('does not count duplicate titles or remasters as independent recordings', async () => {
    const context = catalog()
    await expect(
      corroborateLastFmArtist(
        artistName,
        [candidate],
        async () =>
          knownRecordings(
            firstTitle,
            firstTitle.toUpperCase(),
            firstTitle + ' - Remastered',
          ),
        context,
      ),
    ).resolves.toBeNull()
    expect(context.request).not.toHaveBeenCalled()
  })

  it.each([
    { artist: { name: artistName, mbid: '', url: '' } },
    { artist: { ...artist, mbid: otherMbid } },
    { artist: { ...artist, name: 'Different Fixture Artist' } },
    {
      artist,
      url: 'https://www.last.fm/music/Different+Fixture+Artist/_/Fixture+Track+Two',
    },
    { artist, url: artistUrl + '/_/Fixture+Track+One' },
    {
      artist: { ...artist, url: 'https://www.last.fm/music/FIXTURE+ENSEMBLE' },
    },
  ])(
    'requires two recordings whose artist identities corroborate the candidate',
    async (track) => {
      const context = catalog(
        { name: firstTitle, artist },
        { name: secondTitle, ...track },
      )
      await expect(
        corroborateLastFmArtist(
          artistName,
          [candidate],
          async () => knownRecordings(firstTitle, secondTitle),
          context,
        ),
      ).resolves.toBeNull()
      expect(context.request).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects multiple MBIDs found on supporting tracks of one Last.fm artist URL', async () => {
    const context = catalog(
      { name: firstTitle, artist },
      { name: secondTitle, artist: { ...artist, mbid: otherMbid } },
    )
    await expect(
      corroborateLastFmArtist(
        artistName,
        [{ ...candidate, id: artistUrl }],
        async () => knownRecordings(firstTitle, secondTitle),
        context,
      ),
    ).resolves.toBeNull()
  })

  it.each([
    { status: 403, code: 'access-denied' },
    { status: 429, code: 'rate-limit' },
  ])('preserves Last.fm $status request errors', async ({ status, code }) => {
    const context = lastFmContext(new Response(null, { status }))
    await expect(
      corroborateLastFmArtist(
        artistName,
        [candidate],
        async () => knownRecordings(firstTitle, secondTitle),
        context,
      ),
    ).rejects.toMatchObject({ code })
    expect(context.request).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      message: 'Artist not found',
      recordings: knownRecordings(firstTitle, secondTitle),
    },
    {
      message: 'The artist you supplied could not be found.',
      recordings: knownRecordings(firstTitle, secondTitle),
    },
    {
      message: 'Track not found',
      recordings: [{ title: firstTitle, albumName: albumTitle }],
    },
    {
      message: 'The track you supplied could not be found.',
      recordings: [{ title: firstTitle, albumName: albumTitle }],
    },
  ])(
    'treats an exact Last.fm entity miss as absent recording evidence',
    async ({ message, recordings }) => {
      const context = lastFmContext(Response.json({ error: 6, message }))
      await expect(
        corroborateLastFmArtist(
          artistName,
          [candidate],
          async () => recordings,
          context,
        ),
      ).resolves.toBeNull()
      expect(context.request).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { error: 6, message: 'Track not found in this request' },
    { error: 6, message: 'Artist not found' },
    { error: 7, message: 'Track not found' },
  ])(
    'preserves other track lookup service errors',
    async ({ error, message }) => {
      const context = lastFmContext(Response.json({ error, message }))
      const recordings = [{ title: firstTitle, albumName: albumTitle }]
      await expect(
        corroborateLastFmArtist(
          artistName,
          [candidate],
          async () => recordings,
          context,
        ),
      ).rejects.toThrow(`Last.fm returned a service error (code ${error}).`)
      expect(context.request).toHaveBeenCalledTimes(1)
    },
  )
})
