import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import {
  createPlaybackEngine,
  type PlaybackEngineOptions,
} from './playback-engine'
import type { PlayableItem, PlaybackSnapshot, PlaybackSource } from './playback'
import {
  PlaybackApiError,
  type PlaybackDevice,
  type PlayerApi,
  type RestrictedDevice,
} from './spotify-player-api'
import type { SpotifySdk, SpotifySdkPlayer } from './spotify-sdk'
import type { SonosControlApi } from './sonos-player-api'
import type { SonosGroupControl, SonosGroupState } from '@repo/schemas/sonos'

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
    albumUri: null,
    artistLinks: [],
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

function harness(
  random?: () => number,
  sonos?: SonosControlApi,
  shuffle: Pick<
    PlaybackEngineOptions,
    'initialShuffle' | 'onShuffle' | 'initialRoom' | 'onRoom'
  > = {},
) {
  const calls: string[] = []
  /** Tracks whose details were read from Spotify. */
  const lookups: string[] = []
  const failingLookups = new Set<string>()
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
    async albumTrackIndex(albumUri, trackUri) {
      await command(`album index ${albumUri} ${trackUri}`)
      return 3
    },
    async track(trackUri) {
      lookups.push(trackUri)
      if (failingLookups.has(trackUri)) throw new PlaybackApiError(404, null)
      return {
        trackUri,
        linkedFromUri: null,
        trackName: `Spotify name of ${trackUri}`,
        artists: 'Spotify artist',
        albumName: 'Spotify album',
        albumUri: 'spotify:album:from-spotify',
        artistLinks: [{ name: 'Spotify artist', uri: null }],
        artworkUrl: 'https://images.example/cover.jpg',
        durationMs: 180_000,
        trackNumber: 2,
        discNumber: 1,
      }
    },
  }
  const engine = createPlaybackEngine({
    api,
    token: async () => 'token',
    loadSdk: async () => sdk,
    playerName: 'Fixture player',
    initialVolume: 0.8,
    now: () => clock,
    visible: () => page.visible,
    random,
    sonos,
    ...shuffle,
  })
  return {
    engine,
    calls,
    lookups,
    failLookup(uri: string) {
      failingLookups.add(uri)
    },
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

test('playing something new is refused on a device apps cannot start, which keeps its playback', async () => {
  const setup = harness()
  setup.remote.restricted = { name: 'Fixture hi-fi', type: 'speaker' }
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.prepare()
  setup.engine.watch()
  await advance(100)
  assert.equal(setup.engine.getState().target.kind, 'restricted')

  setup.engine.enqueue(track)
  setup.engine.play(album)
  setup.engine.next()
  setup.engine.playFromQueue(setup.engine.getState().queue[0]?.key ?? '')
  await settle()
  const state = setup.engine.getState()
  assert.equal(state.target.kind, 'restricted')
  assert.match(state.failure?.message ?? '', /start playback on Fixture hi-fi/)
  assert.equal(state.queue.length, 1)
  assert.equal(state.snapshot?.trackUri, 'spotify:track:one')
  assert.deepEqual(setup.sent('play'), [])
  setup.engine.dispose()
})

test('choosing a device moves the playback off a device apps cannot start', async () => {
  const setup = harness()
  setup.remote.restricted = { name: 'Fixture hi-fi', type: 'speaker' }
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.watch()
  await advance(100)
  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  assert.deepEqual(setup.sent('transfer'), ['transfer speaker true'])
  assert.equal(setup.engine.getState().target.kind, 'remote')
  setup.engine.dispose()
})

test('a device chosen while Spotify refuses the move takes the next start instead', async () => {
  const setup = harness()
  setup.remote.restricted = { name: 'Fixture hi-fi', type: 'speaker' }
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.watch()
  await advance(100)
  setup.remote.failures.push(new PlaybackApiError(403, null))
  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  assert.equal(setup.engine.getState().failure, null)
  assert.equal(setup.engine.getState().target.kind, 'remote')
  assert.equal(setup.engine.getState().snapshot, null)
  // The speaker left behind is not followed again while it keeps playing.
  await advance(6_000)
  assert.equal(setup.engine.getState().target.kind, 'remote')
  setup.engine.play(album)
  await settle()
  assert.deepEqual(setup.sent('play'), [
    'play speaker {"context_uri":"spotify:album:first"}',
  ])
  setup.engine.dispose()
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

function sourceTrack(index: number): PlayableItem {
  return {
    ...track,
    uri: `spotify:track:source-${index}`,
    title: `Track ${index}`,
  }
}

function fixtureSource(length: number, startIndex = 0): PlaybackSource {
  return {
    label: 'Tracks',
    href: '/tracks?sortBy=title&direction=asc',
    length,
    startIndex,
    kind: 'list',
    load: async (index) => [sourceTrack(index)],
  }
}

async function playSource(
  setup: ReturnType<typeof harness>,
  source: PlaybackSource,
  item = sourceTrack(source.startIndex),
) {
  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  setup.engine.play(item, source)
  await settle()
  setup.remote.device = speaker
}

test('captures a source and loads only the tracks kept ahead until playback advances', async () => {
  const setup = harness()
  const loaded: number[] = []
  const definition = fixtureSource(100)
  definition.load = async (index) => {
    loaded.push(index)
    return [sourceTrack(index)]
  }
  await playSource(setup, definition)
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  assert.deepEqual(setup.engine.getState().source, {
    label: 'Tracks',
    href: '/tracks?sortBy=title&direction=asc',
  })
  assert.equal(setup.engine.getState().upcoming.length, 30)
  assert.equal(Math.max(...loaded), 30)
  // The captured view keeps working after the caller navigates or changes its settings.
  definition.label = 'Another view'
  definition.load = async () => []
  for (let index = 1; index <= 15; index += 1) {
    setup.engine.next()
    await settle()
    assert.equal(setup.engine.getState().current?.uri, sourceTrack(index).uri)
  }
  assert.equal(setup.engine.getState().source?.label, 'Tracks')
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(16).uri)
  assert.equal(Math.max(...loaded), 45)
  setup.engine.dispose()
})

test('a source advances automatically when its current song finishes', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(2))
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(0).uri,
    contextUri: null,
    positionMs: 198_000,
  })
  await advance(700)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(0).uri,
    contextUri: null,
    paused: true,
    positionMs: 0,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  setup.engine.dispose()
})

test('manual queue order takes priority and source resumes after the last queued item', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(4))
  const queued = { ...track, uri: 'spotify:track:second-queued' }
  setup.engine.enqueue(track)
  setup.engine.enqueue(queued)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current, track)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(1).uri)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current, queued)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  assert.equal(setup.engine.getState().queue.length, 0)
  setup.engine.dispose()
})

test('albums expand to songs so a queued song plays before the rest of the source album', async () => {
  const setup = harness()
  const source: PlaybackSource = {
    ...fixtureSource(2),
    load: async (index) => [
      sourceTrack(index * 3),
      sourceTrack(index * 3 + 1),
      sourceTrack(index * 3 + 2),
    ],
  }
  await playSource(setup, source, { ...album, startUri: sourceTrack(1).uri })
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  setup.engine.enqueue(track)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current, track)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(2).uri)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(3).uri)
  setup.engine.dispose()
})

