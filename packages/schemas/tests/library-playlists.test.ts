import { describe, expect, it } from 'vitest'
import { convertSavedView } from '../src/imports'
import {
  LibraryPlaylistSelectionSchema,
  parseLibraryBrowseView,
  savedViewParams,
} from '../src/library-playlists'
import { SourceDescriptorSchema } from '../src/playback'
import { PlaybackDiagnosticInputSchema } from '../src/playback-diagnostics'
import { PlaylistBrowseQuerySchema } from '../src/tracks'

describe('playlist directory query', () => {
  it('parses column filters from URL parameters', () => {
    const columns = {
      count: { min: 0, max: 2 },
      duration: { min: 0.5 },
      checked: { max: '2024-02-29' },
    }
    expect(
      PlaylistBrowseQuerySchema.parse({
        types: '["playlist","smart"]',
        schedules: '["off","daily"]',
        columnRanges: JSON.stringify(columns),
        savedView: 'present',
        savedViewText: '  blue  ',
        timeZone: 'Australia/Hobart',
      }),
    ).toMatchObject({
      types: ['playlist', 'smart'],
      schedules: ['off', 'daily'],
      columnRanges: columns,
      savedView: 'present',
      savedViewText: 'blue',
      timeZone: 'Australia/Hobart',
    })
  })

  it('rejects malformed filters at the boundary', () => {
    const invalid = [
      { types: '["imported"]' },
      { schedules: '["sometimes"]' },
      { savedView: 'yes' },
      { timeZone: 'Unknown/Zone' },
      { timeZone: '+05:00' },
      { keyNotation: 'other' },
      { columnRanges: '{' },
      { columnRanges: { actions: { min: 0 } } },
      { columnRanges: { albums: { min: 0.5 } } },
      { columnRanges: { tracks: { min: '1' } } },
      { columnRanges: { duration: { max: -1 } } },
      { columnRanges: { count: { min: 2, max: 1 } } },
      { columnRanges: { added: { min: '2025-02-29' } } },
      { columnRanges: { added: { min: '0000-01-01' } } },
      { columnRanges: { imported: { min: '2025-01-02', max: '2025-01-01' } } },
    ]
    for (const params of invalid)
      expect(
        PlaylistBrowseQuerySchema.safeParse(params).success,
        JSON.stringify(params),
      ).toBe(false)
  })
})

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
