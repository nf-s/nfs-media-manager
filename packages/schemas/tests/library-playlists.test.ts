import { describe, expect, it } from 'vitest'
import { convertSavedView } from '../src/imports'
import {
  LibraryPlaylistSelectionSchema,
  parseLibraryBrowseView,
  savedViewParams,
} from '../src/library-playlists'
import { SourceDescriptorSchema } from '../src/playback'
import { PlaybackDiagnosticInputSchema } from '../src/playback-diagnostics'

describe('library playlist views', () => {
  it('writes a legacy saved view as the Albums Browse parameters', () => {
    const view = convertSavedView({
      name: 'Quiet evenings',
      filters: [
        { field: 'genres', value: 'Ambient' },
        { field: 'dateReleased', min: 1, max: 2 },
      ],
      sort: ['title', 'ASC'],
      limit: 30,
    })
    if (!view) throw new Error('The view did not convert')
    const params = savedViewParams({
      ...view,
      tagLevels: ['album'],
      listeningSort: { kind: 'all' },
    })
    expect(params).toEqual({
      filters: JSON.stringify([
        { field: 'genre', value: 'Ambient', mode: 'any' },
      ]),
      ranges: JSON.stringify([
        { field: 'releaseDate', min: 1, max: 2, includeMissing: false },
      ]),
      tagLevels: 'album',
      listeningSort: JSON.stringify({ kind: 'all' }),
      sortBy: 'title',
      direction: 'asc',
      limitResults: '30',
    })
    const parsed = parseLibraryBrowseView('albums', params)
    expect(parsed.success && parsed.data.query).toMatchObject({
      sortBy: 'title',
      limitResults: 30,
      tagLevels: ['album'],
    })
    expect(convertSavedView({ name: 'Broken', filters: 'none' })).toBeNull()
  })

  it('rejects layout and unknown parameters and keeps the library', () => {
    expect(parseLibraryBrowseView('tracks', { view: 'grid' })).toEqual({
      success: false,
      issues: ['view: A layout setting is not part of a view'],
    })
    expect(
      parseLibraryBrowseView('films', { creatorRole: 'actor' }).success,
    ).toBe(true)
    expect(parseLibraryBrowseView('albums', { creatorRole: 'actor' })).toEqual({
      success: false,
      issues: ['creatorRole: Not a Browse parameter of this library'],
    })
    const mixes = parseLibraryBrowseView('mixes', { q: 'dub' })
    expect(mixes.success && mixes.data).toMatchObject({
      library: 'mixes',
      query: { library: 'mixes', q: 'dub' },
    })
  })

  it('accepts IDs or a query with exclusions, not both', () => {
    expect(
      LibraryPlaylistSelectionSchema.parse({ query: { q: 'rain' } }),
    ).toEqual({ query: { q: 'rain' }, excludeIds: [] })
    expect(
      LibraryPlaylistSelectionSchema.safeParse({
        ids: ['a'],
        query: { q: 'rain' },
      }).success,
    ).toBe(false)
    expect(LibraryPlaylistSelectionSchema.safeParse({ ids: [] }).success).toBe(
      false,
    )
  })
})

describe('library playlist playback', () => {
  it('is a source a saved session and a diagnostic can name', () => {
    expect(
      SourceDescriptorSchema.parse({
        type: 'library-playlist',
        id: 'fixture-playlist',
        library: 'albums',
      }),
    ).toEqual({
      type: 'library-playlist',
      id: 'fixture-playlist',
      library: 'albums',
    })
    expect(
      SourceDescriptorSchema.safeParse({
        type: 'library-playlist',
        id: 'fixture-playlist',
        library: 'mixes',
      }).success,
    ).toBe(false)
    expect(
      PlaybackDiagnosticInputSchema.shape.source.parse('library-playlist'),
    ).toBe('library-playlist')
  })
})