test('shuffle includes earlier unplayed rows without changing current playback or manual queue', async () => {
  const setup = harness(() => 0)
  await playSource(setup, fixtureSource(6, 3))
  setup.engine.enqueue(track)
  setup.engine.enqueue(album)
  const queued = setup.engine.getState().queue
  const plays = setup.sent('play').length
  setup.engine.toggleShuffle()
  await settle()
  assert.equal(setup.engine.getState().shuffle, true)
  assert.equal(setup.sent('play').length, plays)
  assert.deepEqual(setup.engine.getState().queue, queued)
  assert.deepEqual(
    setup.engine.getState().upcoming.map((item) => item.uri),
    [0, 1, 2, 4, 5].map((index) => sourceTrack(index).uri),
  )
  setup.engine.clearQueue()
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  setup.engine.toggleShuffle()
  await settle()
  assert.deepEqual(
    setup.engine.getState().upcoming.map((item) => item.uri),
    [1, 2, 4, 5].map((index) => sourceTrack(index).uri),
  )
  setup.engine.dispose()
})

test('shuffled songs span source albums and do not repeat after toggling shuffle off', async () => {
  const setup = harness(() => 0.99)
  const source: PlaybackSource = {
    ...fixtureSource(3),
    load: async (index) => [sourceTrack(index * 2), sourceTrack(index * 2 + 1)],
  }
  await playSource(setup, source, album)
  setup.engine.toggleShuffle()
  await settle()
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(5).uri)
  setup.engine.next()
  await settle()
  setup.engine.toggleShuffle()
  await settle()
  assert.deepEqual(
    setup.engine.getState().upcoming.map((item) => item.uri),
    [1, 2, 3, 4].map((index) => sourceTrack(index).uri),
  )
  setup.engine.dispose()
})

/** A random sequence that differs between tests only by its start. */
function sequence(start = 0.137) {
  let value = start
  return () => {
    value = (value + 0.618034) % 1
    return value
  }
}

/** A list whose entries can be read together; `reads` records each request. */
function scatteredSource(
  length: number,
  read: (index: number) => PlayableItem[] = (index) => [sourceTrack(index)],
) {
  const reads: number[][] = []
  const paged: number[] = []
  const held: Array<() => void> = []
  const hold = { rounds: false }
  const source: PlaybackSource = {
    ...fixtureSource(length),
    load: async (index) => {
      paged.push(index)
      return read(index)
    },
    loadScattered: async (indexes) => {
      reads.push(indexes)
      if (hold.rounds && indexes.length > 1)
        await new Promise<void>((resolve) => held.push(resolve))
      return indexes.map(read)
    },
  }
  return { source, reads, paged, held, hold }
}

test('a shuffled list reads the tracks kept ahead in one request', async () => {
  const setup = harness(sequence(), undefined, { initialShuffle: true })
  const list = scatteredSource(500)
  await playSource(setup, list.source)
  assert.equal(setup.engine.getState().shuffle, true)
  assert.deepEqual(
    list.reads.map((indexes) => indexes.length),
    [1, 30],
  )
  assert.deepEqual(list.paged, [])
  const round = list.reads[1] ?? []
  assert.equal(new Set(round).size, 30)
  const upcoming = setup.engine.getState().upcoming.map((item) => item.uri)
  assert.deepEqual(
    upcoming,
    round.map((index) => sourceTrack(index).uri),
  )
  assert.equal(setup.engine.getState().sourceLoading, false)

  // The next track is already resolved; one more is read to replace it.
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, upcoming[0])
  assert.deepEqual(
    list.reads.map((indexes) => indexes.length),
    [1, 30, 1],
  )
  assert.equal(setup.engine.getState().upcoming.length, 30)
  assert.equal(
    new Set(setup.engine.getState().upcoming.map((item) => item.uri)).size,
    30,
  )
  setup.engine.dispose()
})

test('a list played in order is read by page, not by scattered positions', async () => {
  const setup = harness()
  const list = scatteredSource(500)
  await playSource(setup, list.source)
  assert.deepEqual(list.reads, [])
  assert.equal(list.paged.length, 31)
  setup.engine.dispose()
})

test('a short shuffled list ends without reading a track twice', async () => {
  const setup = harness(sequence(), undefined, { initialShuffle: true })
  const list = scatteredSource(8)
  await playSource(setup, list.source)
  assert.deepEqual(
    setup.engine
      .getState()
      .upcoming.map((item) => item.uri)
      .sort(),
    [1, 2, 3, 4, 5, 6, 7].map((index) => sourceTrack(index).uri),
  )
  assert.equal(new Set(list.reads.flat()).size, list.reads.flat().length)
  setup.engine.dispose()
})

test('tracks already read are shown while more of a shuffled list is read', async () => {
  const setup = harness(sequence(), undefined, { initialShuffle: true })
  // Every third entry has no playable track, so one round is not enough.
  const list = scatteredSource(500, (index) =>
    index % 3 === 1 ? [] : [sourceTrack(index)],
  )
  list.hold.rounds = true
  await playSource(setup, list.source)
  assert.equal(setup.engine.getState().upcoming.length, 0)
  assert.equal(setup.engine.getState().sourceLoading, true)

  list.held.shift()?.()
  await settle()
  // Nothing is shown until the second round turns out to need waiting for.
  assert.equal(setup.engine.getState().upcoming.length, 0)
  await advance(100)
  const first = (list.reads[1] ?? []).filter((index) => index % 3 !== 1)
  assert.ok(first.length > 0 && first.length < 30)
  // The second round is still being read.
  assert.equal(list.held.length, 1)
  assert.equal(setup.engine.getState().sourceLoading, true)
  assert.deepEqual(
    setup.engine.getState().upcoming.map((item) => item.uri),
    first.map((index) => sourceTrack(index).uri),
  )

  list.hold.rounds = false
  list.held.shift()?.()
  await advance(100)
  assert.equal(setup.engine.getState().upcoming.length, 30)
  assert.equal(setup.engine.getState().sourceLoading, false)
  setup.engine.dispose()
})

test('an obsolete source load cannot replace newer playback', async () => {
  const setup = harness()
  let release: (items: PlayableItem[]) => void = () => undefined
  const pending = new Promise<PlayableItem[]>((resolve) => {
    release = resolve
  })
  await playSource(setup, { ...fixtureSource(2), load: () => pending })
  setup.engine.play(track)
  await settle()
  release([sourceTrack(0)])
  await settle()
  assert.equal(setup.engine.getState().current, track)
  assert.equal(setup.engine.getState().source, null)
  assert.equal(setup.sent('play').length, 1)
  setup.engine.dispose()
})

