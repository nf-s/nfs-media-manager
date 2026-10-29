import { describe, expect, it } from 'vitest'
import { importMediaType } from './import-media-type'

describe('import media scope', () => {
  it('preserves the declared scope for running, failed and unchanged imports', () => {
    expect(importMediaType({ albums: 0, films: 0, mediaType: 'album' })).toBe(
      'album',
    )
    expect(importMediaType({ albums: 0, films: 0, mediaType: 'film' })).toBe(
      'film',
    )
  })
  it('infers historical single-library runs without mislabelling mixed imports', () => {
    expect(importMediaType({ albums: 1, films: 0 })).toBe('album')
    expect(importMediaType({ albums: 0, films: 2 })).toBe('film')
    expect(importMediaType({ albums: 1, films: 2 })).toBeNull()
    expect(importMediaType({ albums: 0, films: 0 })).toBeNull()
    expect(importMediaType(null)).toBeNull()
    expect(importMediaType({ albums: 1, films: 0, mediaType: null })).toBeNull()
  })
})
