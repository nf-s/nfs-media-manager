import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { createPlaybackEngine } from './playback-engine'
import type { PlayableItem, PlaybackSnapshot } from './playback'
import {
  PlaybackApiError,
  type PlaybackDevice,
  type PlayerApi,
  type RestrictedDevice,
} from './spotify-player-api'
import type { SpotifySdk, SpotifySdkPlayer } from './spotify-sdk'

const album: PlayableItem = {
  kind: 'album',
  uri: 'spotify:album:first',
  title: 'First album',
  artist: 'Fixture artist',
  albumId: 'album-1',
  albumTitle: 'First album',
  artworkUrl: null,
  trackCount: 2,
}
const track: PlayableItem = {
  kind: 'track',
  uri: 'spotify:track:single',
  title: 'Single track',
  artist: 'Fixture artist',
  albumId: 'album-2',
  albumTitle: 'Second album',
  artworkUrl: null,
  trackCount: 1,
}
const speaker: PlaybackDevice = {
  id: 'speaker',
  name: 'Fixture speaker',
  type: 'speaker',
  active: false,
  restricted: false,
  volume: 0.4,
}

type LocalState = {
  context: string
  track: string
  position: number
  paused?: boolean
  next?: number
}

function sdkState(values: LocalState) {
  return {
    context: { uri: values.context },
    paused: values.paused ?? false,
    position: values.position,
    duration: 200_000,
    track_window: {
      current_track: {
        uri: values.track,
        name: 'Fixture track',
        artists: [{ name: 'Fixture artist' }],
        album: { name: 'Fixture album', images: [] },
      },
      next_tracks: Array.from({ length: values.next ?? 1 }, () => ({})),
    },
  }
}

function remoteSnapshot(values: Partial<PlaybackSnapshot>): PlaybackSnapshot {
  return {
    trackUri: 'spotify:track:one',
    linkedFromUri: null,
    trackName: 'Fixture track',
    artists: 'Fixture artist',
    albumName: 'Fixture album',
    artworkUrl: null,
    durationMs: 200_000,
    positionMs: 0,
    paused: false,
    contextUri: album.uri,
    hasNext: null,
    trackNumber: 1,
    discNumber: 1,
    at: 0,
    ...values,
  }
}

let clock = 0

function harness() {
  const calls: string[] = []
  const page = { visible: true }
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const local: { state: unknown } = { state: null }
  const remote: {
    device: PlaybackDevice | null
    restricted: RestrictedDevice | null
    snapshot: PlaybackSnapshot | null
    devices: PlaybackDevice[]
    failures: Error[]
  } = {
    device: null,
    restricted: null,
    snapshot: null,
    devices: [],
    failures: [],
  }
  class Player implements SpotifySdkPlayer {
    async connect() {
      calls.push('sdk connect')
      return true
    }
    disconnect() {
      calls.push('sdk disconnect')
    }
    addListener(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return true
    }
    async getCurrentState() {
      return local.state
    }
    async setVolume(volume: number) {
      calls.push(`sdk volume ${volume}`)
    }
    async togglePlay() {
      calls.push('sdk toggle')
    }
    async seek(position: number) {
      calls.push(`sdk seek ${position}`)
    }
    async previousTrack() {
      calls.push('sdk previous')
    }
    async nextTrack() {
      calls.push('sdk next')
    }
    async activateElement() {
      calls.push('sdk activate')
    }
  }
  const sdk: SpotifySdk = { Player }
  async function command(call: string) {
    calls.push(call)
    const failure = remote.failures.shift()
    if (failure) throw failure
  }
  const api: PlayerApi = {
    async devices() {
      await command('devices')
      return remote.devices
    },
    async state() {
      await command('state')
      return {
        device: remote.device,
        restricted: remote.restricted,
        snapshot: remote.snapshot && { ...remote.snapshot, at: clock },
      }
    },
    play: (device, body) => command(`play ${device} ${JSON.stringify(body)}`),
    transfer: (device, play) => command(`transfer ${device} ${play}`),
    resume: (device) => command(`resume ${device}`),
    pause: (device) => command(`pause ${device}`),
    next: (device) => command(`next ${device}`),
    previous: (device) => command(`previous ${device}`),
    seek: (device, position) => command(`seek ${device} ${position}`),
    volume: (device, volume) => command(`volume ${device} ${volume}`),
  }
  const engine = createPlaybackEngine({
    api,
    token: async () => 'token',
    loadSdk: async () => sdk,
    playerName: 'Fixture player',
    initialVolume: 0.8,
    now: () => clock,
    visible: () => page.visible,
  })
  return {
    engine,
    calls,
    page,
    local,
    remote,
    emit(event: string, payload: unknown = {}) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    sent(prefix: string) {
      return calls.filter((call) => call.startsWith(prefix))
    },
  }
}