test('a failed source lookup keeps the manual queue and can be retried', async () => {
  const setup = harness()
  let fail = true
  const source: PlaybackSource = {
    ...fixtureSource(2),
    load: async (index) => {
      if (fail) throw new Error('Fixture unavailable')
      return [sourceTrack(index)]
    },
  }
  setup.engine.enqueue(track)
  await playSource(setup, source)
  assert.equal(setup.engine.getState().failure?.status, 'error')
  assert.equal(setup.engine.getState().queue.length, 1)
  assert.equal(setup.engine.getState().source?.label, 'Tracks')
  assert.equal(setup.sent('play').length, 0)
  fail = false
  setup.engine.toggle()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  assert.equal(setup.engine.getState().queue.length, 1)
  setup.engine.dispose()
})

test('previous returns to the preceding source song and next resumes without losing a song', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(4))
  setup.engine.next()
  await settle()
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(1).uri,
    contextUri: null,
  })
  await advance(700)
  setup.engine.previous()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(2).uri)
  setup.engine.dispose()
})

test('playing a queued item during the initial source lookup preserves the selected source song', async () => {
  const setup = harness()
  let release: (items: PlayableItem[]) => void = () => undefined
  const pending = new Promise<PlayableItem[]>((resolve) => {
    release = resolve
  })
  const source: PlaybackSource = {
    ...fixtureSource(2),
    load: async (index) => (index === 0 ? pending : [sourceTrack(index)]),
  }
  await playSource(setup, source)
  setup.engine.enqueue(track)
  const entry = setup.engine.getState().queue[0]
  assert.ok(entry)
  setup.engine.playFromQueue(entry.key)
  await settle()
  release([sourceTrack(0)])
  await settle()
  assert.equal(setup.engine.getState().current, track)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(0).uri)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  setup.engine.dispose()
})

test('shuffle changes during a pending next track use the latest source order', async () => {
  const setup = harness(() => 0.99)
  let release: (items: PlayableItem[]) => void = () => undefined
  const pending = new Promise<PlayableItem[]>((resolve) => {
    release = resolve
  })
  const source: PlaybackSource = {
    ...fixtureSource(3),
    load: async (index) => (index === 1 ? pending : [sourceTrack(index)]),
  }
  await playSource(setup, source)
  setup.engine.next()
  setup.engine.toggleShuffle()
  setup.engine.toggleShuffle()
  release([sourceTrack(1)])
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  assert.equal(setup.engine.getState().starting, true)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(2).uri)
  setup.engine.dispose()
})

test('turning shuffle on during the initial lookup does not repeat the selected track', async () => {
  const setup = harness(() => 0)
  let release: (items: PlayableItem[]) => void = () => undefined
  const pending = new Promise<PlayableItem[]>((resolve) => {
    release = resolve
  })
  const source: PlaybackSource = {
    ...fixtureSource(3),
    load: async (index) => (index === 0 ? pending : [sourceTrack(index)]),
  }
  await playSource(setup, source)
  setup.engine.toggleShuffle()
  release([sourceTrack(0)])
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  assert.deepEqual(
    setup.engine.getState().upcoming.map((item) => item.uri),
    [sourceTrack(1).uri, sourceTrack(2).uri],
  )
  setup.engine.dispose()
})

test('unrelated playback detaches the source without draining the manual queue', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3))
  setup.engine.enqueue(track)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(0).uri,
    contextUri: null,
    positionMs: 5_000,
  })
  await advance(700)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:elsewhere',
    contextUri: null,
    positionMs: 20_000,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().source, null)
  assert.equal(setup.engine.getState().queue.length, 1)
  assert.equal(setup.sent('play').length, 1)
  setup.engine.dispose()
})

test('natural source completion stops without wrapping or dropping its return link', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3, 2))
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(2).uri,
    contextUri: null,
    positionMs: 198_000,
  })
  await advance(700)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(2).uri,
    contextUri: null,
    paused: true,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().current, null)
  assert.deepEqual(setup.engine.getState().upcoming, [])
  assert.equal(setup.engine.getState().source?.label, 'Tracks')
  assert.equal(setup.sent('play').length, 1)
  setup.engine.dispose()
})

test('a rejected Spotify start retains the source song for retry and leaves the manual queue intact', async () => {
  const setup = harness()
  setup.engine.enqueue(track)
  setup.remote.failures.push(new PlaybackApiError(500, null))
  await playSource(setup, fixtureSource(3))
  assert.equal(setup.engine.getState().failure?.status, 'error')
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  assert.equal(setup.engine.getState().queue.length, 1)
  setup.engine.toggle()
  await settle()
  assert.equal(setup.engine.getState().failure, null)
  const withFollowing =
    'play speaker {"uris":["spotify:track:source-0","spotify:track:single","spotify:track:source-1","spotify:track:source-2"]}'
  assert.deepEqual(setup.sent('play'), [withFollowing, withFollowing])
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(1).uri)
  setup.engine.dispose()
})

test('previous follows the actual shuffled history and next restores the skipped song', async () => {
  const setup = harness(() => 0.99)
  await playSource(setup, fixtureSource(5))
  setup.engine.toggleShuffle()
  await settle()
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(4).uri)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(4).uri,
    contextUri: null,
  })
  await advance(700)
  setup.engine.previous()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(4).uri)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(3).uri)
  setup.engine.dispose()
})

test('shuffle includes earlier unplayed songs within the selected album', async () => {
  const setup = harness(() => 0)
  const source: PlaybackSource = {
    ...fixtureSource(1),
    load: async () => [sourceTrack(0), sourceTrack(1), sourceTrack(2)],
  }
  await playSource(setup, source, { ...album, startUri: sourceTrack(2).uri })
  assert.deepEqual(setup.engine.getState().upcoming, [])
  setup.engine.toggleShuffle()
  await settle()
  assert.deepEqual(
    setup.engine.getState().upcoming.map((item) => item.uri),
    [sourceTrack(0).uri, sourceTrack(1).uri],
  )
  setup.engine.next()
  await settle()
  setup.engine.toggleShuffle()
  await settle()
  assert.deepEqual(
    setup.engine.getState().upcoming.map((item) => item.uri),
    [sourceTrack(1).uri],
  )
  setup.engine.dispose()
})

test('a later preview failure preserves earlier songs and retries from the failed entry', async () => {
  const setup = harness()
  let unavailable = true
  const source: PlaybackSource = {
    ...fixtureSource(12),
    load: async (index) => {
      if (index === 9 && unavailable)
        throw new Error('Later fixture page unavailable')
      return [sourceTrack(index)]
    },
  }
  await playSource(setup, source)
  assert.equal(setup.engine.getState().failure?.status, 'error')
  assert.deepEqual(
    setup.engine.getState().upcoming.map((item) => item.uri),
    Array.from({ length: 8 }, (_, index) => sourceTrack(index + 1).uri),
  )
  for (let index = 1; index <= 8; index += 1) {
    setup.engine.next()
    await settle()
    assert.equal(setup.engine.getState().current?.uri, sourceTrack(index).uri)
  }
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(8).uri)
  assert.equal(setup.engine.getState().failure?.status, 'error')
  assert.deepEqual(setup.engine.getState().upcoming, [])
  unavailable = false
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(9).uri)
  assert.equal(setup.engine.getState().failure, null)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(10).uri)
  setup.engine.dispose()
})

