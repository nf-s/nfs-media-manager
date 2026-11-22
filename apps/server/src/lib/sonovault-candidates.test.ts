import { describe, expect, it } from 'vitest'
import { SonovaultTrackSchema } from '@/lib/sonovault-api'
import { sonovaultTrackFixture } from '@/plugins/builtin/__tests__/fixtures/sonovault'
import {
  sonovaultCandidateArtists,
  sonovaultCandidateIsAutomatic,
  sonovaultCandidateSpotifyId,
} from './sonovault-candidates'

const record = (
  title: string,
  duration: number | null,
  artists = [
    { id: 1, name: 'Example Artist', is_primary: true, is_remixer: false },
  ],
) =>
  SonovaultTrackSchema.parse({
    ...sonovaultTrackFixture(100, { title, duration }),
    artists,
  })
const library = {
  title: 'Night Signal (Extended Mix)',
  artists: ['Example Artist'],
  durationSec: 300,
}

describe('sonovaultCandidateIsAutomatic', () => {
  it('accepts an equal artist, title with version text and duration', () => {
    expect(
      sonovaultCandidateIsAutomatic(
        library,
        record('Night Signal - Extended Mix', 304),
      ),
    ).toBe(true)
    expect(
      sonovaultCandidateIsAutomatic(
        { ...library, artists: ['EXAMPLE ARTIST'] },
        record('night signal (extended mix)', 296),
      ),
    ).toBe(true)
  })

  it('keeps other versions, artists and durations for review', () => {
    expect(
      sonovaultCandidateIsAutomatic(library, record('Night Signal', 300)),
    ).toBe(false)
    expect(
      sonovaultCandidateIsAutomatic(
        library,
        record('Night Signal (Extended Mix)', 306),
      ),
    ).toBe(false)
    expect(
      sonovaultCandidateIsAutomatic(
        library,
        record('Night Signal (Extended Mix)', 300, [
          { id: 2, name: 'Other Artist', is_primary: true, is_remixer: false },
        ]),
      ),
    ).toBe(false)
  })

  it('never accepts a track or record without a duration', () => {
    expect(
      sonovaultCandidateIsAutomatic(
        { ...library, durationSec: null },
        record('Night Signal (Extended Mix)', 300),
      ),
    ).toBe(false)
    expect(
      sonovaultCandidateIsAutomatic(
        library,
        record('Night Signal (Extended Mix)', null),
      ),
    ).toBe(false)
  })

  it('compares performers, not remixers', () => {
    const remixed = record('Night Signal (Fixture Remix)', 300, [
      { id: 1, name: 'Example Artist', is_primary: true, is_remixer: false },
      { id: 3, name: 'Fixture Remixer', is_primary: false, is_remixer: true },
    ])
    expect(sonovaultCandidateArtists(remixed)).toEqual(['Example Artist'])
    expect(
      sonovaultCandidateIsAutomatic(
        { ...library, title: 'Night Signal (Fixture Remix)' },
        remixed,
      ),
    ).toBe(true)
  })
})

describe('sonovaultCandidateSpotifyId', () => {
  it('reads a valid Spotify track ID from the links', () => {
    const line = {
      input: { artist: 'Example Artist', title: 'Night Signal' },
      status: 'matched' as const,
      track: null,
      links: [
        {
          source: 'spotify' as const,
          external_id: 'FixtureSpotifyTrack001',
          url: null,
        },
      ],
    }
    expect(sonovaultCandidateSpotifyId(line)).toBe('FixtureSpotifyTrack001')
    expect(
      sonovaultCandidateSpotifyId({
        ...line,
        links: [{ source: 'spotify', external_id: 'short', url: null }],
      }),
    ).toBeNull()
  })
})
