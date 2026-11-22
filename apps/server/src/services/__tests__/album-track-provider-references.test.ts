import { describe, expect, it } from 'vitest'
import type { PluginTrack } from '@repo/media-plugin-sdk'
import {
  alignProviderAlbumTracks,
  type LibraryAlbumTrack,
} from '../album-track-provider-references'

const library = (
  entries: Array<[title: string, durationSec: number | null]>,
): LibraryAlbumTrack[] =>
  entries.map(([title, durationSec], index) => ({
    trackMediaItemId: `library-${index + 1}`,
    position: index + 1,
    title,
    durationSec,
  }))

const provider = (
  entries: Array<[title: string, durationSec: number, version?: string]>,
): PluginTrack[] =>
  entries.map(([title, durationSec, version], index) => ({
    externalId: `${9000 + index + 1}`,
    title: version ? `${title} (${version})` : title,
    position: index + 1,
    durationSec,
    ...(version ? { version } : {}),
  }))

const pairs = (result: ReturnType<typeof alignProviderAlbumTracks>) =>
  result.map(({ library: entry, provider: match, alignment }) => [
    entry.trackMediaItemId,
    match.externalId,
    alignment,
  ])

describe('alignProviderAlbumTracks', () => {
  it('pairs equal lists by position when durations agree', () => {
    expect(
      pairs(
        alignProviderAlbumTracks(
          library([
            ['First fixture', 200],
            ['Second fixture', 181],
          ]),
          provider([
            ['First fixture (Remastered)', 202],
            ['Another name', 180],
          ]),
        ),
      ),
    ).toEqual([
      ['library-1', '9001', 'position-duration'],
      ['library-2', '9002', 'position-duration'],
    ])
  })

  it('falls back to titles when library durations are missing', () => {
    expect(
      pairs(
        alignProviderAlbumTracks(
          library([
            ['First  Fixture', null],
            ['Second fixture', null],
          ]),
          provider([
            ['first fixture', 200],
            ['Unrelated', 180],
          ]),
        ),
      ),
    ).toEqual([['library-1', '9001', 'position-title']])
  })

  it('compares the provider title without its version suffix', () => {
    expect(
      pairs(
        alignProviderAlbumTracks(
          library([['Fixture song', null]]),
          provider([['Fixture song', 240, 'Club Mix']]),
        ),
      ),
    ).toEqual([['library-1', '9001', 'position-title']])
  })

  it('aligns by title and duration when one side has a bonus track', () => {
    expect(
      pairs(
        alignProviderAlbumTracks(
          library([
            ['Opening fixture', 120],
            ['Middle fixture', 200],
            ['Closing fixture', 300],
          ]),
          provider([
            ['Opening fixture', 121],
            ['Middle fixture', 199],
            ['Bonus fixture', 150],
            ['Closing fixture', 302],
          ]),
        ),
      ),
    ).toEqual([
      ['library-1', '9001', 'title-duration'],
      ['library-2', '9002', 'title-duration'],
      ['library-3', '9004', 'title-duration'],
    ])
  })

  it('leaves tracks with a repeated title unaligned', () => {
    expect(
      pairs(
        alignProviderAlbumTracks(
          library([
            ['Interlude', 60],
            ['Song fixture', 200],
            ['Interlude', 61],
          ]),
          provider([
            ['Interlude', 60],
            ['Song fixture', 201],
            ['Extra fixture', 90],
            ['Interlude', 62],
          ]),
        ),
      ),
    ).toEqual([['library-2', '9002', 'title-duration']])
  })

  it('does not pair durations more than 3 seconds apart', () => {
    expect(
      pairs(
        alignProviderAlbumTracks(
          library([['Fixture one', 200]]),
          provider([['Other one', 204]]),
        ),
      ),
    ).toEqual([])
    expect(
      pairs(
        alignProviderAlbumTracks(
          library([['Fixture one', 200]]),
          provider([
            ['Fixture one', 204],
            ['Bonus', 100],
          ]),
        ),
      ),
    ).toEqual([])
  })

  it('pairs no provider track twice', () => {
    expect(
      pairs(
        alignProviderAlbumTracks(
          library([
            ['Same fixture', 200],
            ['Different', 500],
            ['Same fixture', 201],
          ]),
          provider([
            ['Same fixture', 200],
            ['Other', 100],
          ]),
        ),
      ),
    ).toEqual([])
  })
})