test('a pending Next uses the resolved prefix even when a later preview entry fails', async () => {
  const setup = harness()
  let release: (items: PlayableItem[]) => void = () => undefined
  const pending = new Promise<PlayableItem[]>((resolve) => {
    release = resolve
  })
  const source: PlaybackSource = {
    ...fixtureSource(4),
    load: async (index) => {
      if (index === 1) return pending
      if (index === 3) throw new Error('Later fixture page unavailable')
      return [sourceTrack(index)]
    },
  }
  await playSource(setup, source)
  setup.engine.next()
  release([sourceTrack(1)])
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(2).uri)
  assert.equal(setup.engine.getState().failure?.status, 'error')
  setup.engine.dispose()
})

test('retrying a failed source lookup ignores old playback reported while it was loading', async () => {
  const setup = harness()
  let reject: (error: Error) => void = () => undefined
  let requests = 0
  const pending = new Promise<PlayableItem[]>((_, rejectLoad) => {
    reject = rejectLoad
  })
  const source: PlaybackSource = {
    ...fixtureSource(2),
    load: async (index) => {
      requests += 1
      return requests === 1 ? pending : [sourceTrack(index)]
    },
  }
  setup.engine.watch()
  await playSource(setup, source)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: track.uri,
    contextUri: null,
    positionMs: 30_000,
  })
  await advance(100)
  reject(new Error('Fixture lookup failed'))
  await settle()
  assert.equal(setup.engine.getState().failure?.status, 'error')
  assert.equal(setup.engine.getState().snapshot, null)
  setup.engine.toggle()
  await settle()
  assert.ok(requests > 1)
  assert.deepEqual(setup.sent('pause'), [])
  assert.deepEqual(setup.sent('play'), [
    'play speaker {"uris":["spotify:track:source-0","spotify:track:source-1"]}',
  ])
  setup.engine.dispose()
})

const sonosGroup: SonosGroupControl = {
  id: 'RINCON_FIXTURE:1',
  name: 'Fixture hi-fi',
  household: 'Sonos_fixture.home',
  playable: false,
  actions: { pause: true, play: true, next: true, previous: false, seek: true },
  volume: 0.3,
}

function fakeSonos(group: SonosGroupControl | null = sonosGroup) {
  const lookups: string[] = []
  const commands: string[] = []
  const failures: Error[] = []
  const reads: string[] = []
  const loads: string[] = []
  const loadFailures: Error[] = []
  /** What the group reports; tests change it as the group plays. */
  const room: { state: SonosGroupState } = { state: roomState(null) }
  const api: SonosControlApi = {
    async find(trackUri, device) {
      lookups.push(`${device} ${trackUri}`)
      return group
    },
    async command(groupId, command) {
      commands.push(
        `${groupId} ${command.action}${'positionMs' in command ? ` ${command.positionMs}` : ''}${'volume' in command ? ` ${command.volume}` : ''}`,
      )
      const failure = failures.shift()
      if (failure) throw failure
    },
    async state(groupId, volume) {
      reads.push(`${groupId}${volume ? ' volume' : ''}`)
      return volume ? { ...room.state, volume: 0.2 } : room.state
    },
    async load(groupId, input) {
      loads.push(
        `${groupId} ${input.mode} ${input.uris.join(',')}${input.play ? ' play' : ''}${input.skip ? ` skip ${input.skip}` : ''}${input.positionMs ? ` at ${input.positionMs}` : ''}`,
      )
      const failure = loadFailures.shift()
      if (failure) throw failure
    },
  }
  return { api, lookups, commands, failures, reads, loads, loadFailures, room }
}

function roomState(
  uri: string | null,
  values: Partial<SonosGroupState> = {},
): SonosGroupState {
  return {
    state: uri ? 'playing' : 'idle',
    positionMs: 0,
    track: uri
      ? {
          uri,
          name: 'Fixture track',
          artist: 'Fixture artist',
          album: 'Fixture album',
          artworkUrl: null,
          durationMs: 200_000,
        }
      : null,
    hasNext: false,
    containerUri: null,
    actions: {
      pause: true,
      play: true,
      next: true,
      previous: true,
      seek: true,
    },
    ...values,
  }
}

async function watchRestricted(sonos: ReturnType<typeof fakeSonos>) {
  const setup = harness(undefined, sonos.api)
  setup.remote.restricted = { name: 'Fixture hi-fi', type: 'speaker' }
  setup.remote.snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.engine.watch()
  await advance(100)
  return setup
}

test('a restricted Sonos group is controlled through the Sonos connection', async () => {
  const sonos = fakeSonos()
  const setup = await watchRestricted(sonos)
  const { engine } = setup
  assert.deepEqual(sonos.lookups, ['Fixture hi-fi spotify:track:one'])
  assert.deepEqual(engine.getState().target, {
    kind: 'sonos',
    name: 'Fixture hi-fi',
    type: 'speaker',
    group: sonosGroup,
  })
  assert.equal(engine.getState().volume, 0.3)

  engine.toggle()
  assert.equal(engine.getState().snapshot?.paused, true)
  engine.next()
  // Sonos refuses previous here, so it restarts the track instead.
  engine.previous()
  engine.seek(30_000)
  engine.setVolume(0.5)
  await advance(300)
  assert.deepEqual(sonos.commands, [
    'RINCON_FIXTURE:1 pause',
    'RINCON_FIXTURE:1 next',
    'RINCON_FIXTURE:1 seek 0',
    'RINCON_FIXTURE:1 seek 30000',
    'RINCON_FIXTURE:1 volume 0.5',
  ])
  assert.deepEqual(
    setup.calls.filter((call) => call !== 'state'),
    [],
  )

  // Later reports of the same track and device need no new lookup.
  await advance(6_000)
  assert.equal(sonos.lookups.length, 1)
  engine.dispose()
})

test('Next skips on the Sonos group instead of moving playback to start the queue', async () => {
  const sonos = fakeSonos()
  const setup = await watchRestricted(sonos)
  setup.engine.enqueue(track)
  setup.engine.next()
  await settle()
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 next'])
  assert.deepEqual(setup.sent('play'), [])
  assert.equal(setup.engine.getState().target.kind, 'sonos')
  assert.equal(setup.engine.getState().queue.length, 1)
  setup.engine.dispose()
})

test('a restricted device with no matching Sonos group stays shown only', async () => {
  const sonos = fakeSonos(null)
  const setup = await watchRestricted(sonos)
  assert.equal(setup.engine.getState().target.kind, 'restricted')
  setup.engine.toggle()
  await settle()
  assert.deepEqual(sonos.commands, [])

  // Each new track is looked up again.
  setup.remote.snapshot = remoteSnapshot({
    contextUri: 'spotify:playlist:x',
    trackUri: 'spotify:track:two',
  })
  await advance(3_000)
  assert.deepEqual(sonos.lookups, [
    'Fixture hi-fi spotify:track:one',
    'Fixture hi-fi spotify:track:two',
  ])
  setup.engine.dispose()
})