function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function advance(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) {
    clock += 100
    mock.timers.tick(100)
    await settle()
  }
}

/** Starts an item in the browser player and reports it as playing. */
async function playLocally(
  setup: ReturnType<typeof harness>,
  item: PlayableItem,
  state: LocalState,
) {
  setup.engine.prepare()
  await settle()
  setup.engine.play(item)
  await settle()
  setup.emit('ready', { device_id: 'browser' })
  await settle()
  setup.local.state = sdkState(state)
  await advance(700)
}

beforeEach(() => {
  clock = 0
  mock.timers.enable({ apis: ['setTimeout'] })
})
afterEach(() => mock.timers.reset())

test('plays an album in this browser once its device is ready', async () => {
  const setup = harness()
  setup.engine.prepare()
  await settle()
  setup.engine.play(album)
  assert.equal(setup.engine.getState().starting, true)
  assert.equal(setup.engine.getState().current, album)
  await settle()
  assert.deepEqual(setup.calls, ['sdk activate', 'sdk connect'])
  setup.emit('ready', { device_id: 'browser' })
  await settle()
  assert.deepEqual(setup.sent('play'), [
    'play browser {"context_uri":"spotify:album:first"}',
  ])
  // Until the album starts, the device may still report earlier playback.
  setup.local.state = sdkState({
    context: 'spotify:album:earlier',
    track: 'spotify:track:earlier',
    position: 90_000,
  })
  await advance(700)
  assert.equal(setup.engine.getState().snapshot, null)
  setup.local.state = sdkState({
    context: album.uri,
    track: 'spotify:track:one',
    position: 300,
  })
  await advance(1_000)
  const state = setup.engine.getState()
  assert.equal(state.starting, false)
  assert.equal(state.snapshot?.trackUri, 'spotify:track:one')
  assert.equal(state.failure, null)
  setup.engine.dispose()
  assert.equal(setup.calls.at(-1), 'sdk disconnect')
})

test('waits for Spotify to list a browser device that has just registered', async () => {
  const setup = harness()
  setup.remote.failures.push(new PlaybackApiError(404, null))
  setup.engine.play(album)
  await settle()
  setup.emit('ready', { device_id: 'browser' })
  await settle()
  assert.equal(setup.sent('play').length, 1)
  await advance(700)
  assert.equal(setup.sent('play').length, 2)
  assert.equal(setup.engine.getState().failure, null)
})

test('starts the next queued item when the album runs out', async () => {
  const setup = harness()
  await playLocally(setup, album, {
    context: album.uri,
    track: 'spotify:track:two',
    position: 196_000,
    next: 0,
  })
  setup.engine.enqueue(track)
  assert.equal(setup.engine.getState().queue.length, 1)
  assert.equal(
    setup.engine.getState().announcement,
    'Added to queue: Single track',
  )
  // Spotify stops a finished album at the start of its first track.
  setup.local.state = sdkState({
    context: album.uri,
    track: 'spotify:track:one',
    position: 0,
    paused: true,
  })
  await advance(4_000)
  assert.deepEqual(
    setup.sent('play').at(-1),
    'play browser {"uris":["spotify:track:single"]}',
  )
  const state = setup.engine.getState()
  assert.equal(state.current, track)
  assert.deepEqual(state.queue, [])
})

