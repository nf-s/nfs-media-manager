import { describe, expect, it } from 'vitest'
import { SpotifyTrackAuditItemSchema } from '@repo/schemas/spotify-track-search'
import { renderSpotifyReview } from './render'

const title =
  'Fixture <Library> & </script><script>throw new Error("escaped")</script>'
const query = 'fixture artist long edition and "library version"'
const likely = {
  spotifyTrackId: 'A'.repeat(22),
  spotifyUrl: `https://open.spotify.com/track/${'A'.repeat(22)}`,
  title: 'Fixture recording',
  artists: ['Fixture artist 1', 'Fixture artist 2'],
  albumName: 'Fixture Spotify record',
  durationSec: 196,
  assessment: 'likely',
  summary: 'Recording matches the available evidence.',
  reasons: [
    {
      code: 'alternate-coverage',
      explanation: 'The library has another playable version.',
      library: 'Fixture alternate',
      spotify: '',
    },
  ],
  searchedAt: '2026-01-25T12:00:00.000Z',
  historical: false,
  query,
}
const track = SpotifyTrackAuditItemSchema.parse({
  trackId: 'fixture-track',
  title,
  artists: ['Fixture credited artist'],
  albums: ['Fixture release'],
  durations: [195],
  assessment: 'likely',
  summary: 'Fixture summary.',
  candidates: [
    {
      ...likely,
      spotifyTrackId: 'B'.repeat(22),
      spotifyUrl: `https://open.spotify.com/track/${'B'.repeat(22)}`,
      assessment: 'unlikely',
    },
    likely,
  ],
})

function payload(html: string) {
  const json =
    /<script id="checklist" type="application\/json">([^\n]*)<\/script>/.exec(
      html,
    )?.[1]
  if (!json) throw new Error('Expected embedded checklist data')
  return JSON.parse(json)
}

describe('offline Spotify checklist', () => {
  it('embeds escaped original text, query, evidence and exactly one likely default', async () => {
    const html = await renderSpotifyReview([
      track,
      { ...track, trackId: 'fixture-review', assessment: 'review' },
    ])
    expect(html).not.toContain(title)
    expect(html).toContain('\\u003c/script\\u003e')
    expect(html).toContain('Content-Security-Policy')
    expect(html).not.toMatch(/<(?:script|img|link)[^>]+(?:src|href)=/i)
    const { tracks } = payload(html)
    expect(tracks).toMatchObject([
      {
        id: 'fixture-track',
        title,
        duration: '3:15',
        initialId: likely.spotifyTrackId,
        candidates: [
          expect.objectContaining({ assessment: 'unlikely' }),
          expect.objectContaining({
            id: likely.spotifyTrackId,
            query,
            reasons: likely.reasons,
            duration: '3:16',
          }),
        ],
      },
      { id: 'fixture-review', initialId: null },
    ])
  })

  it('rejects ambiguous export rows and IDs that cannot fit a tab-separated line', async () => {
    await expect(renderSpotifyReview([track, track])).rejects.toThrow(
      'duplicate library track IDs',
    )
    await expect(
      renderSpotifyReview([{ ...track, trackId: 'fixture\ttrack' }]),
    ).rejects.toThrow('cannot be represented')
  })
})