test('a refused Sonos command is reported and the group is looked up again', async () => {
  const sonos = fakeSonos()
  const setup = await watchRestricted(sonos)
  sonos.failures.push(
    Object.assign(new Error('Unprocessable'), {
      statusCode: 422,
      message:
        'Sonos did not accept that. The room may have changed; try again.',
    }),
  )
  setup.engine.toggle()
  await settle()
  assert.equal(
    setup.engine.getState().failure?.message,
    'Sonos did not accept that. The room may have changed; try again.',
  )
  await advance(3_000)
  assert.equal(sonos.lookups.length, 2)
  setup.engine.dispose()
})

/** Plays a source track in this browser, then reports the playback on a Sonos group. */
async function sourceMovedToSonos(sonos: ReturnType<typeof fakeSonos>) {
  const setup = harness(undefined, sonos.api)
  setup.engine.prepare()
  await settle()
  setup.engine.play(sourceTrack(0), fixtureSource(30))
  await settle()
  setup.emit('ready', { device_id: 'browser' })
  await advance(700)
  setup.local.state = sdkState({
    context: '',
    track: sourceTrack(0).uri,
    position: 1_000,
  })
  await advance(1_000)
  setup.local.state = null
  setup.emit('player_state_changed', null)
  setup.remote.restricted = { name: 'Fixture hi-fi', type: 'speaker' }
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(0).uri,
    contextUri: null,
    positionMs: 5_000,
  })
  await advance(4_000)
  return setup
}

test('the upcoming source tracks go to Spotify with the track, so they follow it to a Sonos group', async () => {
  const sonos = fakeSonos()
  const setup = await sourceMovedToSonos(sonos)
  assert.equal(setup.engine.getState().target.kind, 'sonos')
  const [started] = setup.sent('play')
  assert.ok(started?.includes(sourceTrack(1).uri), started)
  setup.engine.next()
  await settle()
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 next'])
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(1).uri,
    contextUri: null,
    positionMs: 0,
  })
  await advance(3_000)
  const state = setup.engine.getState()
  assert.equal(state.current?.uri, sourceTrack(1).uri)
  assert.equal(state.upcoming[0]?.uri, sourceTrack(2).uri)
  assert.equal(state.target.kind, 'sonos')
  assert.equal(setup.sent('play').length, 1)
  setup.engine.dispose()
})

test('a group without a next track to skip to ignores Next', async () => {
  const sonos = fakeSonos({
    ...sonosGroup,
    actions: { ...sonosGroup.actions, next: false },
  })
  const setup = await sourceMovedToSonos(sonos)
  setup.engine.next()
  await settle()
  assert.deepEqual(sonos.commands, [])
  assert.equal(setup.sent('play').length, 1)
  setup.engine.dispose()
})

test('a skip made on the Sonos group past several sent tracks moves the queue to that track', async () => {
  const sonos = fakeSonos()
  const setup = await sourceMovedToSonos(sonos)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(3).uri,
    contextUri: null,
    positionMs: 2_000,
  })
  await advance(3_000)
  const state = setup.engine.getState()
  assert.equal(state.current?.uri, sourceTrack(3).uri)
  assert.equal(state.upcoming[0]?.uri, sourceTrack(4).uri)
  assert.equal(state.source?.label, 'Tracks')
  setup.engine.dispose()
})

test('the Sonos group is looked up again while Sonos has not caught up with Spotify', async () => {
  const sonos = fakeSonos()
  const find = sonos.api.find
  let lookups = 0
  sonos.api.find = async (trackUri, device) => {
    lookups += 1
    return lookups === 1 ? null : find(trackUri, device)
  }
  const setup = await watchRestricted(sonos)
  assert.equal(setup.engine.getState().target.kind, 'restricted')
  assert.equal(setup.engine.getState().findingSonos, true)
  await advance(6_000)
  assert.equal(setup.engine.getState().target.kind, 'sonos')
  assert.equal(setup.engine.getState().findingSonos, false)
  assert.equal(lookups, 2)
  setup.engine.dispose()
})

test('a device that moves on to the next sent track is followed without another start', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(5))
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(0).uri,
    contextUri: null,
    positionMs: 198_000,
  })
  await advance(700)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(1).uri,
    contextUri: null,
    positionMs: 500,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(2).uri)
  assert.deepEqual(setup.sent('play'), [
    'play speaker {"uris":["spotify:track:source-0","spotify:track:source-1","spotify:track:source-2","spotify:track:source-3","spotify:track:source-4"]}',
  ])

  // A track queued since then is due first, so it replaces what the device moved to.
  setup.engine.enqueue(track)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(2).uri,
    contextUri: null,
    positionMs: 500,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().current?.uri, track.uri)
  assert.equal(setup.engine.getState().queue.length, 0)
  assert.equal(
    setup.sent('play')[1],
    'play speaker {"uris":["spotify:track:single","spotify:track:source-2","spotify:track:source-3","spotify:track:source-4"]}',
  )
  setup.engine.dispose()
})

test('the sent tracks running out ends playback instead of stepping back to the first', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(2))
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(0).uri,
    contextUri: null,
    positionMs: 1_000,
  })
  await advance(700)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(1).uri,
    contextUri: null,
    positionMs: 198_000,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(0).uri,
    contextUri: null,
    paused: true,
    positionMs: 0,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().current, null)
  assert.equal(setup.sent('play').length, 1)
  setup.engine.dispose()
})

test('shuffle is remembered for lists and an album starts in order', async () => {
  const saved: boolean[] = []
  const setup = harness(() => 0.99, undefined, {
    initialShuffle: true,
    onShuffle: (shuffle) => saved.push(shuffle),
  })
  assert.equal(setup.engine.getState().shuffle, true)
  await playSource(setup, { ...fixtureSource(5), kind: 'album' })
  assert.equal(setup.engine.getState().shuffle, false)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(1).uri)
  // Shuffling this album leaves the remembered setting alone.
  setup.engine.toggleShuffle()
  assert.equal(setup.engine.getState().shuffle, true)
  setup.engine.toggleShuffle()
  assert.deepEqual(saved, [])

  setup.engine.play(sourceTrack(0), fixtureSource(5))
  await settle()
  assert.equal(setup.engine.getState().shuffle, true)
  assert.equal(setup.engine.getState().upcoming[0]?.uri, sourceTrack(4).uri)
  setup.engine.toggleShuffle()
  assert.deepEqual(saved, [false])
  setup.engine.toggleShuffle()
  assert.deepEqual(saved, [false, true])
  // An album played on its own is in order too, and leaves the setting alone.
  setup.engine.play(album)
  assert.equal(setup.engine.getState().shuffle, false)
  setup.engine.toggleShuffle()
  assert.deepEqual(saved, [false, true])
  setup.engine.play(sourceTrack(0), fixtureSource(5))
  assert.equal(setup.engine.getState().shuffle, true)
  setup.engine.dispose()
})

