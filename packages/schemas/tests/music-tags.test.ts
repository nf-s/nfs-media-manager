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
})
