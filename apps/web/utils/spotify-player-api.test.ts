import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createPlayerApi,
  PlaybackApiError,
  remotePlayback,
} from './spotify-player-api'
import { sdkDeviceId, sdkPlayback } from './spotify-sdk'

type Call = { url: URL; method: string; token: string; body: string | null }

function client(responses: Response[]) {
  const calls: Call[] = []
  const tokens: boolean[] = []
  const api = createPlayerApi(
    async (refresh = false) => {
      tokens.push(refresh)
      return refresh ? 'fresh' : 'cached'
    },
    async (input, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: new URL(String(input)),
        method: init?.method ?? 'GET',
        token: headers.get('authorization') ?? '',
        body: typeof init?.body === 'string' ? init.body : null,
      })
      const response = responses.shift()
      if (!response) throw new Error('Unexpected request')
      return response
    },
  )
  return { api, calls, tokens }
}

const device = {
  id: 'speaker',
  is_active: true,
  is_restricted: false,
  name: 'Fixture speaker',
  type: 'Speaker',
  volume_percent: 40,
  supports_volume: true,
}

test('starts playback on the named device with the request body', async () => {
  const { api, calls } = client([new Response(null, { status: 204 })])
  await api.play('browser', { context_uri: 'spotify:album:fixture' })
  const [call] = calls
  assert.ok(call)
  assert.equal(call.method, 'PUT')
  assert.equal(
    call.url.origin + call.url.pathname,
    'https://api.spotify.com/v1/me/player/play',
  )
  assert.equal(call.url.searchParams.get('device_id'), 'browser')
  assert.equal(call.token, 'Bearer cached')
  assert.equal(call.body, '{"context_uri":"spotify:album:fixture"}')
})

test('sends transport commands with bounded values', async () => {
  const ok = () => new Response(null, { status: 204 })
  const { api, calls } = client([ok(), ok(), ok(), ok(), ok(), ok(), ok()])
  await api.transfer('speaker', true)
  await api.pause('speaker')
  await api.resume('speaker')
  await api.next('speaker')
  await api.previous('speaker')
  await api.seek('speaker', -20.4)
  await api.volume('speaker', 1.7)
  assert.deepEqual(
    calls.map(
      (call) => `${call.method} ${call.url.pathname}${call.url.search}`,
    ),
    [
      'PUT /v1/me/player',
      'PUT /v1/me/player/pause?device_id=speaker',
      'PUT /v1/me/player/play?device_id=speaker',
      'POST /v1/me/player/next?device_id=speaker',
      'POST /v1/me/player/previous?device_id=speaker',
      'PUT /v1/me/player/seek?device_id=speaker&position_ms=0',
      'PUT /v1/me/player/volume?device_id=speaker&volume_percent=100',
    ],
  )
  assert.equal(calls[0]?.body, '{"device_ids":["speaker"],"play":true}')
  assert.equal(calls[2]?.body, null)
})

test('asks for a fresh token once after an unauthorized response', async () => {
  const { api, calls, tokens } = client([
    new Response(null, { status: 401 }),
    Response.json({ devices: [device, { ...device, id: null }] }),
  ])
  assert.deepEqual(await api.devices(), [
    {
      id: 'speaker',
      name: 'Fixture speaker',
      type: 'speaker',
      active: true,
      restricted: false,
      volume: 0.4,
    },
  ])
  assert.deepEqual(tokens, [false, true])
  assert.equal(calls[1]?.token, 'Bearer fresh')
})

test('reports the status and reason of a failed request without retrying', async () => {
  const { api, calls } = client([
    Response.json(
      { error: { status: 403, message: 'x', reason: 'PREMIUM_REQUIRED' } },
      { status: 403 },
    ),
    new Response('not json', { status: 404 }),
    new Response(null, { status: 401 }),
    new Response(null, { status: 401 }),
  ])
  await assert.rejects(api.pause('speaker'), (error) => {
    assert.ok(error instanceof PlaybackApiError)
    assert.equal(error.status, 403)
    assert.equal(error.reason, 'PREMIUM_REQUIRED')
    return true
  })
  await assert.rejects(api.next('speaker'), (error) => {
    assert.ok(error instanceof PlaybackApiError)
    assert.equal(error.status, 404)
    assert.equal(error.reason, null)
    return true
  })
  await assert.rejects(api.devices(), (error) => {
    assert.ok(error instanceof PlaybackApiError)
    assert.equal(error.status, 401)
    return true
  })
  assert.equal(calls.length, 4)
})

