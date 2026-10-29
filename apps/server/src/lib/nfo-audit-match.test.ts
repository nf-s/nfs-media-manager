import { describe, expect, it } from 'vitest'
import {
  matchNfoFile,
  remapNfoPath,
  type NfoAuditFile,
} from './nfo-audit-match'

const mappings = [{ from: '/old/movies', to: '/current/movies' }]
const file: NfoAuditFile = {
  path: '/current/movies/Film (2000)/renamed.nfo',
  createdAt: '2020-01-01T00:00:00.000Z',
  references: [{ referenceType: 'imdb', externalId: 'tt123' }],
}
describe('NFO audit matching', () => {
  it('maps roots, not arbitrary substrings or parent traversal', () => {
    expect(remapNfoPath('/old/movies/Film/movie.nfo', mappings)).toBe(
      '/current/movies/Film/movie.nfo',
    )
    expect(remapNfoPath('/old/movies/../../outside.nfo', mappings)).toBeNull()
    expect(remapNfoPath('/old/movies-extra/a.nfo', mappings)).toBe(
      '/old/movies-extra/a.nfo',
    )
  })
  it('resolves renamed files within the exact mapped directory', () => {
    expect(
      matchNfoFile(['/old/movies/Film (2000)/movie.nfo'], [], [file], mappings)
        .file,
    ).toEqual(file)
  })
  it('never chooses a common basename across directories', () => {
    expect(
      matchNfoFile(
        ['/old/movies/Other/movie.nfo'],
        [],
        [{ ...file, path: '/current/movies/Film/movie.nfo' }],
        mappings,
      ).file,
    ).toBeUndefined()
  })
  it('requires unique IDs and rejects conflicting IDs even at exact paths', () => {
    expect(matchNfoFile([], file.references, [file], mappings).file).toEqual(
      file,
    )
    expect(
      matchNfoFile(
        [],
        file.references,
        [file, { ...file, path: '/current/movies/duplicate.nfo' }],
        mappings,
      ).file,
    ).toBeUndefined()
    expect(
      matchNfoFile(
        [file.path],
        [{ referenceType: 'imdb', externalId: 'tt999' }],
        [file],
        mappings,
      ).file,
    ).toBeUndefined()
  })
  it('rejects multiple NFOs in a directory without an exact file or unique ID', () => {
    expect(
      matchNfoFile(
        ['/old/movies/Film (2000)/movie.nfo'],
        [],
        [file, { ...file, path: '/current/movies/Film (2000)/second.nfo' }],
        mappings,
      ).file,
    ).toBeUndefined()
  })
})