test('an album that ends with nothing queued leaves the player idle', async () => {
  const setup = harness()
  await playLocally(setup, album, {
    context: album.uri,
    track: 'spotify:track:two',
    position: 198_000,
    next: 0,
  })
  setup.local.state = sdkState({
    context: album.uri,
    track: 'spotify:track:one',
    position: 0,
    paused: true,
  })
  await advance(2_000)
  const state = setup.engine.getState()
  assert.equal(state.current, null)
  assert.equal(state.snapshot?.paused, true)
  assert.equal(setup.sent('play').length, 1)
})

test('next skips within an album and moves to the queue from its last track', async () => {
  const setup = harness()
  await playLocally(setup, album, {
    context: album.uri,
    track: 'spotify:track:one',
    position: 10_000,
  })
  setup.engine.enqueue(track)
  setup.engine.next()
  assert.deepEqual(setup.sent('sdk next'), ['sdk next'])
  setup.local.state = sdkState({
    context: album.uri,
    track: 'spotify:track:two',
    position: 0,
    next: 0,
  })
  await advance(1_000)
  assert.equal(setup.engine.getState().current, album)
  setup.engine.next()
  await settle()
  assert.deepEqual(setup.sent('sdk next'), ['sdk next'])
  assert.equal(setup.engine.getState().current, track)
})

test('queue entries can be reordered, removed, played and cleared', async () => {
  const setup = harness()
  const { engine } = setup
  engine.enqueue(album)
  engine.enqueue(track)
  engine.enqueue(album)
  const [first, second, third] = engine.getState().queue
  assert.ok(first && second && third)
  assert.equal(engine.getState().active, true)
  engine.moveInQueue(2, 0)
  assert.deepEqual(
    engine.getState().queue.map((entry) => entry.key),
    [third.key, first.key, second.key],
  )
  engine.moveInQueue(0, 5)
  engine.removeFromQueue(first.key)
  assert.deepEqual(
    engine.getState().queue.map((entry) => entry.key),
    [third.key, second.key],
  )
  engine.playFromQueue(second.key)
  assert.equal(engine.getState().current, track)
  assert.deepEqual(
    engine.getState().queue.map((entry) => entry.key),
    [third.key],
  )
  engine.clearQueue()
  assert.deepEqual(engine.getState().queue, [])
  engine.dispose()
})

test('play starts the queue when nothing is loaded', async () => {
  const setup = harness()
  setup.engine.enqueue(track)
  setup.engine.toggle()
  assert.equal(setup.engine.getState().current, track)
  assert.deepEqual(setup.engine.getState().queue, [])
  setup.engine.dispose()
})

test('controls another device and follows it by polling', async () => {
  const setup = harness()
  const { engine, remote } = setup
  remote.devices = [speaker, { ...speaker, id: 'browser', name: 'This one' }]
  await engine.refreshDevices()
  assert.equal(engine.getState().devices.length, 2)
  // Nothing is playing yet, so choosing a device moves nothing.
  await engine.selectDevice({ kind: 'remote', device: speaker })
  assert.deepEqual(setup.sent('transfer'), [])
  assert.equal(engine.getState().volume, 0.4)
  engine.play(album)
  await settle()
  assert.deepEqual(setup.sent('play'), [
    'play speaker {"context_uri":"spotify:album:first"}',
  ])
  remote.device = { ...speaker, active: true }
  remote.snapshot = remoteSnapshot({ positionMs: 1_000 })
  await advance(700)
  assert.equal(engine.getState().snapshot?.paused, false)
  engine.toggle()
  assert.equal(engine.getState().snapshot?.paused, true)
  assert.deepEqual(setup.sent('pause'), ['pause speaker'])
  engine.setVolume(0.2)
  engine.setVolume(0.6)
  await advance(300)
  assert.deepEqual(setup.sent('volume'), ['volume speaker 0.6'])
  engine.seek(50_000)
  assert.equal(engine.getState().snapshot?.positionMs, 50_000)
  assert.deepEqual(setup.sent('seek'), ['seek speaker 50000'])
  engine.dispose()
})

