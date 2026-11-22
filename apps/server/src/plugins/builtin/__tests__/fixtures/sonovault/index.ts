/** Invented Sonovault payloads shaped like the OpenAPI specification. */

export type SonovaultFixtureTrackOptions = {
  title?: string
  duration?: number | null
  isrc?: string | null
}

export function sonovaultTrackFixture(
  id: number,
  options: SonovaultFixtureTrackOptions = {},
) {
  return {
    id,
    title: options.title ?? `Fixture Track ${id}`,
    duration: options.duration === undefined ? 200 : options.duration,
    isrc:
      options.isrc === undefined
        ? `QZSV${String(id).padStart(8, '0').slice(-8)}`
        : options.isrc,
    bpm: 124,
    key_alphanumeric: '8A',
    key_musical: 'A minor',
    key_open: '1m',
    keys: [
      {
        key_alphanumeric: '8A',
        key_musical: 'A minor',
        key_open: '1m',
        source: 'fixture-analyser',
      },
    ],
    artists: [
      { id: 7001, name: 'Fixture Artist', is_primary: true, is_remixer: false },
    ],
    genre: ['Fixture Genre'],
    subgenre: [],
    releases: [
      {
        id: 8001,
        title: 'Fixture Release',
        artist: { id: 7001, name: 'Fixture Artist' },
        label: { id: 9001, name: 'Fixture Label' },
        release_date: '2020-01-01',
      },
    ],
  }
}

export function sonovaultLinksFixture(id: number, spotifyId: string) {
  return [
    {
      source: 'spotify' as const,
      external_id: spotifyId,
      url: `https://open.spotify.com/track/${spotifyId}`,
    },
    {
      source: 'tidal' as const,
      external_id: `55${id}`,
      url: `https://tidal.com/browse/track/55${id}`,
    },
    {
      source: 'musicbrainz' as const,
      external_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      url: null,
    },
  ]
}

type FixtureLine = {
  input: string
  status: 'matched' | 'not_found' | 'skipped_no_credits'
  track: ReturnType<typeof sonovaultTrackFixture> | null
  links: ReturnType<typeof sonovaultLinksFixture>
}

export const sonovaultMatchedLine = (
  input: string,
  track: ReturnType<typeof sonovaultTrackFixture>,
  links: ReturnType<typeof sonovaultLinksFixture> = [],
): FixtureLine => ({ input, status: 'matched', track, links })

export const sonovaultMissLine = (
  input: string,
  status: 'not_found' | 'skipped_no_credits' = 'not_found',
): FixtureLine => ({ input, status, track: null, links: [] })

export function sonovaultBulkFixture(
  results: FixtureLine[],
  creditsRemaining = 40000,
) {
  const charged = results.filter(
    (line) => line.status !== 'skipped_no_credits',
  ).length
  return {
    results,
    partial: charged < results.length,
    processed: charged,
    credits_used: charged,
    credits_remaining: creditsRemaining,
    message: null,
  }
}
