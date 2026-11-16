import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  sonosCommand,
  sonosContent,
  sonosGroupState,
  sonosPlaying,
  sonosRedirectUri,
  sonosRooms,
  type SonosRequest,
} from './sonos-api'

const API = 'https://api.ws.sonos.com/control/api/v1'

const track = 'spotify:track:ABCDEFGHIJKLMNOPQRSTUV'
const otherTrack = 'spotify:track:ZYXWVUTSRQPONMLKJIHGFE'

function group(id: string, name: string) {
  return {
    id,
    name,
    coordinatorId: id,
    playbackState: 'PLAYBACK_STATE_PLAYING',
    playerIds: [id],
  }
}

function playing(objectId?: string) {
  return {
    container: { type: 'spotify.connect' },
    currentItem: { track: { id: { serviceId: '12', objectId } } },
  }
}

function controllable(id: string) {
  return {
    [`${API}/groups/${id}/playback`]: {
      playbackState: 'PLAYBACK_STATE_PLAYING',
      availablePlaybackActions: { canPause: true },
    },
    [`${API}/groups/${id}/groupVolume`]: { volume: 40, fixed: false },
  }
}

const pauseOnly = {
  pause: true,
  play: false,
  next: false,
  previous: false,
  seek: false,
}

async function lookup(
  request: SonosRequest,
  playing: { trackUri: string; device: string },
) {
  return (await sonosPlaying(request, 'fixture-token', playing, new Set()))
    .result
}

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
    const { result, accounts } = await sonosRooms(
      request,
      'fixture-token',
      new Set(),
    )
    expect(accounts).toEqual([])
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
              playable: false,
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
              playable: false,
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
      await lookup(request, {
        trackUri: track,
        device: 'Lounge + 1',
      }),
    ).toEqual({
      group: {
        id: 'A',
        name: 'Lounge + 1',
        household: 'home',
        playable: false,
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
    // Both households' groups are read before any group's metadata.
    expect(
      vi
        .mocked(request)
        .mock.calls.slice(0, 5)
        .map(([url]) => String(url)),
    ).toEqual([
      `${API}/households`,
      `${API}/households/home/groups`,
      `${API}/households/other/groups`,
      `${API}/groups/A/playbackMetadata`,
      `${API}/groups/C/playbackMetadata`,
    ])
    // An idle group's metadata is never read.
    expect(request).not.toHaveBeenCalledWith(
      `${API}/groups/B/playbackMetadata`,
      expect.anything(),
    )
    // Two groups play the track and neither has the reported name.
    expect(
      await lookup(request, {
        trackUri: track,
        device: 'Somewhere else',
      }),
    ).toEqual({ group: null })
  })

  it('uses the named group playing Spotify when Sonos still reports an earlier track', async () => {
    const request = fakeSonos({
      [`${API}/households`]: { households: [{ id: 'home' }, { id: 'other' }] },
      [`${API}/households/home/groups`]: {
        groups: [group('A', 'Lounge'), group('B', 'Study')],
      },
      [`${API}/households/other/groups`]: { groups: [group('C', 'Kitchen')] },
      [`${API}/groups/A/playbackMetadata`]: playing(otherTrack),
      [`${API}/groups/B/playbackMetadata`]: playing('x-sonos-http:fixture.mp3'),
      [`${API}/groups/C/playbackMetadata`]: playing(),
      ...controllable('A'),
    })
    expect(
      await lookup(request, {
        trackUri: track,
        device: 'Lounge',
      }),
    ).toEqual({
      group: {
        id: 'A',
        name: 'Lounge',
        household: 'home',
        playable: false,
        actions: pauseOnly,
        volume: 0.4,
      },
    })
  })

  it('does not guess between active groups that share the device name', async () => {
    const request = fakeSonos({
      [`${API}/households`]: { households: [{ id: 'home' }, { id: 'other' }] },
      [`${API}/households/home/groups`]: { groups: [group('A', 'Lounge')] },
      [`${API}/households/other/groups`]: { groups: [group('B', 'Lounge')] },
      [`${API}/groups/A/playbackMetadata`]: playing(otherTrack),
      [`${API}/groups/B/playbackMetadata`]: playing(otherTrack),
    })
    expect(
      await lookup(request, {
        trackUri: track,
        device: 'Lounge',
      }),
    ).toEqual({ group: null })
  })

  it('does not use the named group when it is not playing from Spotify', async () => {
    for (const objectId of ['x-sonos-http:fixture.mp3', undefined]) {
      const request = fakeSonos({
        [`${API}/households`]: { households: [{ id: 'home' }] },
        [`${API}/households/home/groups`]: { groups: [group('A', 'Lounge')] },
        [`${API}/groups/A/playbackMetadata`]: playing(objectId),
      })
      expect(
        await lookup(request, {
          trackUri: track,
          device: 'Lounge',
        }),
      ).toEqual({ group: null })
    }
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

  it('marks rooms playable when their household Spotify account is known or seen', async () => {
    const request = fakeSonos({
      [`${API}/households`]: {
        households: [{ id: 'home' }, { id: 'other' }, { id: 'third' }],
      },
      [`${API}/households/home/groups`]: {
        groups: [group('A', 'Lounge'), group('B', 'Study')],
      },
      [`${API}/households/other/groups`]: { groups: [group('C', 'Kitchen')] },
      [`${API}/households/third/groups`]: { groups: [group('D', 'Garage')] },
      ...controllable('A'),
      ...controllable('B'),
      ...controllable('C'),
      ...controllable('D'),
      [`${API}/groups/A/playbackMetadata`]: {
        currentItem: {
          track: {
            name: 'Fixture track',
            id: {
              serviceId: '12',
              objectId: encodeURIComponent(track),
              accountId: 'sn_1',
            },
          },
        },
      },
      [`${API}/groups/B/playbackMetadata`]: {},
      [`${API}/groups/C/playbackMetadata`]: {
        container: {
          id: {
            serviceId: '12',
            objectId: 'spotify:playlist:fixture',
            accountId: 'sn_2',
          },
        },
      },
      [`${API}/groups/D/playbackMetadata`]: {
        currentItem: {
          track: {
            id: {
              serviceId: '9',
              objectId: 'x-sonos-http:fixture.mp3',
              accountId: 'sn_3',
            },
          },
        },
      },
    })
    const { result, accounts } = await sonosRooms(
      request,
      'fixture-token',
      new Set(['other']),
    )
    expect(
      result.households.map((household) =>
        household.rooms.map((room) => [room.id, room.playable]),
      ),
    ).toEqual([
      [
        ['A', true],
        ['B', true],
      ],
      [['C', true]],
      [['D', false]],
    ])
    expect(accounts).toEqual([
      { household: 'home', serviceId: '12', accountId: 'sn_1' },
      { household: 'other', serviceId: '12', accountId: 'sn_2' },
    ])
  })

  it('reports the household of the playing group and the Spotify accounts seen', async () => {
    const request = fakeSonos({
      [`${API}/households`]: { households: [{ id: 'home' }] },
      [`${API}/households/home/groups`]: { groups: [group('A', 'Lounge')] },
      [`${API}/groups/A/playbackMetadata`]: {
        currentItem: {
          track: {
            id: { serviceId: '12', objectId: track, accountId: 'sn_1' },
          },
        },
      },
      ...controllable('A'),
    })
    expect(
      await sonosPlaying(
        request,
        'fixture-token',
        { trackUri: track, device: 'Lounge' },
        new Set(),
      ),
    ).toEqual({
      result: {
        group: {
          id: 'A',
          name: 'Lounge',
          household: 'home',
          playable: true,
          actions: pauseOnly,
          volume: 0.4,
        },
      },
      accounts: [{ household: 'home', serviceId: '12', accountId: 'sn_1' }],
    })
  })

  it('reads what a group plays, with its volume only when asked', async () => {
    const request = fakeSonos({
      [`${API}/groups/A%3A1/playback`]: {
        playbackState: 'PLAYBACK_STATE_PAUSED',
        positionMillis: 1234.6,
        availablePlaybackActions: { canPause: true },
      },
      [`${API}/groups/A%3A1/playbackMetadata`]: {
        container: {
          type: 'playlist',
          id: { serviceId: '12', objectId: 'spotify:album:FIXTUREALBUM' },
        },
        currentItem: {
          track: {
            name: 'Fixture track',
            artist: { name: 'Fixture artist' },
            album: { name: 'Fixture album' },
            imageUrl: 'https://images.example.test/a.jpg',
            durationMillis: 200000,
            id: { serviceId: '12', objectId: encodeURIComponent(track) },
          },
        },
        nextItem: { track: { name: 'Next fixture' } },
      },
      [`${API}/groups/A%3A1/groupVolume`]: { volume: 30, fixed: false },
    })
    const state = {
      state: 'paused',
      positionMs: 1235,
      track: {
        uri: track,
        name: 'Fixture track',
        artist: 'Fixture artist',
        album: 'Fixture album',
        artworkUrl: 'https://images.example.test/a.jpg',
        durationMs: 200000,
      },
      hasNext: true,
      containerUri: 'spotify:album:FIXTUREALBUM',
      actions: pauseOnly,
    }
    expect(
      await sonosGroupState(request, 'fixture-token', 'A:1', false),
    ).toEqual(state)
    expect(request).not.toHaveBeenCalledWith(
      `${API}/groups/A%3A1/groupVolume`,
      expect.anything(),
    )
    expect(
      await sonosGroupState(request, 'fixture-token', 'A:1', true),
    ).toEqual({ ...state, volume: 0.3 })
  })

  it('reports tracks from other services without a URI, and no track when nothing is loaded', async () => {
    const request = fakeSonos({
      [`${API}/groups/A/playback`]: {
        playbackState: 'PLAYBACK_STATE_PLAYING',
      },
      [`${API}/groups/A/playbackMetadata`]: {
        container: { id: { objectId: 'x-rincon-queue:fixture' } },
        currentItem: {
          track: {
            name: 'Radio fixture',
            id: { objectId: 'x-sonos-http:fixture.mp3' },
          },
        },
      },
      [`${API}/groups/B/playback`]: { playbackState: 'PLAYBACK_STATE_IDLE' },
      [`${API}/groups/B/playbackMetadata`]: { currentItem: { track: {} } },
      [`${API}/groups/B/groupVolume`]: { volume: 100, fixed: true },
    })
    expect(
      await sonosGroupState(request, 'fixture-token', 'A', false),
    ).toMatchObject({
      state: 'playing',
      positionMs: 0,
      track: { uri: null, name: 'Radio fixture', durationMs: null },
      hasNext: false,
      containerUri: null,
    })
    expect(await sonosGroupState(request, 'fixture-token', 'B', true)).toEqual({
      state: 'idle',
      positionMs: 0,
      track: null,
      hasNext: false,
      containerUri: null,
      actions: {
        pause: false,
        play: false,
        next: false,
        previous: false,
        seek: false,
      },
      volume: null,
    })
  })

  describe('loading Spotify content', () => {
    const account = { serviceId: '12', accountId: 'sn_1' }
    const album = 'spotify:album:ABCDEFGHIJKLMNOPQRSTUV'

    async function load(input: Parameters<typeof sonosContent>[4]) {
      const request: SonosRequest = vi.fn(async () => Response.json({}))
      await sonosContent(request, 'fixture-token', 'A:1', account, input)
      return vi.mocked(request).mock.calls.map(([url, init]) => {
        const body = z.object({ body: z.string() }).parse(init).body
        return [
          String(url).replace(`${API}/groups/A%3A1/`, ''),
          JSON.parse(body),
        ]
      })
    }

    function content(
      objectId: string,
      queueAction: string,
      play: boolean,
      type = 'TRACK',
    ) {
      return [
        'playback/content',
        {
          type,
          id: { serviceId: '12', objectId, accountId: 'sn_1' },
          ...(play ? { playbackAction: 'PLAY' } : {}),
          queueAction,
        },
      ]
    }

    it('replaces the queue and plays from the first request', async () => {
      expect(
        await load({
          household: 'home',
          mode: 'replace',
          uris: [album, track],
          play: true,
        }),
      ).toEqual([
        content(album, 'REPLACE', true, 'ALBUM'),
        content(track, 'APPEND', true),
      ])
    })

    it('replaces the queue without playing', async () => {
      expect(
        await load({
          household: 'home',
          mode: 'replace',
          uris: [track],
          play: false,
        }),
      ).toEqual([content(track, 'REPLACE', false)])
    })

    it('skips and seeks silently before playing', async () => {
      expect(
        await load({
          household: 'home',
          mode: 'replace',
          uris: [album, track],
          play: true,
          skip: 2,
          positionMs: 15000,
        }),
      ).toEqual([
        content(album, 'REPLACE', false, 'ALBUM'),
        content(track, 'APPEND', false),
        ['playback/skipToNextTrack', {}],
        ['playback/skipToNextTrack', {}],
        ['playback/seek', { positionMillis: 15000 }],
        ['playback/play', {}],
      ])
    })

    it('appends to the queue, playing only when asked', async () => {
      expect(
        await load({
          household: 'home',
          mode: 'append',
          uris: [track, otherTrack],
          play: false,
        }),
      ).toEqual([
        content(track, 'APPEND', false),
        content(otherTrack, 'APPEND', false),
      ])
      expect(
        await load({
          household: 'home',
          mode: 'append',
          uris: [track],
          play: true,
        }),
      ).toEqual([content(track, 'APPEND', true)])
    })

    it('inserts after the current track in reverse so the items keep their order', async () => {
      expect(
        await load({
          household: 'home',
          mode: 'next',
          uris: [track, otherTrack, album],
          play: true,
        }),
      ).toEqual([
        content(album, 'INSERT_NEXT', true, 'ALBUM'),
        content(otherTrack, 'INSERT_NEXT', true),
        content(track, 'INSERT_NEXT', true),
      ])
    })
  })
})
