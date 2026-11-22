import { describe, expect, it } from 'vitest'
import { musicDisplayTags } from '../src/music-tags'

describe('music tag fallback', () => {
  it('uses artist evidence only while release evidence is sparse', () => {
    expect(musicDisplayTags([], ['Ambient'])).toEqual([
      { name: 'Ambient', source: 'artist' },
    ])
    expect(musicDisplayTags(['Jazz'], ['Ambient'])).toEqual([
      { name: 'Jazz', source: 'album' },
      { name: 'Ambient', source: 'artist' },
    ])
    expect(musicDisplayTags(['Jazz', 'Soul'], ['Ambient'])).toEqual([
      { name: 'Jazz', source: 'album' },
      { name: 'Soul', source: 'album' },
    ])
  })

  it('counts normalized unique release tags and keeps their provenance', () => {
    expect(
      musicDisplayTags([' Jazz ', 'JAZZ', ''], ['jazz', 'Ambient', 'ambient']),
    ).toEqual([
      { name: 'Jazz', source: 'album' },
      { name: 'Ambient', source: 'artist' },
    ])
  })

  it('puts a track’s own tags first and shows each name once (TTAG-14)', () => {
    expect(
      musicDisplayTags(['JAZZ'], ['Ambient', 'Soul'], ['Soul', 'Jazz']),
    ).toEqual([
      { name: 'Soul', source: 'track' },
      { name: 'Jazz', source: 'track' },
      { name: 'Ambient', source: 'artist' },
    ])
    // The artist fallback still depends on the album's tags alone.
    expect(musicDisplayTags(['Jazz', 'Funk'], ['Ambient'], ['Soul'])).toEqual([
      { name: 'Soul', source: 'track' },
      { name: 'Jazz', source: 'album' },
      { name: 'Funk', source: 'album' },
    ])
  })
})