test('a remote album that resets to its first track starts the queue', async () => {
  const setup = harness()
  const { engine, remote } = setup
  await engine.selectDevice({ kind: 'remote', device: speaker })
  engine.play(album)
  await settle()
  engine.enqueue(track)
  remote.device = { ...speaker, active: true }
  remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:two',
    trackNumber: 2,
    positionMs: 196_000,
  })
  await advance(700)
  remote.snapshot = remoteSnapshot({ paused: true })
  await advance(5_000)
  assert.equal(engine.getState().current, track)
  assert.deepEqual(
    setup.sent('play').at(-1),
    'play speaker {"uris":["spotify:track:single"]}',
  )
  engine.dispose()
})

test('moving playback to this browser transfers it', async () => {
  const setup = harness()
  const { engine, remote } = setup
  await engine.selectDevice({ kind: 'remote', device: speaker })
  engine.play(album)
  await settle()
  remote.device = { ...speaker, active: true }
  remote.snapshot = remoteSnapshot({ positionMs: 1_000 })
  await advance(700)
  const moved = engine.selectDevice({ kind: 'local' })
  await settle()
  setup.emit('ready', { device_id: 'browser' })
  await moved
  assert.deepEqual(setup.sent('transfer'), ['transfer browser true'])
  assert.deepEqual(engine.getState().target, { kind: 'local' })
  assert.equal(engine.getState().volume, 0.8)
  engine.dispose()
})

test('follows playback that moved from this browser to another device', async () => {
  const setup = harness()
  await playLocally(setup, album, {
    context: album.uri,
    track: 'spotify:track:one',
    position: 5_000,
  })
  setup.local.state = null
  setup.remote.device = { ...speaker, active: true }
  setup.remote.snapshot = remoteSnapshot({ positionMs: 60_000 })
  await advance(3_000)
  const state = setup.engine.getState()
  assert.deepEqual(setup.sent('state'), ['state'])
  assert.equal(state.target.kind, 'remote')
  assert.equal(state.current, album)
  assert.equal(state.snapshot?.positionMs, 60_000)
  setup.engine.dispose()
})

test('clears the player when playback stops everywhere', async () => {
  const setup = harness()
  await playLocally(setup, album, {
    context: album.uri,
    track: 'spotify:track:one',
    position: 5_000,
  })
  setup.local.state = null
  await advance(3_000)
  const state = setup.engine.getState()
  assert.equal(state.snapshot, null)
  assert.equal(state.current, null)
  assert.equal(state.active, true)
  setup.engine.dispose()
})

test('expired access stops playback and asks for a new connection', async () => {
  const setup = harness()
  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  setup.remote.failures.push(new PlaybackApiError(401, null))
  setup.engine.play(album)
  await settle()
  const state = setup.engine.getState()
  assert.equal(state.failure?.status, 'expired')
  assert.equal(state.starting, false)
  await advance(6_000)
  assert.deepEqual(setup.sent('state'), [])
  setup.engine.dispose()
})