const kitchen = {
  id: 'RINCON_FIXTURE:1',
  name: 'Fixture kitchen',
  household: 'Sonos_fixture.home',
}

/**
 * Plays a source track in this browser, then chooses a Sonos room under Play
 * on. Spotify has no details of the `unknown` tracks.
 */
async function sourceOnRoom(
  sonos: ReturnType<typeof fakeSonos>,
  unknown: string[] = [],
) {
  const setup = harness(undefined, sonos.api)
  for (const uri of unknown) setup.failLookup(uri)
  setup.engine.prepare()
  await settle()
  setup.engine.play(sourceTrack(0), fixtureSource(40))
  await settle()
  setup.emit('ready', { device_id: 'browser' })
  await advance(700)
  setup.local.state = sdkState({
    context: '',
    track: sourceTrack(0).uri,
    position: 1_000,
  })
  await advance(1_000)
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  await settle()
  sonos.room.state = roomState(sourceTrack(0).uri, {
    positionMs: 2_000,
    hasNext: true,
  })
  await advance(1_000)
  return setup
}

test('a Sonos room is given the next track as soon as it has been read', async () => {
  const sonos = fakeSonos()
  const setup = harness(sequence(), sonos.api, {
    initialShuffle: true,
    initialRoom: kitchen,
  })
  const list = scatteredSource(500)
  list.hold.rounds = true
  setup.engine.prepare()
  await settle()
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  setup.engine.play(sourceTrack(0), list.source)
  await settle()
  sonos.room.state = roomState(sourceTrack(0).uri, { positionMs: 1_000 })
  await advance(3_000)
  assert.equal(sonos.loads.length, 1)
  assert.match(sonos.loads[0] ?? '', /replace spotify:track:source-0 play/)
  assert.equal(setup.engine.getState().upcoming.length, 0)

  const reads = sonos.reads.length
  list.held.shift()?.()
  await settle()
  const next = setup.engine.getState().upcoming[0]
  assert.ok(next)
  // No report was read from the group in between.
  assert.equal(sonos.reads.length, reads)
  assert.equal(sonos.loads[1], `RINCON_FIXTURE:1 append ${next.uri} play`)
  setup.engine.dispose()
})

test('choosing a Sonos room moves the track there with the tracks that follow it', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  assert.deepEqual(setup.sent('pause'), ['pause browser'])
  assert.match(
    sonos.loads[0] ?? '',
    /^RINCON_FIXTURE:1 replace spotify:track:source-0 play at \d+$/,
  )
  // The tracks that follow are added one at a time.
  assert.deepEqual(
    sonos.loads.slice(1),
    Array.from(
      { length: 10 },
      (_, index) =>
        `RINCON_FIXTURE:1 append ${sourceTrack(index + 1).uri} play`,
    ),
  )
  const state = setup.engine.getState()
  assert.deepEqual(state.target, { kind: 'room', room: kitchen })
  assert.equal(state.current?.uri, sourceTrack(0).uri)
  assert.equal(state.snapshot?.trackUri, sourceTrack(0).uri)
  assert.equal(state.snapshot?.paused, false)
  assert.equal(state.volume, 0.2)
  assert.equal(state.source?.label, 'Tracks')
  assert.equal(state.failure, null)
  setup.engine.dispose()
})

test('Next on a Sonos room skips in its queue and the queue is topped up', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  const loaded = sonos.loads.length
  const reads = sonos.reads.length
  setup.engine.next()
  // The next track shows at once, before Sonos answers or reports it.
  let shown = setup.engine.getState()
  assert.equal(shown.current?.uri, sourceTrack(1).uri)
  assert.equal(shown.snapshot?.trackUri, sourceTrack(1).uri)
  assert.equal(
    shown.snapshot?.trackName,
    `Spotify name of ${sourceTrack(1).uri}`,
  )
  assert.equal(shown.snapshot?.durationMs, 180_000)
  assert.equal(shown.snapshot?.positionMs, 0)
  assert.equal(shown.snapshot?.paused, false)
  assert.equal(shown.upcoming[0]?.uri, sourceTrack(2).uri)
  assert.equal(sonos.reads.length, reads)
  await settle()
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 next'])
  // The room is read as soon as Sonos has answered the command.
  await advance(100)
  assert.equal(sonos.reads.length, reads + 1)
  sonos.room.state = roomState(sourceTrack(1).uri, { hasNext: true })
  await advance(3_000)
  setup.engine.next()
  shown = setup.engine.getState()
  assert.equal(shown.current?.uri, sourceTrack(2).uri)
  await settle()
  sonos.room.state = roomState(sourceTrack(2).uri, { hasNext: true })
  await advance(3_000)
  const state = setup.engine.getState()
  assert.equal(state.current?.uri, sourceTrack(2).uri)
  assert.equal(state.upcoming[0]?.uri, sourceTrack(3).uri)
  assert.deepEqual(sonos.commands, [
    'RINCON_FIXTURE:1 next',
    'RINCON_FIXTURE:1 next',
  ])
  // Nothing is started again; the queue only grows at its end.
  assert.deepEqual(sonos.loads.slice(loaded), [
    'RINCON_FIXTURE:1 append spotify:track:source-11 play',
    'RINCON_FIXTURE:1 append spotify:track:source-12 play',
  ])
  setup.engine.dispose()
})

test('a track Sonos reports by URI alone is described by the queue, then by Spotify', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  // Sonos has no name, artist or length for a track it loaded by ID, and its
  // artwork is served from the speaker on the home network.
  const bare = (uri: string, positionMs: number) =>
    roomState(uri, {
      positionMs,
      hasNext: true,
      track: {
        uri,
        name: null,
        artist: null,
        album: null,
        artworkUrl: 'http://10.0.0.2:1400/getaa?u=fixture',
        durationMs: null,
      },
    })
  setup.engine.next()
  await settle()
  sonos.room.state = bare(sourceTrack(1).uri, 1_000)
  await advance(3_000)
  let shown = setup.engine.getState().snapshot
  assert.equal(shown?.trackUri, sourceTrack(1).uri)
  assert.equal(shown?.trackName, `Spotify name of ${sourceTrack(1).uri}`)
  assert.equal(shown?.artists, 'Spotify artist')
  assert.equal(shown?.durationMs, 180_000)
  assert.equal(shown?.artworkUrl, 'https://images.example/cover.jpg')
  assert.equal(shown?.linkedFromUri, null)
  // Each track is read from Spotify once, however often the room reports it.
  await advance(9_000)
  assert.deepEqual(
    setup.lookups.filter((uri) => uri === sourceTrack(1).uri),
    [sourceTrack(1).uri],
  )
  // With its length known, the track running out carries the queue on.
  sonos.room.state = bare(sourceTrack(1).uri, 179_000)
  await advance(3_000)
  sonos.room.state = bare(sourceTrack(2).uri, 500)
  await advance(3_000)
  shown = setup.engine.getState().snapshot
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(2).uri)
  assert.equal(shown?.trackName, `Spotify name of ${sourceTrack(2).uri}`)
  assert.equal(setup.engine.getState().failure, null)
  setup.engine.dispose()
})

