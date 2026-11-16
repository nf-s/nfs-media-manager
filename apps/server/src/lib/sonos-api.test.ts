import { describe, expect, it, vi } from 'vitest'
import {
  sonosCommand,
  sonosPlaying,
  sonosRedirectUri,
  sonosRooms,
  type SonosRequest,
} from './sonos-api'

const API = 'https://api.ws.sonos.com/control/api/v1'

function fakeSonos(responses: Record<string, unknown>) {
  const request: SonosRequest = vi.fn(async (url: string | URL) => {
    const body = responses[String(url)]
    if (body === undefined) throw new Error(`Unexpected request ${url}`)
    return Response.json(body)
  })
  return request
}

describe('Sonos Control API helpers', () => {
  it('accepts only the exact HTTPS callback URI', () => {
    expect(
      sonosRedirectUri('https://app.example.test/api/v1/sonos/callback'),
    ).toBe('https://app.example.test/api/v1/sonos/callback')
    for (const value of [
      'http://app.example.test/api/v1/sonos/callback',
      'http://127.0.0.1:4001/api/v1/sonos/callback',
      'https://app.example.test/api/v1/sonos/callback?next=x',
      'https://user:pass@app.example.test/api/v1/sonos/callback',
      'https://app.example.test/api/v1/youtube/callback',
    ])
      expect(() => sonosRedirectUri(value)).toThrow('HTTPS Sonos callback')
  })

  it('lists each group with its rooms, coordinator first, and the controls Sonos accepts', async () => {
    const request = fakeSonos({
      [`${API}/households`]: { households: [{ id: 'Sonos_house' }] },
      [`${API}/households/Sonos_house/groups`]: {
        groups: [
          {
            id: 'RINCON_B:1',
            name: 'Lounge + 1',
            coordinatorId: 'RINCON_B',
            playbackState: 'PLAYBACK_STATE_PLAYING',
            playerIds: ['RINCON_A', 'RINCON_B'],
          },
          {
            id: 'RINCON_C:2',
            name: 'Study',
            coordinatorId: 'RINCON_C',
            playerIds: ['RINCON_C'],
          },
        ],
        players: [
          { id: 'RINCON_A', name: 'Portable' },
          { id: 'RINCON_B', name: 'Lounge' },
          { id: 'RINCON_C', name: 'Study' },
        ],
      },
      [`${API}/groups/RINCON_B%3A1/playback`]: {
        playbackState: 'PLAYBACK_STATE_PLAYING',
        positionMillis: 1000,
        availablePlaybackActions: {
          canPause: true,
          canSkip: true,
          canSkipBack: true,
          canSeek: false,
        },
      },
      [`${API}/groups/RINCON_B%3A1/playbackMetadata`]: {
        container: { name: 'Fixture album', service: { name: 'Spotify' } },
        currentItem: {
          track: { name: 'Fixture track', artist: { name: 'Fixture artist' } },
        },
      },
      [`${API}/groups/RINCON_C%3A2/playback`]: {
        playbackState: 'PLAYBACK_STATE_SOMETHING_NEW',
      },
      [`${API}/groups/RINCON_C%3A2/playbackMetadata`]: {},
    })
    const result = await sonosRooms(request, 'fixture-token')
    expect(result).toEqual({
      households: [
        {
          id: 'Sonos_house',
          name: null,
          rooms: [
            {
              id: 'RINCON_B:1',
              name: 'Lounge + 1',
              players: ['Lounge', 'Portable'],
              state: 'playing',
              service: 'Spotify',
              track: 'Fixture track',
              artist: 'Fixture artist',
              actions: {
                pause: true,
                play: false,
                next: true,
                previous: true,
                seek: false,
              },
            },
            {
              id: 'RINCON_C:2',
              name: 'Study',
              players: ['Study'],
              state: null,
              service: null,
              track: null,
              artist: null,
              actions: {
                pause: false,
                play: false,
                next: false,
                previous: false,
                seek: false,
              },
            },
          ],
        },
      ],
    })
    expect(request).toHaveBeenCalledWith(`${API}/households`, {
      headers: { Authorization: 'Bearer fixture-token' },
    })
  })

  it('finds the group playing the Spotify track, using the device name between households', async () => {
    const track = 'spotify:track:ABCDEFGHIJKLMNOPQRSTUV'
    const group = (id: string, name: string) => ({
      id,
      name,
      coordinatorId: id,
      playbackState: 'PLAYBACK_STATE_PLAYING',
      playerIds: [id],
    })
    const playing = (objectId: string) => ({
      container: { type: 'spotify.connect' },
      currentItem: { track: { id: { serviceId: '12', objectId } } },
    })
    const request = fakeSonos({
      [`${API}/households`]: { households: [{ id: 'home' }, { id: 'other' }] },
      [`${API}/households/home/groups`]: {
        groups: [
          group('A', 'Lounge + 1'),
          { ...group('B', 'Study'), playbackState: 'PLAYBACK_STATE_IDLE' },
        ],
      },
      [`${API}/households/other/groups`]: { groups: [group('C', 'Kitchen')] },
      [`${API}/groups/A/playbackMetadata`]: playing(encodeURIComponent(track)),
      [`${API}/groups/C/playbackMetadata`]: playing(track),
      [`${API}/groups/A/playback`]: {
        playbackState: 'PLAYBACK_STATE_PLAYING',
        availablePlaybackActions: {
          canPlay: true,
          canPause: true,
          canSkip: true,
          canSkipBack: false,
          canSeek: true,
        },
      },
      [`${API}/groups/A/groupVolume`]: {
        volume: 25,
        muted: false,
        fixed: false,
      },
    })
    expect(
      await sonosPlaying(request, 'fixture-token', {
        trackUri: track,
        device: 'Lounge + 1',
      }),
    ).toEqual({
      group: {
        id: 'A',
        name: 'Lounge + 1',
        actions: {
          pause: true,
          play: true,
          next: true,
          previous: false,
          seek: true,
        },
        volume: 0.25,
      },
    })
    // An idle group's metadata is never read.
    expect(request).not.toHaveBeenCalledWith(
      `${API}/groups/B/playbackMetadata`,
      expect.anything(),
    )
    // Two groups play the track and neither has the reported name.
    expect(
      await sonosPlaying(request, 'fixture-token', {
        trackUri: track,
        device: 'Somewhere else',
      }),
    ).toEqual({ group: null })
  })

  it('sends each command to its Control API endpoint', async () => {
    const request: SonosRequest = vi.fn(async () => Response.json({}))
    await sonosCommand(request, 'fixture-token', 'A:1', { action: 'next' })
    await sonosCommand(request, 'fixture-token', 'A:1', {
      action: 'seek',
      positionMs: 30000,
    })
    await sonosCommand(request, 'fixture-token', 'A:1', {
      action: 'volume',
      volume: 0.456,
    })
    expect(vi.mocked(request).mock.calls).toEqual([
      [
        `${API}/groups/A%3A1/playback/skipToNextTrack`,
        expect.objectContaining({ method: 'POST', body: '{}' }),
      ],
      [
        `${API}/groups/A%3A1/playback/seek`,
        expect.objectContaining({ body: '{"positionMillis":30000}' }),
      ],
      [
        `${API}/groups/A%3A1/groupVolume`,
        expect.objectContaining({ body: '{"volume":46}' }),
      ],
    ])
  })
})
