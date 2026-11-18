import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSonosControlApi } from './sonos-player-api'

test('sends the playback client on every Sonos control operation', async (t) => {
  const clientId = 'c6c41999-a7bb-42a1-b817-bba46515d058'
  const groupId = 'fixture:room'
  const trackUri = 'spotify:track:ABCDEFGHIJKL1234567890'
  const requests: Array<{
    method: string
    url: URL
    headers: Headers
  }> = []
  const responses = [
    { households: [] },
    { group: null },
    {
      state: null,
      positionMs: 0,
      track: null,
      hasNext: false,
      containerUri: null,
      actions: {
        pause: true,
        play: true,
        next: true,
        previous: true,
        seek: true,
      },
      volume: 0.5,
    },
    { done: true },
    { done: true },
  ]
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const data = responses.shift()
      assert.ok(data, 'unexpected Sonos request')
      requests.push({
        method: init?.method ?? 'GET',
        url: new URL(String(input)),
        headers: new Headers(init?.headers),
      })
      return Response.json({ statusCode: 200, message: 'OK', data })
    },
  )

  const api = createSonosControlApi('https://app.example', clientId)
  await api.rooms()
  await api.find(trackUri, 'Fixture room')
  await api.state(groupId, true, 'room-playing')
  await api.load(groupId, {
    household: 'fixture-household',
    mode: 'replace',
    uris: [trackUri],
    play: true,
  })
  await api.command(groupId, { action: 'pause' })

  assert.deepEqual(
    requests.map(({ method, url, headers }) => ({
      route: `${method} ${url.pathname}`,
      client: headers.get('X-Playback-Client'),
      stateReason: headers.get('X-Sonos-Reason'),
    })),
    [
      { route: 'GET /api/v1/sonos/rooms', client: clientId, stateReason: null },
      {
        route: 'GET /api/v1/sonos/playback',
        client: clientId,
        stateReason: null,
      },
      {
        route: 'GET /api/v1/sonos/groups/fixture%3Aroom/state',
        client: clientId,
        stateReason: 'room-playing',
      },
      {
        route: 'POST /api/v1/sonos/groups/fixture%3Aroom/content',
        client: clientId,
        stateReason: null,
      },
      {
        route: 'POST /api/v1/sonos/groups/fixture%3Aroom/command',
        client: clientId,
        stateReason: null,
      },
    ],
  )
  assert.equal(requests[1]?.url.searchParams.get('trackUri'), trackUri)
  assert.equal(requests[1]?.url.searchParams.get('device'), 'Fixture room')
  assert.equal(requests[2]?.url.searchParams.get('volume'), 'true')
})
