import { describe, expect, it } from 'vitest'
import {
  AlbumCsvPreviewInputSchema,
  ConfirmAlbumImportSchema,
} from '@repo/schemas/album-imports'
import { SpotifySavedAlbumsInputSchema } from '@repo/schemas/spotify'
import {
  albumCandidateKeys,
  albumImportId,
  albumReferenceKey,
  collectAlbumCsv,
} from './album-import-candidates'

function csv(content: string, format: 'album-csv' | 'upc-csv' = 'album-csv') {
  return collectAlbumCsv({ format, fileName: 'albums.csv', content })
}
describe('offline album CSV boundary', () => {
  it('imports title/artist albums without requiring Spotify identifiers', () => {
    const result = csv(
      'title,artist,date\n"Example, Album",Example Artist,2020-01-02',
    )
    const record = result.records[0]
    if (!record) throw new Error('Missing fixture record')
    expect(result.skipped).toBe(0)
    expect(record.result.normalized.references).toEqual([])
    expect(record.result.normalized.albumPatch?.dateAdded).toBe(
      '2020-01-02T00:00:00.000Z',
    )
    expect(albumImportId(record)).toMatch(/^album_[a-f0-9]{20}$/)
  })

  it('retains barcode leading zeroes and resolves CSV aliases to legacy identity', () => {
    const record = csv(
      'title,artist,upc,spotify\nAlbum,Artist,001234567890,spotify:album:1234567890abcdefghijkl',
      'upc-csv',
    ).records[0]
    if (!record) throw new Error('Missing fixture record')
    expect(
      record.result.normalized.references.some(
        (ref) => ref.externalId === '001234567890',
      ),
    ).toBe(true)
    expect(albumCandidateKeys(record)).toContain(
      albumReferenceKey('spotify', 'album', '1234567890abcdefghijkl'),
    )
    expect(
      albumReferenceKey('other', 'album', '1234567890abcdefghijkl'),
    ).toBeNull()
    expect(albumReferenceKey('spotify', 'upc', '001234567890')).toBe(
      albumReferenceKey('other', 'ean', '0001234567890'),
    )
  })

  it('skips invalid identifiers and ambiguous/non-ISO dates with bounded warnings', () => {
    const result = csv(
      'title,artist,upc,date\nAlbum,Artist,not-upc,2020-01-01\nAlbum,Artist,012345678901,01/02/2020\nAlbum,Artist,,2020-02-31',
    )
    expect(result.records).toEqual([])
    expect(result.skipped).toBe(3)
    expect(result.warnings).toHaveLength(3)
  })

  it('rejects non-album formats and UPC-only rows lacking descriptive identity', () => {
    expect(() => csv('upc,date\n012345678901,2020-01-01', 'upc-csv')).toThrow(
      'requires columns',
    )
    expect(
      AlbumCsvPreviewInputSchema.safeParse({ format: 'nfo', path: '/private' })
        .success,
    ).toBe(false)
    expect(
      ConfirmAlbumImportSchema.safeParse({ previewId: 'preview', rows: [] })
        .success,
    ).toBe(false)
  })

  it('bounds discovery and requires explicit broad confirmation', () => {
    expect(SpotifySavedAlbumsInputSchema.parse({})).toEqual({
      limit: 20,
      offset: 0,
      confirmBroadRun: false,
    })
    expect(SpotifySavedAlbumsInputSchema.safeParse({ limit: 51 }).success).toBe(
      false,
    )
    expect(
      SpotifySavedAlbumsInputSchema.safeParse({
        limit: 501,
        confirmBroadRun: true,
      }).success,
    ).toBe(false)
    expect(
      SpotifySavedAlbumsInputSchema.safeParse({
        limit: 100,
        confirmBroadRun: true,
      }).success,
    ).toBe(true)
  })
})