test('reports player errors and a start that never happens', async () => {
  const setup = harness()
  setup.engine.prepare()
  await settle()
  setup.engine.play(album)
  await settle()
  setup.emit('account_error', { message: 'x' })
  await settle()
  assert.equal(
    setup.engine.getState().failure?.message,
    'Spotify Premium is required to play in the browser.',
  )
  assert.equal(setup.engine.getState().starting, false)
  assert.deepEqual(setup.sent('play'), [])

  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  setup.engine.play(album)
  setup.remote.device = { ...speaker, active: true }
  setup.remote.snapshot = remoteSnapshot({
    contextUri: 'spotify:playlist:other',
    positionMs: 80_000,
  })
  await advance(13_000)
  const state = setup.engine.getState()
  assert.equal(state.current, null)
  assert.equal(
    state.failure?.message,
    'Playback did not start. Try again or choose a device.',
  )
  setup.engine.dispose()
})

test('one failed check keeps the session; repeated failures end it', async () => {
  const setup = harness()
  const { engine, remote } = setup
  await engine.selectDevice({ kind: 'remote', device: speaker })
  engine.play(album)
  await settle()
  remote.device = { ...speaker, active: true }
  remote.snapshot = remoteSnapshot({ positionMs: 1_000 })
  await advance(700)
  remote.failures.push(new PlaybackApiError(502, null))
  await advance(5_000)
  assert.equal(engine.getState().current, album)
  assert.equal(engine.getState().failure, null)
  remote.failures.push(
    new PlaybackApiError(502, null),
    new PlaybackApiError(502, null),
    new PlaybackApiError(502, null),
  )
  await advance(15_000)
  assert.equal(engine.getState().current, null)
  assert.equal(
    engine.getState().failure?.message,
    'Spotify could not complete that request.',
  )
  engine.dispose()
})

test('shows and controls playback the account started on another device', async () => {
  const setup = harness()
  setup.remote.device = speaker
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.watch()
  await advance(100)
  let state = setup.engine.getState()
  assert.equal(state.active, true)
  assert.equal(state.current, null)
  assert.deepEqual(state.target, { kind: 'remote', device: speaker })
  assert.equal(state.volume, 0.4)
  assert.equal(state.snapshot?.trackUri, 'spotify:track:one')
  assert.equal(setup.sent('state').length, 1)

  await advance(3_000)
  assert.equal(setup.sent('state').length, 2)
  setup.engine.toggle()
  await settle()
  assert.deepEqual(setup.sent('pause'), ['pause speaker'])
  assert.equal(setup.engine.getState().snapshot?.paused, true)
  setup.remote.snapshot = remoteSnapshot({ paused: true })
  await advance(700)
  const checks = setup.sent('state').length

  // Paused playback is checked less often, and a resume elsewhere is noticed.
  await advance(4_000)
  assert.equal(setup.sent('state').length, checks)
  setup.remote.snapshot = remoteSnapshot({ positionMs: 60_000 })
  await advance(1_000)
  state = setup.engine.getState()
  assert.equal(state.snapshot?.paused, false)
  assert.equal(state.snapshot?.positionMs, 60_000)
})

test('leaves the player hidden while nothing plays elsewhere', async () => {
  const setup = harness()
  setup.engine.watch()
  await advance(100)
  assert.equal(setup.engine.getState().active, false)
  assert.equal(setup.sent('state').length, 1)

  // Paused playback on another device is not picked up.
  setup.remote.device = speaker
  setup.remote.snapshot = remoteSnapshot({ paused: true })
  await advance(5_000)
  assert.equal(setup.sent('state').length, 2)
  assert.equal(setup.engine.getState().active, false)
  assert.deepEqual(setup.engine.getState().target, { kind: 'local' })

  // A hidden page stops checking until it is shown again.
  setup.page.visible = false
  await advance(90_000)
  assert.equal(setup.sent('state').length, 2)
  setup.remote.snapshot = remoteSnapshot({})
  setup.page.visible = true
  setup.engine.refresh()
  await advance(100)
  assert.equal(setup.sent('state').length, 3)
  assert.equal(setup.engine.getState().active, true)
})

