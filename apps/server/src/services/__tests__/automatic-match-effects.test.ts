import { describe, expect, it } from 'vitest'
import {
  membershipDetails,
  removedTracksEntry,
  trackRowStateEntry,
  type TrackRowImage,
} from '@/services/automatic-match-effects'
import { scrobbledAlbumId } from '@/services/lastfm-standalone-tracks'

const image: TrackRowImage = {
  sourceLabel: 'album',
  artworkUrl: null,
  metadata: null,
  spotifyTrackId: null,
  spotifyUrl: null,
  durationSec: null,
  isrc: null,
  spotifyAlbumId: null,
  albumName: null,
  albumId: 'fixture-album',
  albumStrategy: 'album-track-list',
  credits: [
    {
      artistId: 'fixture-artist',
      name: 'Fixture Artist',
      billingOrder: 0,
      creditedAs: null,
    },
  ],
}

describe('membershipDetails', () => {
  it('counts the album positions and playlist entries effects moved', () => {
    expect(
      membershipDetails([
        {
          type: 'track-position-move',
          recordIds: ['a', 'b'],
          payload: { positionIds: ['p1', 'p2'] },
        },
        {
          type: 'track-playlist-entry-move',
          recordIds: ['a', 'b'],
          payload: { entries: [{}] },
        },
        { type: 'match-rejections', recordIds: ['a'], payload: { rows: [] } },
      ]),
    ).toEqual({ counts: { position: 2, 'playlist-entry': 1 } })
  })

  it('has nothing to say when only names moved', () => {
    expect(membershipDetails([])).toBeNull()
  })
})

describe('trackRowStateEntry', () => {
  it('records nothing when the identity did not change', () => {
    expect(trackRowStateEntry('fixture-track', image, { ...image })).toBeNull()
  })

  it('keeps both images of a changed identity', () => {
    const after = { ...image, spotifyTrackId: 'FixtureSpotify00000001' }
    expect(trackRowStateEntry('fixture-track', image, after)).toEqual({
      type: 'track-row-state',
      recordIds: ['fixture-track'],
      payload: { id: 'fixture-track', before: image, after },
    })
  })
})

describe('removedTracksEntry', () => {
  it('lists the track a removed one was merged into', () => {
    expect(removedTracksEntry(['source'], 'target')).toEqual({
      type: 'automatic-track-presence',
      recordIds: ['source', 'target'],
      payload: { ids: ['source'], created: false, keptFrom: 'target' },
    })
  })
})

describe('scrobbledAlbumId', () => {
  const group = {
    artist_key: 'fixture artist',
    track_key: 'signal',
    artist_name: 'Fixture Artist',
    track_name: 'Signal',
    album_names: ['Fixture Album'],
    album_ids: ['fixture-album'],
    has_unlinked_album: false,
  }

  it('links a name to its one linked album', () => {
    expect(scrobbledAlbumId(group)).toBe('fixture-album')
  })

  it('leaves names with mixed or several albums unlinked', () => {
    expect(scrobbledAlbumId({ ...group, has_unlinked_album: true })).toBeNull()
    expect(
      scrobbledAlbumId({ ...group, album_ids: ['fixture-album', 'other'] }),
    ).toBeNull()
  })
})
