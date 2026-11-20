import { expect, it, vi } from 'vitest'
import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import {
  createProviderResponseRecorder,
  createProviderResponseReplay,
  type ProviderResponseCapture,
} from '@/lib/provider-response-history'
import {
  replayProviderSearchTask,
  searchSpotifyCatalogTracks,
} from '../provider-search-task-replay'

it('retains valid track popularity and Spotify order in fresh and archived search results', async () => {
  const input = {
    query: 'track:"Signal" artist:"Example Artist"',
    market: 'AU',
  }
  const track = {
    type: 'track',
    name: 'Signal',
    artists: [{ name: 'Example Artist' }],
    duration_ms: 241000,
  }
  const responseBody = {
    tracks: {
      offset: 0,
      items: [
        { ...track, id: 'A'.repeat(22), popularity: 0 },
        { ...track, id: 'B'.repeat(22), popularity: 100 },
        { ...track, id: 'A'.repeat(22), popularity: 60 },
        { ...track, id: 'C'.repeat(22) },
        { ...track, id: 'D'.repeat(22), popularity: 101 },
        { ...track, id: 'E'.repeat(22), popularity: 42.5 },
        { ...track, id: 'F'.repeat(22), popularity: '60' },
        { ...track, id: 'G'.repeat(22), popularity: null },
        { ...track, id: 'H'.repeat(22), popularity: -1 },
        { ...track, id: 'I'.repeat(22), popularity: 99, is_playable: false },
      ],
    },
  }
  const captures: ProviderResponseCapture[] = []
  const beginCapture = createProviderResponseRecorder(async (capture) => {
    captures.push(capture)
  }, [])('task')
  const request = vi.fn<MediaPluginTestContext['request']>(async (...args) => {
    await beginCapture(...args)?.({
      status: 200,
      receivedAt: '2026-01-01T00:00:00.000Z',
      contentType: 'application/json',
      body: { state: 'captured', text: JSON.stringify(responseBody) },
    })
    return Response.json(responseBody)
  })

  const fresh = await searchSpotifyCatalogTracks(
    request,
    'fixture-token',
    input,
  )
  expect(request).toHaveBeenCalledTimes(1)
  expect(fresh.map((candidate) => candidate.spotifyTrackId)).toEqual(
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => id.repeat(22)),
  )
  expect(fresh.slice(0, 2).map((candidate) => candidate.popularity)).toEqual([
    0, 100,
  ])
  for (const candidate of fresh.slice(2))
    expect(candidate).not.toHaveProperty('popularity')

  const replay = createProviderResponseReplay(captures)
  await expect(
    replayProviderSearchTask(
      SPOTIFY_TRACK_SEARCH_TASK,
      [{ operation: 'track-search', args: input }],
      replay.requestFor('task'),
    ),
  ).resolves.toStrictEqual([fresh])
  replay.assertComplete()
})