test('playback found elsewhere hides again once it stops', async () => {
  const setup = harness()
  setup.remote.device = speaker
  setup.remote.snapshot = remoteSnapshot({})
  setup.engine.watch()
  await advance(100)
  assert.equal(setup.engine.getState().active, true)

  setup.remote.device = null
  setup.remote.snapshot = null
  await advance(15_000)
  const state = setup.engine.getState()
  assert.equal(state.active, false)
  assert.equal(state.snapshot, null)
  assert.deepEqual(state.target, { kind: 'local' })
  assert.equal(state.volume, 0.8)
  assert.equal(state.failure, null)
})

test('the queue and play act on the device found playing elsewhere', async () => {
  const setup = harness()
  setup.remote.device = speaker
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.watch()
  await advance(100)

  // Queued items wait: playback this app did not start has no known end.
  setup.engine.enqueue(track)
  setup.remote.snapshot = remoteSnapshot({
    contextUri: 'spotify:playlist:x',
    paused: true,
  })
  await advance(5_000)
  assert.equal(setup.sent('play').length, 0)
  assert.equal(setup.engine.getState().queue.length, 1)

  setup.engine.next()
  await settle()
  assert.deepEqual(setup.sent('play'), [
    'play speaker {"uris":["spotify:track:single"]}',
  ])
  assert.equal(setup.engine.getState().current, track)

  // Once something was played here, the player stays after playback stops.
  setup.remote.device = null
  setup.remote.snapshot = null
  await advance(20_000)
  assert.equal(setup.engine.getState().active, true)
  assert.deepEqual(setup.engine.getState().target, { kind: 'local' })
})

test('a failed background check stays silent unless access expired', async () => {
  const setup = harness()
  setup.remote.failures.push(
    new PlaybackApiError(429, null),
    new PlaybackApiError(401, null),
  )
  setup.engine.watch()
  await advance(100)
  assert.equal(setup.engine.getState().failure, null)
  await advance(5_000)
  assert.equal(setup.engine.getState().failure?.status, 'expired')
  assert.equal(setup.engine.getState().active, false)
  const checks = setup.sent('state').length
  await advance(60_000)
  assert.equal(setup.sent('state').length, checks)
})

test('shows playback on a device Spotify does not let apps control', async () => {
  const setup = harness()
  const restricted = { name: 'Fixture hi-fi', type: 'speaker' }
  setup.remote.restricted = restricted
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.watch()
  await advance(100)
  let state = setup.engine.getState()
  assert.equal(state.active, true)
  assert.deepEqual(state.target, { kind: 'restricted', ...restricted })
  assert.equal(state.volume, null)
  assert.equal(state.snapshot?.trackUri, 'spotify:track:one')

  // No command is sent to a device that would refuse it.
  setup.engine.toggle()
  setup.engine.next()
  setup.engine.previous()
  setup.engine.seek(30_000)
  setup.engine.setVolume(0.2)
  await advance(5_000)
  assert.deepEqual(
    setup.calls.filter((call) => call !== 'state'),
    [],
  )
  assert.equal(setup.engine.getState().snapshot?.paused, false)

  // Playback that moves to a controllable device is followed there.
  setup.remote.restricted = null
  setup.remote.device = speaker
  await advance(5_000)
  state = setup.engine.getState()
  assert.deepEqual(state.target, { kind: 'remote', device: speaker })
  assert.equal(state.volume, 0.4)
  setup.engine.toggle()
  await settle()
  assert.deepEqual(setup.sent('pause'), ['pause speaker'])
})

test('playing here takes over from a device apps cannot control', async () => {
  const setup = harness()
  setup.remote.restricted = { name: 'Fixture hi-fi', type: 'speaker' }
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.prepare()
  setup.engine.watch()
  await advance(100)
  assert.equal(setup.engine.getState().target.kind, 'restricted')

  setup.engine.play(album)
  assert.deepEqual(setup.engine.getState().target, { kind: 'local' })
  assert.equal(setup.engine.getState().volume, 0.8)
  await settle()
  assert.ok(setup.calls.includes('sdk activate'))
  setup.emit('ready', { device_id: 'browser' })
  await settle()
  assert.deepEqual(setup.sent('play'), [
    'play browser {"context_uri":"spotify:album:first"}',
  ])
})