test('reads remote playback, including nothing playing and non-track items', async () => {
  const track = {
    uri: 'spotify:track:fixture',
    name: 'Fixture track',
    duration_ms: 180000,
    track_number: 2,
    disc_number: 1,
    artists: [{ name: 'First' }, { name: 'Second' }],
    album: {
      name: 'Fixture album',
      images: [{ url: 'https://images.example/cover.jpg' }],
    },
  }
  const state = {
    device,
    context: { uri: 'spotify:album:fixture' },
    progress_ms: 12000,
    is_playing: true,
    item: track,
  }
  const { api } = client([
    new Response(null, { status: 204 }),
    Response.json(state),
  ])
  assert.deepEqual(await api.state(), {
    device: null,
    restricted: null,
    snapshot: null,
  })
  const playing = await api.state()
  assert.equal(playing.device?.id, 'speaker')
  assert.equal(playing.restricted, null)
  assert.equal(playing.snapshot?.artists, 'First, Second')
  assert.equal(playing.snapshot?.paused, false)
  assert.equal(playing.snapshot?.hasNext, null)
  assert.equal(playing.snapshot?.trackNumber, 2)

  const read = remotePlayback(
    {
      ...state,
      context: null,
      progress_ms: null,
      is_playing: false,
      item: {
        ...track,
        album: { name: 'x', images: [{ url: 'http://images.example/a.jpg' }] },
      },
    },
    5,
  )
  assert.equal(read.snapshot?.contextUri, null)
  assert.equal(read.snapshot?.positionMs, 0)
  assert.equal(read.snapshot?.paused, true)
  assert.equal(read.snapshot?.artworkUrl, null)
  assert.equal(read.snapshot?.at, 5)
  // Spotify gives a device apps cannot control no ID; its playback is still read.
  for (const unreachable of [
    { ...device, id: null, is_restricted: true },
    { ...device, is_restricted: true },
  ]) {
    const observed = remotePlayback({ ...state, device: unreachable }, 0)
    assert.equal(observed.device, null)
    assert.deepEqual(observed.restricted, {
      name: device.name,
      type: device.type.toLowerCase(),
    })
    assert.equal(observed.snapshot?.paused, false)
  }
  assert.equal(remotePlayback({ ...state, item: null }, 0).snapshot, null)
  assert.equal(
    remotePlayback({ ...state, item: { type: 'episode' } }, 0).snapshot,
    null,
  )
  assert.throws(() => remotePlayback({ item: track }, 0))
})

test('reads the browser player state and ignores malformed payloads', () => {
  const state = {
    context: { uri: 'spotify:album:fixture', metadata: {} },
    paused: false,
    position: 4200,
    duration: 180000,
    track_window: {
      current_track: {
        uri: 'spotify:track:substitute',
        name: 'Fixture track',
        artists: [{ name: 'First' }],
        album: {
          name: 'Fixture album',
          images: [{ url: 'https://images.example/cover.jpg' }],
        },
        linked_from: { uri: 'spotify:track:requested' },
      },
      previous_tracks: [],
      next_tracks: [{}],
    },
  }
  assert.deepEqual(sdkPlayback(state, 9), {
    trackUri: 'spotify:track:substitute',
    linkedFromUri: 'spotify:track:requested',
    trackName: 'Fixture track',
    artists: 'First',
    albumName: 'Fixture album',
    artworkUrl: 'https://images.example/cover.jpg',
    durationMs: 180000,
    positionMs: 4200,
    paused: false,
    contextUri: 'spotify:album:fixture',
    hasNext: true,
    trackNumber: null,
    discNumber: null,
    at: 9,
  })
  const last = sdkPlayback(
    {
      ...state,
      context: { uri: '' },
      track_window: { ...state.track_window, next_tracks: [] },
    },
    0,
  )
  assert.equal(last?.hasNext, false)
  assert.equal(last?.contextUri, null)
  assert.equal(sdkPlayback(null, 0), null)
  assert.equal(sdkPlayback({ paused: true }, 0), null)
  assert.equal(
    sdkPlayback({ ...state, track_window: { current_track: null } }, 0),
    null,
  )
  assert.equal(sdkDeviceId({ device_id: 'browser' }), 'browser')
  assert.equal(sdkDeviceId({ device_id: '' }), null)
  assert.equal(sdkDeviceId('browser'), null)
})
