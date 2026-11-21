import { describe, expect, it } from 'vitest'
import {
  albumArtistCaution,
  albumTrackCaution,
  albumVersionCaution,
} from './album-merge-cautions'

const album = (id: string, artists: string[], tracks: string[]) => ({
  id,
  artists,
  tracks,
})

describe('album merge cautions', () => {
  it('names a version word that only some titles have', () => {
    expect(
      albumVersionCaution([
        'Harbour Lights',
        'Harbour Lights (Deluxe Edition)',
      ]),
    ).toEqual([{ code: 'version', words: ['Deluxe Edition'] }])
    expect(
      albumVersionCaution(['Harbour Lights', 'Harbour Lights - Live']),
    ).toEqual([{ code: 'version', words: ['Live'] }])
    expect(albumVersionCaution(['Harbour Lights', 'Harbour Lights'])).toEqual(
      [],
    )
    expect(
      albumVersionCaution(['Harbour Lights (Live)', 'Harbour Lights (live)']),
    ).toEqual([])
  })

  it('compares credited artists, ignoring albums without credits', () => {
    const kept = album('a', ['Fixture Band'], [])
    expect(albumArtistCaution(kept, [['Fixture Band & Guest']])).toEqual([])
    expect(albumArtistCaution(kept, [[]])).toEqual([])
    expect(albumArtistCaution(kept, [['Other Artist']])).toEqual([
      { code: 'artists', names: ['Fixture Band', 'Other Artist'] },
    ])
  })

  it('measures shared titles against the shorter track list', () => {
    const kept = album('a', [], ['Low Tide', 'Lanterns', 'Undertow'])
    const deluxe = album(
      'b',
      [],
      [
        'Low Tide',
        'Lanterns - Remastered',
        'Undertow',
        'Bonus Light',
        'Demo One',
      ],
    )
    expect(albumTrackCaution(kept, [deluxe])).toEqual([])
    const other = album('c', [], ['Dry Dock', 'Gulls', 'Low Tide'])
    expect(albumTrackCaution(kept, [other])).toEqual([
      { code: 'tracks', albums: [{ albumId: 'c', shared: 1, listed: 3 }] },
    ])
    expect(albumTrackCaution(kept, [album('d', [], [])])).toEqual([])
  })
})