test('a chosen device gives way to the device playback was moved to', async () => {
  const setup = harness()
  const { engine, remote } = setup
  const restricted = { name: 'Fixture hi-fi', type: 'speaker' }
  await engine.selectDevice({ kind: 'remote', device: speaker })
  engine.play(album)
  await settle()
  engine.enqueue(track)
  remote.device = { ...speaker, active: true }
  remote.snapshot = remoteSnapshot({ positionMs: 1_000 })
  await advance(700)
  assert.equal(engine.getState().current, album)

  // Another app moves the album to a device that takes no commands.
  remote.device = null
  remote.restricted = restricted
  await advance(3_000)
  assert.deepEqual(engine.getState().target, {
    kind: 'restricted',
    ...restricted,
  })
  assert.equal(engine.getState().volume, null)
  assert.equal(engine.getState().current, album)
  engine.toggle()
  engine.seek(30_000)
  await settle()
  assert.deepEqual(setup.sent('pause'), [])
  assert.deepEqual(setup.sent('seek'), [])

  // The queue does not pull playback off that device when the album ends.
  remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:two',
    trackNumber: 2,
    positionMs: 196_000,
  })
  await advance(3_000)
  remote.snapshot = remoteSnapshot({
    contextUri: 'spotify:playlist:x',
    trackUri: 'spotify:track:other',
  })
  await advance(6_000)
  assert.equal(engine.getState().current, null)
  assert.equal(engine.getState().queue.length, 1)
  assert.equal(setup.sent('play').length, 1)

  // Once it goes quiet, the chosen device is the target again.
  remote.restricted = null
  remote.snapshot = null
  await advance(16_000)
  assert.deepEqual(engine.getState().target, {
    kind: 'remote',
    device: speaker,
  })
  engine.next()
  await settle()
  assert.deepEqual(
    setup.sent('play').at(-1),
    'play speaker {"uris":["spotify:track:single"]}',
  )
  engine.dispose()
})

test('playback moved to this browser is controlled here', async () => {
  const setup = harness()
  setup.remote.device = speaker
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.prepare()
  setup.engine.watch()
  await advance(100)
  setup.emit('ready', { device_id: 'browser' })
  assert.equal(setup.engine.getState().target.kind, 'remote')

  setup.remote.device = { ...speaker, id: 'browser', name: 'Fixture player' }
  setup.local.state = sdkState({
    context: 'spotify:playlist:x',
    track: 'spotify:track:one',
    position: 9_000,
  })
  await advance(4_000)
  const state = setup.engine.getState()
  assert.deepEqual(state.target, { kind: 'local' })
  assert.equal(state.volume, 0.8)
  assert.equal(state.snapshot?.positionMs, 9_000)
  setup.engine.toggle()
  await settle()
  assert.ok(setup.calls.includes('sdk toggle'))
  assert.deepEqual(setup.sent('pause'), [])
  setup.engine.dispose()
})

test('a transfer made here outlasts a report that still names the old device', async () => {
  const setup = harness()
  const other: PlaybackDevice = { ...speaker, id: 'other', name: 'Other' }
  setup.remote.device = speaker
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.watch()
  await advance(100)

  await setup.engine.selectDevice({ kind: 'remote', device: other })
  assert.deepEqual(setup.sent('transfer'), ['transfer other true'])
  await advance(3_800)
  assert.deepEqual(setup.engine.getState().target, {
    kind: 'remote',
    device: other,
  })

  // A report that keeps naming the old device means the transfer did not hold.
  await advance(6_000)
  assert.deepEqual(setup.engine.getState().target, {
    kind: 'remote',
    device: speaker,
  })
  setup.engine.dispose()
})