test('a room track Spotify cannot describe keeps what the queue knows of it', async () => {
  const sonos = fakeSonos()
  const uri = sourceTrack(1).uri
  const setup = await sourceOnRoom(sonos, [uri])
  setup.engine.next()
  await settle()
  sonos.room.state = roomState(uri, {
    positionMs: 1_000,
    hasNext: true,
    track: {
      uri,
      name: null,
      artist: null,
      album: null,
      artworkUrl: null,
      durationMs: null,
    },
  })
  await advance(6_000)
  const shown = setup.engine.getState().snapshot
  assert.equal(shown?.trackName, sourceTrack(1).title)
  assert.equal(shown?.artists, sourceTrack(1).artist)
  assert.equal(shown?.durationMs, 0)
  assert.equal(setup.engine.getState().failure, null)
  assert.deepEqual(
    setup.lookups.filter((seen) => seen === uri),
    [uri],
  )
  setup.engine.dispose()
})

test('a Sonos room that is slow to skip keeps showing the track it was told to play', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  setup.engine.next()
  // Sonos has answered, and the room still reports the track before.
  await advance(3_000)
  let state = setup.engine.getState()
  assert.equal(state.current?.uri, sourceTrack(1).uri)
  assert.equal(state.snapshot?.trackUri, sourceTrack(1).uri)
  sonos.room.state = roomState(sourceTrack(1).uri, {
    positionMs: 2_500,
    hasNext: true,
  })
  await advance(1_000)
  state = setup.engine.getState()
  assert.equal(state.snapshot?.trackUri, sourceTrack(1).uri)
  assert.equal(state.snapshot?.trackName, 'Fixture track')
  assert.equal(state.failure, null)
  setup.engine.dispose()
})

test('a Sonos room that never skips is shown as it is once the wait is over', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  setup.engine.next()
  await advance(8_000)
  const state = setup.engine.getState()
  assert.equal(state.snapshot?.trackUri, sourceTrack(0).uri)
  assert.equal(state.current?.uri, sourceTrack(0).uri)
  setup.engine.dispose()
})

test('a skip Sonos refuses is reported and the room is shown as it is', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  sonos.failures.push(new Error('Sonos did not accept that.'))
  setup.engine.next()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  await advance(1_000)
  const state = setup.engine.getState()
  assert.notEqual(state.failure, null)
  assert.equal(state.snapshot?.trackUri, sourceTrack(0).uri)
  assert.equal(state.current?.uri, sourceTrack(0).uri)
  setup.engine.dispose()
})

test('a Sonos report read before a command was answered does not undo it', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  const read = sonos.api.state
  let answer = () => undefined
  sonos.api.state = async (groupId, volume) => {
    const reported = await read(groupId, volume)
    await new Promise<void>((resolve) => {
      answer = () => {
        resolve()
        return undefined
      }
    })
    return reported
  }
  // A read is under way when Pause is pressed.
  await advance(3_000)
  const reads = sonos.reads.length
  setup.engine.toggle()
  assert.equal(setup.engine.getState().snapshot?.paused, true)
  await settle()
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 pause'])
  sonos.api.state = read
  sonos.room.state = roomState(sourceTrack(0).uri, {
    state: 'paused',
    positionMs: 5_000,
    hasNext: true,
  })
  // The earlier read answers with the room still playing and is read again.
  answer()
  await settle()
  assert.equal(setup.engine.getState().snapshot?.paused, true)
  assert.equal(sonos.reads.length, reads + 1)
  await advance(3_000)
  assert.equal(setup.engine.getState().snapshot?.paused, true)
  setup.engine.dispose()
})

test('a skip waits for a queue change on its way to the Sonos room', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  const load = sonos.api.load
  let finish = () => undefined
  sonos.api.load = async (groupId, input) => {
    await load(groupId, input)
    await new Promise<void>((resolve) => {
      finish = () => {
        resolve()
        return undefined
      }
    })
  }
  setup.engine.enqueue(track)
  await advance(3_000)
  assert.equal(
    sonos.loads.at(-1),
    'RINCON_FIXTURE:1 next spotify:track:single play',
  )
  setup.engine.next()
  // The queued track shows at once; the skip follows the track into the room.
  assert.equal(setup.engine.getState().current, track)
  await settle()
  assert.deepEqual(sonos.commands, [])
  sonos.api.load = load
  finish()
  await settle()
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 next'])
  setup.engine.dispose()
})

test('a Sonos room that moves on by itself is followed without another start', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  sonos.room.state = roomState(sourceTrack(0).uri, {
    positionMs: 198_000,
    hasNext: true,
  })
  await advance(3_000)
  // The page was asleep while the room played two more tracks.
  sonos.room.state = roomState(sourceTrack(3).uri, {
    positionMs: 4_000,
    hasNext: true,
  })
  await advance(3_000)
  const state = setup.engine.getState()
  assert.equal(state.current?.uri, sourceTrack(3).uri)
  assert.equal(state.upcoming[0]?.uri, sourceTrack(4).uri)
  assert.equal(
    sonos.loads.filter((load) => load.includes(' replace ')).length,
    1,
  )
  setup.engine.dispose()
})

test('playing something else while on a Sonos room starts it on the room', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  setup.engine.play(track)
  await settle()
  assert.equal(
    sonos.loads.at(-1),
    'RINCON_FIXTURE:1 replace spotify:track:single play',
  )
  // Sonos accepted the track, so it shows as playing before the room reports it.
  const accepted = setup.engine.getState()
  assert.equal(accepted.starting, false)
  assert.equal(accepted.snapshot?.trackUri, track.uri)
  assert.equal(accepted.snapshot?.paused, false)
  sonos.room.state = roomState(track.uri)
  await advance(1_000)
  const state = setup.engine.getState()
  assert.equal(state.target.kind, 'room')
  assert.equal(state.current, track)
  assert.equal(state.snapshot?.trackUri, track.uri)
  assert.equal(state.failure, null)
  assert.deepEqual(setup.sent('play').length, 1)
  setup.engine.dispose()
})

test('a track queued while on a Sonos room is placed next in its queue', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  const loaded = sonos.loads.length
  setup.engine.enqueue(track)
  await advance(3_000)
  assert.deepEqual(sonos.loads.slice(loaded), [
    'RINCON_FIXTURE:1 next spotify:track:single play',
  ])
  sonos.room.state = roomState(sourceTrack(0).uri, {
    positionMs: 198_000,
    hasNext: true,
  })
  await advance(3_000)
  sonos.room.state = roomState(track.uri, { positionMs: 500, hasNext: true })
  await advance(3_000)
  let state = setup.engine.getState()
  assert.equal(state.current, track)
  assert.deepEqual(state.queue, [])
  // The source carries on after it, from the tracks already in the room's queue.
  sonos.room.state = roomState(track.uri, {
    positionMs: 198_000,
    hasNext: true,
  })
  await advance(3_000)
  sonos.room.state = roomState(sourceTrack(1).uri, { hasNext: true })
  await advance(3_000)
  state = setup.engine.getState()
  assert.equal(state.current?.uri, sourceTrack(1).uri)
  assert.equal(
    sonos.loads.filter((load) => load.includes(' replace ')).length,
    1,
  )
  setup.engine.dispose()
})

