import { describe, expect, it } from 'vitest'
import { sonovaultReleaseFixture } from '@/plugins/builtin/__tests__/fixtures/sonovault/releases'
import {
  confirmSonovaultRelease,
  normalizedBarcode,
  positionedReleaseTracks,
  sonovaultAlbumReferences,
} from './sonovault-album-match'
import { SonovaultReleaseSchema } from './sonovault-api'

const group = '00000000-0000-4000-8000-00000000a001'
const otherGroup = '00000000-0000-4000-8000-00000000a002'
const spotifyAlbum = 'FixtureSpotifyAlbum001'

const release = (
  overrides: Partial<Parameters<typeof sonovaultReleaseFixture>[0]> = {},
) =>
  SonovaultReleaseSchema.parse(
    sonovaultReleaseFixture({
      id: 8102,
      tracks: [
        { id: 1, title: 'One', duration: 200, number: 1 },
        { id: 2, title: 'Two', duration: 210, number: 2 },
      ],
      editions: [
        { id: 501, source: 'spotify', externalId: spotifyAlbum },
        {
          id: 502,
          source: 'discogs',
          externalId: '7002',
          groupId: '222',
          barcode: '123456789012',
        },
        {
          id: 503,
          source: 'musicbrainz',
          externalId: '00000000-0000-4000-8000-00000000b001',
          groupId: group,
          tracksOnRow: 12,
        },
        {
          id: 504,
          source: 'musicbrainz',
          externalId: '00000000-0000-4000-8000-00000000b002',
          groupId: group,
          tracksOnRow: 2,
        },
      ],
      digitalUpc: '123456789012',
      releaseGroups: [group],
      ...overrides,
    }),
  )

const album = {
  spotifyAlbumId: null,
  upc: null,
  musicbrainzReleaseGroups: [],
  trackCount: 2,
}

describe('normalizedBarcode', () => {
  it('drops leading zeros and refuses anything but digits', () => {
    expect(normalizedBarcode('0123456789012')).toBe('123456789012')
    expect(normalizedBarcode(' 00123 ')).toBe('123')
    expect(normalizedBarcode('000')).toBeNull()
    expect(normalizedBarcode('12-34')).toBeNull()
    expect(normalizedBarcode(null)).toBeNull()
  })
})

describe('confirmSonovaultRelease', () => {
  it('never confirms by title', () => {
    expect(confirmSonovaultRelease(release(), album)).toBeNull()
  })

  it('confirms by the Spotify album and takes that edition first', () => {
    expect(
      confirmSonovaultRelease(release(), {
        ...album,
        spotifyAlbumId: spotifyAlbum,
        upc: '0123456789012',
        musicbrainzReleaseGroups: [group],
      }),
    ).toMatchObject({
      confirmedBy: ['spotify-album', 'upc', 'musicbrainz-release-group'],
      edition: { id: 501 },
    })
  })

  it('confirms by barcode with leading zeros ignored, on that edition', () => {
    expect(
      confirmSonovaultRelease(release(), { ...album, upc: '00123456789012' }),
    ).toMatchObject({ confirmedBy: ['upc'], edition: { id: 502 } })
  })

  it('confirms by the digital UPC alone, with no edition to renumber by', () => {
    const merged = release({
      editions: [{ id: 501, source: 'spotify', externalId: 'Other' }],
    })
    expect(
      confirmSonovaultRelease(merged, { ...album, upc: '123456789012' }),
    ).toEqual({ confirmedBy: ['upc'], edition: null })
  })

  it('confirms by release group on the edition closest in length', () => {
    expect(
      confirmSonovaultRelease(release(), {
        ...album,
        musicbrainzReleaseGroups: [group.toUpperCase()],
      }),
    ).toMatchObject({
      confirmedBy: ['musicbrainz-release-group'],
      edition: { id: 504 },
    })
    expect(
      confirmSonovaultRelease(release(), {
        ...album,
        musicbrainzReleaseGroups: [otherGroup],
      }),
    ).toBeNull()
  })
})

describe('positionedReleaseTracks', () => {
  it('numbers the tracks with a position by disc and track, leaving the rest out', () => {
    const tracks = positionedReleaseTracks(
      release({
        tracks: [
          { id: 1, title: 'Two-one', duration: 100, disc: 2, number: 1 },
          { id: 2, title: 'One-two', duration: 100, number: 2 },
          { id: 3, title: 'Bonus', duration: 100, number: null },
          { id: 4, title: 'One-one', duration: 100, isrc: null, number: 1 },
        ],
      }),
    )
    expect(tracks).toEqual([
      { externalId: '4', title: 'One-one', position: 1, durationSec: 100 },
      {
        externalId: '2',
        title: 'One-two',
        position: 2,
        durationSec: 100,
        isrc: 'QZSV00000002',
      },
      {
        externalId: '1',
        title: 'Two-one',
        position: 3,
        durationSec: 100,
        isrc: 'QZSV00000001',
      },
    ])
  })

  it('leaves out both tracks that claim one position', () => {
    expect(
      positionedReleaseTracks(
        release({
          tracks: [
            { id: 1, title: 'A', duration: 100, number: 1 },
            { id: 2, title: 'B', duration: 100, number: 1 },
            { id: 3, title: 'C', duration: 100, number: 2 },
          ],
        }),
      ).map(({ externalId, position }) => [externalId, position]),
    ).toEqual([['3', 1]])
  })
})

describe('sonovaultAlbumReferences', () => {
  it('lists the release, its UPC and each edition’s IDs once', () => {
    const rows = sonovaultAlbumReferences(
      release({
        editions: [
          { id: 501, source: 'spotify', externalId: spotifyAlbum },
          { id: 502, source: 'discogs', externalId: '7002', groupId: '222' },
          { id: 505, source: 'discogs', externalId: '7003', groupId: '222' },
          { id: 506, source: 'discogs', externalId: 'not-an-id' },
          {
            id: 503,
            source: 'musicbrainz',
            externalId: '00000000-0000-4000-8000-00000000B001',
            groupId: group,
          },
          { id: 507, source: 'beatport', externalId: '99' },
          { id: 508, source: 'applemusic', externalId: '1234' },
        ],
        digitalUpc: '0123456789012',
      }),
      505,
    )
    expect(
      rows.map(({ referenceType, externalId, editionId, matchedEdition }) => [
        referenceType,
        externalId,
        editionId,
        matchedEdition,
      ]),
    ).toEqual([
      ['sonovault-release', '8102', null, false],
      ['digital-upc', '123456789012', null, false],
      ['discogs-release', '7002', 502, false],
      ['discogs-master', '222', 505, true],
      ['discogs-release', '7003', 505, true],
      [
        'musicbrainz-release',
        '00000000-0000-4000-8000-00000000b001',
        503,
        false,
      ],
      ['musicbrainz-release-group', group, 503, false],
      ['beatport-release', '99', 507, false],
      ['applemusic-album', '1234', 508, false],
    ])
    expect(
      rows.find((row) => row.referenceType === 'discogs-master')?.url,
    ).toBe('https://www.discogs.com/master/222')
  })
})
