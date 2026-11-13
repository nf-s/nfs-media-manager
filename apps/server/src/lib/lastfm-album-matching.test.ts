import { describe, expect, it } from 'vitest'
import {
  artistNameKey,
  baseTitleKey,
  createAlbumMatcher,
  plainKey,
  type MatchAlbum,
} from './lastfm-album-matching'

const albums: MatchAlbum[] = [
  {
    id: 'romance',
    title: 'Early Romance (Deluxe)',
    artists: ['Fixture Band'],
    tracks: ['Opening', 'Second Song', 'Closing'],
  },
  {
    id: 'plain',
    title: 'Plain Record',
    artists: ['Fixture Band'],
    tracks: ['One', 'Two', 'Three', 'Four'],
  },
  {
    id: 'plain-deluxe',
    title: 'Plain Record (Deluxe Edition)',
    artists: ['Fixture Band'],
    tracks: ['One', 'Two', 'Three', 'Four', 'Extra'],
  },
  {
    id: 'accent',
    title: 'Café Münster: Part 2.',
    artists: ['The Synthetic Örchestra'],
    tracks: ['Intro'],
  },
  {
    id: 'reissue',
    title: 'Machine Notes REDUX 1997 2017',
    artists: ['Fixture Band'],
    tracks: ['Signal', 'Noise'],
  },
  {
    id: 'mix',
    title: 'Mix Series: Selector',
    artists: ['Selector'],
    tracks: ['Guest Tune', 'Another Guest Tune', 'Mix Series: Selector'],
  },
  {
    id: 'duo',
    title: 'Two Days',
    artists: ['A. Fixture', 'Second Person'],
    tracks: ['Day One'],
  },
  {
    id: 'studio',
    title: 'Night Hall',
    artists: ['Fixture Band'],
    tracks: ['Lamp', 'Door', 'Stairs', 'Roof'],
  },
  { id: 'twin-a', title: 'Twins', artists: ['Pair'], tracks: [] },
  { id: 'twin-b', title: 'TWINS', artists: ['Pair'], tracks: [] },
]
const match = createAlbumMatcher(albums)
const link = (artistName: string, albumName: string, tracks: string[] = []) =>
  match({ artistName, albumName, tracks })

describe('scrobble name keys', () => {
  it('ignores accents, punctuation, apostrophes and ampersands', () => {
    expect(plainKey('  Don’t  Stop & Go! ')).toBe('dont stop and go')
    expect(plainKey('Røyksøpp Ærlig')).toBe('royksopp aerlig')
    expect(plainKey('!!!')).toBe('!!!')
    expect(artistNameKey('The Fixture Band')).toBe('fixture band')
  })

  it('removes edition, disc and format qualifiers from a title', () => {
    for (const title of [
      'Plain Record (Deluxe Edition)',
      'Plain Record [2011 Remaster]',
      'Plain Record - Disc 1',
      'Plain Record CD2',
      'Plain Record (Expanded Edition) [Explicit]',
      'Plain Record EP',
      'Plain Record - EP',
    ])
      expect(baseTitleKey(title)).toBe('plain record')
    expect(baseTitleKey('Plain Record (Live)')).toBe('plain record live')
    expect(baseTitleKey('(Deluxe)')).toBe('deluxe')
  })
})

describe('album matcher', () => {
  it('links the same title and credited artist exactly', () => {
    expect(link('fixture band', 'plain  record')).toEqual({
      albumId: 'plain',
      strategy: 'exact',
    })
    expect(link('Fixture Band', 'Plain Record (Deluxe Edition)')).toEqual({
      albumId: 'plain-deluxe',
      strategy: 'exact',
    })
  })

  it('links names that differ by accents, punctuation or a leading article', () => {
    expect(link('Synthetic Orchestra', 'Cafe Munster - Part 2')).toEqual({
      albumId: 'accent',
      strategy: 'normalized',
    })
  })

  it('links another edition of a title to the library edition', () => {
    expect(link('Fixture Band', 'Early Romance')).toEqual({
      albumId: 'romance',
      strategy: 'edition',
    })
    expect(link('Fixture Band', 'Early Romance - Deluxe')).toEqual({
      albumId: 'romance',
      strategy: 'normalized',
    })
    expect(link('Fixture Band', 'Night Hall [CD1]')).toEqual({
      albumId: 'studio',
      strategy: 'edition',
    })
  })

  it('prefers the unqualified album, then shared tracks, between editions', () => {
    expect(link('Fixture Band', 'Plain Record (Remastered)', ['One'])).toEqual({
      albumId: 'plain',
      strategy: 'edition',
    })
    expect(
      link('Fixture Band', 'Plain Record (Remastered)', ['One', 'Extra']),
    ).toEqual({ albumId: 'plain-deluxe', strategy: 'edition' })
  })

  it('links a collaborator credit to an album crediting one of the artists', () => {
    expect(link('A. Fixture & Second Person', 'Two Days')).toEqual({
      albumId: 'duo',
      strategy: 'edition',
    })
    expect(link('Second Person feat. Guest', 'Two Days')).toEqual({
      albumId: 'duo',
      strategy: 'edition',
    })
  })

  it('links a compilation track under its own artist by title and shared tracks', () => {
    expect(link('Guest', 'Mix Series: Selector', ['Guest Tune'])).toEqual({
      albumId: 'mix',
      strategy: 'title-tracks',
    })
    // A title track alone is a coincidence.
    expect(
      link('Stranger', 'Mix Series: Selector', ['Mix Series: Selector']),
    ).toEqual({ albumId: null, candidates: [] })
    expect(link('Stranger', 'Mix Series: Selector', ['Unrelated'])).toEqual({
      albumId: null,
      candidates: [],
    })
  })

  it('links a longer or shorter title that shares tracks', () => {
    expect(link('Fixture Band', 'Machine Notes', ['Signal'])).toEqual({
      albumId: 'reissue',
      strategy: 'title-prefix',
    })
    expect(link('Fixture Band', 'Machine Notes', ['Unrelated'])).toEqual({
      albumId: null,
      candidates: [],
    })
  })

  it('links a differently spelled title when most scrobbled tracks are on one album', () => {
    expect(
      link('Fixture Band', 'Nite Hall', [
        'Lamp',
        'Door (Remastered)',
        'Stairs - 2011 Remaster',
        'Roof',
      ]),
    ).toEqual({ albumId: 'studio', strategy: 'tracks' })
    expect(link('Fixture Band', 'Nite Hall', ['Lamp', 'Door'])).toEqual({
      albumId: null,
      candidates: [],
    })
  })

  it('does not treat live, remix or compilation releases as the studio album', () => {
    expect(
      link('Fixture Band', 'Night Hall Live', ['Lamp', 'Door', 'Stairs']),
    ).toEqual({ albumId: null, candidates: [] })
    expect(
      link('Fixture Band', 'The Best Of', ['Lamp', 'Door', 'Stairs']),
    ).toEqual({ albumId: null, candidates: [] })
  })

  it('reports equally fitting albums without choosing one', () => {
    expect(link('Pair', 'Twins')).toEqual({
      albumId: null,
      candidates: ['twin-a', 'twin-b'],
    })
  })

  it('leaves a name with no fitting album unmatched', () => {
    expect(link('Nobody', 'Nothing', ['One'])).toEqual({
      albumId: null,
      candidates: [],
    })
  })
})