test("a queued track is kept out of a paused Sonos room's playback", async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  setup.engine.toggle()
  await settle()
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 pause'])
  sonos.room.state = roomState(sourceTrack(0).uri, {
    state: 'paused',
    positionMs: 3_000,
    hasNext: true,
  })
  await advance(3_000)
  setup.engine.enqueue(track)
  await advance(5_000)
  assert.equal(sonos.loads.at(-1), 'RINCON_FIXTURE:1 next spotify:track:single')
  setup.engine.dispose()
})

test('the queue carries on when a Sonos room has played everything it was given', async () => {
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api)
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  setup.engine.play(track)
  await settle()
  assert.deepEqual(sonos.loads, [
    'RINCON_FIXTURE:1 replace spotify:track:single play',
  ])
  sonos.room.state = roomState(track.uri, { positionMs: 1_000 })
  await advance(1_000)
  setup.engine.enqueue(album)
  sonos.room.state = roomState(track.uri, { positionMs: 198_000 })
  await advance(3_000)
  // A finished Sonos queue goes idle at the start of its first track.
  sonos.room.state = roomState(track.uri, { state: 'idle' })
  await advance(3_000)
  assert.equal(
    sonos.loads.at(-1),
    'RINCON_FIXTURE:1 replace spotify:album:first play',
  )
  assert.equal(setup.engine.getState().current, album)
  sonos.room.state = roomState('spotify:track:one', {
    containerUri: album.uri,
    hasNext: true,
  })
  await advance(1_000)
  assert.equal(setup.engine.getState().starting, false)
  assert.equal(setup.engine.getState().snapshot?.contextUri, album.uri)
  setup.engine.dispose()
})

test('an album started from one of its tracks skips to that track on a Sonos room', async () => {
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api)
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  setup.engine.play({ ...album, startUri: 'spotify:track:four' })
  await settle()
  assert.deepEqual(setup.sent('album index'), [
    'album index spotify:album:first spotify:track:four',
  ])
  assert.deepEqual(sonos.loads, [
    'RINCON_FIXTURE:1 replace spotify:album:first play skip 3',
  ])
  setup.engine.dispose()
})

test('a track taken off the queue stops a Sonos room that reaches it with nothing else due', async () => {
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api)
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  setup.engine.play(track)
  await settle()
  sonos.room.state = roomState(track.uri, { positionMs: 1_000 })
  await advance(1_000)
  setup.engine.enqueue(sourceTrack(7))
  await advance(3_000)
  assert.equal(
    sonos.loads.at(-1),
    'RINCON_FIXTURE:1 append spotify:track:source-7 play',
  )
  const [queued] = setup.engine.getState().queue
  assert.ok(queued)
  setup.engine.removeFromQueue(queued.key)
  sonos.room.state = roomState(track.uri, { positionMs: 198_000 })
  await advance(3_000)
  sonos.room.state = roomState(sourceTrack(7).uri, { positionMs: 500 })
  await advance(3_000)
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 pause'])
  assert.equal(setup.engine.getState().current, null)
  setup.engine.dispose()
})

test('a Sonos group Spotify reports takes new playback through Sonos', async () => {
  const sonos = fakeSonos({ ...sonosGroup, playable: true })
  const setup = await watchRestricted(sonos)
  assert.equal(setup.engine.getState().target.kind, 'sonos')
  setup.engine.play(track)
  await settle()
  assert.deepEqual(sonos.loads, [
    'RINCON_FIXTURE:1 replace spotify:track:single play',
  ])
  assert.deepEqual(setup.engine.getState().target, {
    kind: 'room',
    room: {
      id: sonosGroup.id,
      name: sonosGroup.name,
      household: sonosGroup.household,
    },
  })
  assert.equal(setup.engine.getState().failure, null)
  assert.deepEqual(setup.sent('play'), [])
  // From here the room is read through Sonos, not through Spotify.
  const reports = setup.sent('state').length
  sonos.room.state = roomState(track.uri, { positionMs: 800 })
  await advance(3_000)
  assert.equal(setup.sent('state').length, reports)
  assert.equal(setup.engine.getState().snapshot?.trackUri, track.uri)
  setup.engine.dispose()
})

test('Next past the tracks Spotify gave a Sonos group starts the track due through Sonos', async () => {
  const sonos = fakeSonos({
    ...sonosGroup,
    playable: true,
    actions: { ...sonosGroup.actions, next: false },
  })
  const setup = await watchRestricted(sonos)
  setup.engine.enqueue(track)
  setup.engine.next()
  await settle()
  assert.deepEqual(sonos.commands, [])
  assert.deepEqual(sonos.loads, [
    'RINCON_FIXTURE:1 replace spotify:track:single play',
  ])
  assert.equal(setup.engine.getState().target.kind, 'room')
  setup.engine.dispose()
})

test('leaving a Sonos room for this browser starts the track here at the same place', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  sonos.room.state = roomState(sourceTrack(0).uri, {
    positionMs: 60_000,
    hasNext: true,
  })
  await advance(3_000)
  await setup.engine.selectDevice({ kind: 'local' })
  await settle()
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 pause'])
  const started = setup.sent('play').at(-1) ?? ''
  assert.match(started, /^play browser \{"uris":\["spotify:track:source-0",/)
  assert.match(started, /"position_ms":6\d{4}\}$/)
  assert.equal(setup.engine.getState().target.kind, 'local')
  setup.engine.dispose()
})

test('the chosen Sonos room is remembered and shown when the player opens', async () => {
  const sonos = fakeSonos()
  const saved: Array<string | null> = []
  const setup = harness(undefined, sonos.api, {
    initialRoom: kitchen,
    onRoom: (room) => saved.push(room?.id ?? null),
  })
  assert.deepEqual(setup.engine.getState().target, {
    kind: 'room',
    room: kitchen,
  })
  sonos.room.state = roomState('spotify:track:elsewhere', {
    state: 'paused',
    positionMs: 30_000,
  })
  setup.engine.watch()
  await advance(100)
  const state = setup.engine.getState()
  assert.equal(state.snapshot?.trackUri, 'spotify:track:elsewhere')
  assert.equal(state.snapshot?.paused, true)
  assert.deepEqual(setup.sent('state'), [])
  await setup.engine.selectDevice({ kind: 'local' })
  assert.deepEqual(saved, [null])
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  assert.deepEqual(saved, [null, kitchen.id])
  setup.engine.dispose()
})

test('a change Sonos refuses is reported and the room keeps playing what it has', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  sonos.loadFailures.push(new Error('refused'))
  setup.engine.enqueue(track)
  await advance(3_000)
  assert.ok(setup.engine.getState().failure)
  const attempts = sonos.loads.length
  await advance(6_000)
  // It is not sent again at once.
  assert.equal(sonos.loads.length, attempts)
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  setup.engine.dispose()
})
