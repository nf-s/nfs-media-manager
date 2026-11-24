import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import {
  createPlaybackEngine,
  type PlaybackEngineOptions,
  type PlaybackTarget,
} from './playback-engine'
import type {
  PendingPlaybackSource,
  PlayableItem,
  PlaybackSnapshot,
  PlaybackSource,
  PlayedTrack,
  QueueEntry,
} from './playback'
import {
  PlaybackApiError,
  type PlaybackDevice,
  type PlayerApi,
  type RestrictedDevice,
} from './spotify-player-api'
import type { SpotifySdk, SpotifySdkPlayer } from './spotify-sdk'
import type { SonosControlApi } from './sonos-player-api'
import type {
  SonosGroupControl,
  SonosGroupState,
  SonosRooms,
  SonosStateReason,
} from '@repo/schemas/sonos'
import type { LastfmPlay } from '@repo/schemas/lastfm'
import {
  PLAYBACK_LEASE_MS,
  SavedPlaybackSchema,
  type SavedPlayback,
  type SavedSource,
} from '@repo/schemas/playback'
import {
  EMPTY_PLAYBACK_SESSION,
  releasePlaybackSession,
  syncPlaybackSession,
} from '../../server/src/services/playback-session'
import { createPlaybackSync, type SessionApi } from './playback-sync'

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

/** What Spotify reports for the account; pages of one account share it. */
type SpotifyWorld = {
  device: PlaybackDevice | null
  restricted: RestrictedDevice | null
  snapshot: PlaybackSnapshot | null
  devices: PlaybackDevice[]
  failures: Error[]
  contextTracks?: string[]
  nativeQueue?: string[]
  /** The account's play history; null when it may not be read. */
  history?: PlayedTrack[] | null
}

function harness(
  random?: () => number,
  sonos?: SonosControlApi,
  shuffle: Pick<
    PlaybackEngineOptions,
    | 'initialShuffle'
    | 'onShuffle'
    | 'initialRoom'
    | 'onRoom'
    | 'browserId'
    | 'restoreSource'
    | 'scrobbles'
  > = {},
  world?: SpotifyWorld,
) {
  const calls: string[] = []
  /** Tracks whose details were read from Spotify. */
  const lookups: string[] = []
  const failingLookups = new Set<string>()
  /** Tracks Spotify was asked which recording it plays for. */
  const asked: string[] = []
  /** The recording Spotify plays for a track: another one, or none. */
  const recordings = new Map<string, string | null>()
  const page = { visible: true }
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const local: { state: unknown } = { state: null }
  const remote: SpotifyWorld = world ?? {
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
  function spotifyQueue() {
    const snapshot = remote.snapshot
    const current = snapshot?.trackUri
      ? { uri: snapshot.trackUri, linkedFromUri: snapshot.linkedFromUri }
      : null
    const uri = current?.linkedFromUri ?? current?.uri
    const context = remote.contextTracks ?? []
    const native = remote.nativeQueue ?? []
    const contextIndex = uri ? context.indexOf(uri) : -1
    const nativeIndex = uri ? native.indexOf(uri) : -1
    if (contextIndex > 0) remote.contextTracks = context.slice(contextIndex)
    if (nativeIndex >= 0) remote.nativeQueue = native.slice(nativeIndex + 1)
    return {
      current,
      upcoming: [
        ...(remote.nativeQueue ?? []),
        ...(remote.contextTracks ?? []).slice(1),
      ].map((uri) => ({ uri, linkedFromUri: null })),
    }
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
    async play(device, body) {
      await command(`play ${device} ${JSON.stringify(body)}`)
      remote.contextTracks =
        body &&
        typeof body === 'object' &&
        'uris' in body &&
        Array.isArray(body.uris)
          ? body.uris.filter((uri): uri is string => typeof uri === 'string')
          : []
      remote.nativeQueue = []
    },
    async enqueue(device, uri) {
      await command(`enqueue ${device} ${uri}`)
      spotifyQueue()
      remote.nativeQueue = [...(remote.nativeQueue ?? []), uri]
    },
    async queue() {
      await command('queue')
      return spotifyQueue()
    },
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
    async played(since) {
      calls.push(`history ${since}`)
      return remote.history ?? null
    },
    async recording(trackUri) {
      asked.push(trackUri)
      if (failingLookups.has(trackUri)) throw new PlaybackApiError(404, null)
      const recording = recordings.get(trackUri)
      return recording === null
        ? null
        : {
            uri: recording ?? trackUri,
            name: `Spotify name of ${trackUri}`,
          }
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
    api,
    engine,
    calls,
    lookups,
    failLookup(uri: string) {
      failingLookups.add(uri)
    },
    asked,
    playsAs(uri: string, recording: string | null) {
      recordings.set(uri, recording)
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

test('an item that stops everywhere unfinished is kept to start again', async () => {
  const setup = harness()
  await playLocally(setup, album, {
    context: album.uri,
    track: 'spotify:track:one',
    position: 5_000,
  })
  const started = setup.sent('play').length
  setup.local.state = null
  await advance(3_000)
  const state = setup.engine.getState()
  assert.equal(state.current, album)
  assert.equal(state.snapshot?.paused, true)
  assert.equal(state.snapshot?.trackUri, 'spotify:track:one')
  assert.equal(state.active, true)
  assert.equal(setup.sent('play').length, started)

  // Play starts it again where it stopped.
  setup.engine.toggle()
  await settle()
  assert.equal(
    setup.sent('play').at(-1),
    `play browser {"context_uri":"spotify:album:first","offset":{"uri":"spotify:track:one"},"position_ms":${state.snapshot?.positionMs}}`,
  )
  setup.engine.dispose()
})

test('clears the player when playback that ran out stops everywhere', async () => {
  const setup = harness()
  await playLocally(setup, album, {
    context: album.uri,
    track: 'spotify:track:one',
    position: 199_500,
    next: 0,
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

test('one failed check keeps the session; repeated failures stop following it', async () => {
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
  // The album is kept, paused where it was last seen, to start again.
  assert.equal(engine.getState().current, album)
  assert.equal(engine.getState().snapshot?.paused, true)
  assert.equal(
    engine.getState().failure?.message,
    'Spotify could not complete that request.',
  )
  assert.equal(setup.sent('play').length, 1)
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

function pendingSource() {
  let resolve: (source: PlaybackSource) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<PlaybackSource>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { resolve, reject, promise }
}

function pendingFixture(
  count: ReturnType<typeof pendingSource>,
  readPageEnd: PendingPlaybackSource['readPageEnd'],
): PendingPlaybackSource {
  const { kind, label, startIndex, load } = fixtureSource(4, 1)
  return {
    kind,
    label,
    startIndex,
    load,
    href: '/tracks',
    resolve: () => count.promise,
    withLength: (length) => fixtureSource(length, 1),
    readPageEnd,
  }
}

test('starts a loaded track while its Browse playback source is still counting', async () => {
  const setup = harness()
  const pending = pendingSource()
  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  setup.engine.play(
    sourceTrack(1),
    pendingFixture(pending, (index) =>
      index < 4
        ? Promise.resolve({ end: 4, hasMore: true })
        : new Promise(() => undefined),
    ),
  )
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.engine.getState().source, {
    label: 'Tracks',
    href: '/tracks',
  })
  const saved = setup.engine.saved()
  assert.ok(saved)
  assert.equal(saved.source, null)

  const removed = setup.engine.getState().upcoming[0]
  assert.ok(removed)
  setup.engine.removeUpcoming(removed.key)

  const queued = sourceTrack(8)
  setup.engine.enqueue(queued)
  pending.resolve(fixtureSource(4, 1))
  await settle()
  assert.deepEqual(
    setup.engine.getState().queue.map(({ item }) => item),
    [queued],
  )
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(
    setup.engine.getState().upcoming.map(({ item }) => item.uri),
    [sourceTrack(3).uri],
  )
  setup.engine.dispose()
})

test('a deferred Browse source preserves queue removals and follows a Spotify output transfer', async () => {
  const setup = harness()
  const pending = pendingSource()
  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  setup.engine.play(
    sourceTrack(1),
    pendingFixture(pending, async () => ({ end: 4, hasMore: false })),
  )
  await settle()
  setup.engine.enqueue(sourceTrack(8))
  setup.engine.enqueue(sourceTrack(9))
  const removed = setup.engine.getState().queue[0]
  assert.ok(removed)
  setup.engine.removeFromQueue(removed.key)
  setup.engine.clearQueue()
  const output: PlaybackDevice = { ...speaker, id: 'other', name: 'Other' }
  await setup.engine.selectDevice({ kind: 'remote', device: output })

  pending.resolve(fixtureSource(4, 1))
  await settle()
  assert.deepEqual(setup.engine.getState().target, {
    kind: 'remote',
    device: output,
  })
  assert.deepEqual(setup.engine.getState().queue, [])
  assert.deepEqual(
    setup.engine.getState().upcoming.map(({ item }) => item.uri),
    [sourceTrack(2).uri, sourceTrack(3).uri],
  )
  setup.engine.dispose()
})

test('ordered Browse playback can advance across a page boundary after the count fails', async () => {
  const setup = harness()
  const pending = pendingSource()
  const pageReads: number[] = []
  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  setup.engine.play(sourceTrack(1), {
    ...pendingFixture(pending, async (index) => {
      pageReads.push(index)
      return index < 3 ? { end: 3, hasMore: true } : { end: 5, hasMore: false }
    }),
    withLength: (length) => ({
      ...fixtureSource(length, 1),
      descriptor: { type: 'browse', collection: 'tracks', params: '' },
    }),
  })
  pending.reject(new Error('Count unavailable'))
  await settle()
  assert.deepEqual(pageReads, [1, 3])
  assert.equal(setup.engine.saved()?.source?.length, 5)
  assert.deepEqual(
    setup.engine.getState().upcoming.map(({ item }) => item.uri),
    [sourceTrack(2).uri, sourceTrack(3).uri, sourceTrack(4).uri],
  )
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(2).uri)

  setup.remote.device = speaker
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
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(3).uri)

  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(3).uri,
    contextUri: null,
    positionMs: 500,
  })
  await advance(700)
  setup.engine.previous()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(2).uri)
  assert.deepEqual(pageReads, [1, 3])
  setup.engine.dispose()
})

test('a failed or obsolete Browse count leaves the current playback alone', async () => {
  for (const outcome of ['failed', 'obsolete']) {
    const setup = harness()
    const pending = pendingSource()
    await setup.engine.selectDevice({ kind: 'remote', device: speaker })
    setup.engine.play(
      sourceTrack(1),
      pendingFixture(pending, async () => ({ end: 4, hasMore: false })),
    )
    await settle()
    if (outcome === 'failed') {
      pending.reject(new Error('Count unavailable'))
    } else {
      setup.engine.play(sourceTrack(3))
      await settle()
      pending.resolve(fixtureSource(4, 1))
    }
    await settle()
    assert.equal(
      setup.engine.getState().current?.uri,
      sourceTrack(outcome === 'failed' ? 1 : 3).uri,
    )
    assert.equal(
      setup.engine.getState().source?.href,
      outcome === 'failed' ? '/tracks' : undefined,
    )
    assert.equal(setup.engine.getState().failure, null)
    setup.engine.dispose()
  }
})

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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(16).uri,
  )
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(1).uri,
  )
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current, queued)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  assert.equal(setup.engine.getState().queue.length, 0)
  setup.engine.dispose()
})

/** The upcoming source tracks as their numbers in the fixture source. */
function upcomingNumbers(state: { upcoming: QueueEntry[] }, count = 5) {
  return state.upcoming
    .slice(0, count)
    .map((entry) => Number(entry.item.uri.replace('spotify:track:source-', '')))
}

test('playing an upcoming source track skips to it and keeps the manual queue', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(40))
  setup.engine.enqueue(track)
  const target = setup.engine.getState().upcoming[3]
  assert.equal(target?.item.uri, sourceTrack(4).uri)
  setup.engine.playUpcoming(target?.key ?? '')
  await settle()
  const state = setup.engine.getState()
  assert.equal(state.current?.uri, sourceTrack(4).uri)
  // The tracks before it are passed over, and the source goes on after it.
  assert.deepEqual(upcomingNumbers(state), [5, 6, 7, 8, 9])
  assert.equal(state.upcoming.length, 30)
  assert.deepEqual(
    state.queue.map((entry) => entry.item.uri),
    [track.uri],
  )
  // The device gets the track with the queue and the source tracks after it.
  const started = setup.sent('play').at(-1) ?? ''
  assert.ok(
    started.includes(
      `"uris":["${sourceTrack(4).uri}","${track.uri}","${sourceTrack(5).uri}"`,
    ),
    started,
  )
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current, track)
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(5).uri)
  // A key that is no longer upcoming starts nothing.
  const plays = setup.sent('play').length
  setup.engine.playUpcoming(target?.key ?? '')
  await settle()
  assert.equal(setup.sent('play').length, plays)
  setup.engine.dispose()
})

test('upcoming source tracks play in the order they were moved into', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(40))
  setup.engine.moveUpcoming(0, 2)
  await settle()
  assert.deepEqual(upcomingNumbers(setup.engine.getState()), [2, 3, 1, 4, 5])
  assert.equal(
    setup.engine.getState().announcement,
    'Track 1: position 3 of upcoming tracks',
  )
  setup.engine.moveUpcoming(4, 0)
  await settle()
  assert.deepEqual(upcomingNumbers(setup.engine.getState()), [5, 2, 3, 1, 4])
  // Moves outside the list change nothing.
  setup.engine.moveUpcoming(0, -1)
  setup.engine.moveUpcoming(0, 30)
  setup.engine.moveUpcoming(30, 0)
  await settle()
  assert.deepEqual(upcomingNumbers(setup.engine.getState()), [5, 2, 3, 1, 4])
  for (const index of [5, 2, 3, 1, 4, 6]) {
    setup.engine.next()
    await settle()
    assert.equal(setup.engine.getState().current?.uri, sourceTrack(index).uri)
  }
  // The source is still read in its own order after the moved tracks.
  assert.deepEqual(upcomingNumbers(setup.engine.getState()), [7, 8, 9, 10, 11])
  assert.equal(setup.engine.getState().upcoming.length, 30)
  setup.engine.dispose()
})

test('a track removed from the upcoming source tracks does not come back', async () => {
  const setup = harness(() => 0)
  await playSource(setup, fixtureSource(6))
  const removed = setup.engine.getState().upcoming[1]
  assert.equal(removed?.item.uri, sourceTrack(2).uri)
  const plays = setup.sent('play').length
  setup.engine.removeUpcoming(removed?.key ?? '')
  await settle()
  assert.deepEqual(upcomingNumbers(setup.engine.getState()), [1, 3, 4, 5])
  assert.equal(
    setup.engine.getState().announcement,
    'Removed from upcoming tracks: Track 2',
  )
  assert.equal(setup.sent('play').length, plays)
  // Shuffle draws again from the whole source, but not the removed track.
  setup.engine.toggleShuffle()
  await settle()
  assert.deepEqual(upcomingNumbers(setup.engine.getState()), [1, 3, 4, 5])
  setup.engine.toggleShuffle()
  await settle()
  for (const index of [1, 3, 4, 5]) {
    setup.engine.next()
    await settle()
    assert.equal(setup.engine.getState().current?.uri, sourceTrack(index).uri)
  }
  assert.deepEqual(setup.engine.getState().upcoming, [])
  setup.engine.dispose()
})

test('an upcoming source track moved to the queue plays from there and leaves the source', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(40))
  setup.engine.enqueue(track)
  const [first, , third] = setup.engine.getState().upcoming
  const plays = setup.sent('play').length
  // Without a position it goes to the end of the queue.
  setup.engine.queueUpcoming(third?.key ?? '')
  // With one it is placed there.
  setup.engine.queueUpcoming(first?.key ?? '', 0)
  await settle()
  const state = setup.engine.getState()
  assert.deepEqual(
    state.queue.map((entry) => entry.item.uri),
    [sourceTrack(1).uri, track.uri, sourceTrack(3).uri],
  )
  assert.equal(new Set(state.queue.map((entry) => entry.key)).size, 3)
  assert.deepEqual(upcomingNumbers(state), [2, 4, 5, 6, 7])
  assert.equal(state.upcoming.length, 30)
  assert.equal(state.announcement, 'Moved to queue: Track 1')
  assert.equal(setup.sent('play').length, plays)
  for (const uri of [
    sourceTrack(1).uri,
    track.uri,
    sourceTrack(3).uri,
    sourceTrack(2).uri,
    sourceTrack(4).uri,
  ]) {
    setup.engine.next()
    await settle()
    assert.equal(setup.engine.getState().current?.uri, uri)
  }
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
    setup.engine.getState().upcoming.map((entry) => entry.item.uri),
    [0, 1, 2, 4, 5].map((index) => sourceTrack(index).uri),
  )
  setup.engine.clearQueue()
  setup.engine.next()
  await settle()
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)
  setup.engine.toggleShuffle()
  await settle()
  assert.deepEqual(
    setup.engine.getState().upcoming.map((entry) => entry.item.uri),
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(5).uri,
  )
  setup.engine.next()
  await settle()
  setup.engine.toggleShuffle()
  await settle()
  assert.deepEqual(
    setup.engine.getState().upcoming.map((entry) => entry.item.uri),
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
  const upcoming = setup.engine
    .getState()
    .upcoming.map((entry) => entry.item.uri)
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
    new Set(setup.engine.getState().upcoming.map((entry) => entry.item.uri))
      .size,
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
      .upcoming.map((entry) => entry.item.uri)
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
    setup.engine.getState().upcoming.map((entry) => entry.item.uri),
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(2).uri,
  )
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(0).uri,
  )
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(2).uri,
  )
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
    setup.engine.getState().upcoming.map((entry) => entry.item.uri),
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
  const before = setup.sent('play')
  setup.remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:elsewhere',
    contextUri: null,
    positionMs: 20_000,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().source, null)
  assert.equal(setup.engine.getState().queue.length, 1)
  assert.deepEqual(setup.sent('play'), before)
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(1).uri,
  )
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(3).uri,
  )
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
    setup.engine.getState().upcoming.map((entry) => entry.item.uri),
    [sourceTrack(0).uri, sourceTrack(1).uri],
  )
  setup.engine.next()
  await settle()
  setup.engine.toggleShuffle()
  await settle()
  assert.deepEqual(
    setup.engine.getState().upcoming.map((entry) => entry.item.uri),
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
    setup.engine.getState().upcoming.map((entry) => entry.item.uri),
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(10).uri,
  )
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(2).uri,
  )
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
  const readReasons: Array<SonosStateReason | undefined> = []
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
    async state(groupId, volume, reason) {
      reads.push(`${groupId}${volume ? ' volume' : ''}`)
      readReasons.push(reason)
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
  return {
    api,
    lookups,
    commands,
    failures,
    reads,
    readReasons,
    loads,
    loadFailures,
    room,
  }
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
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(2).uri)
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
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(4).uri)
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(2).uri,
  )
  assert.deepEqual(setup.sent('play'), [
    'play speaker {"uris":["spotify:track:source-0","spotify:track:source-1","spotify:track:source-2","spotify:track:source-3","spotify:track:source-4"]}',
  ])

  // The edit reaches Spotify before the current track ends.
  setup.engine.enqueue(track)
  await advance(700)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.sent('enqueue'), [
    'enqueue speaker spotify:track:single',
  ])
  const staged = await setup.api.queue()
  assert.deepEqual(
    staged.upcoming.map((item) => item.uri),
    [track.uri, ...[2, 3, 4].map((index) => sourceTrack(index).uri)],
  )
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(1).uri)
  assert.equal(setup.engine.getState().queue[0]?.item.uri, track.uri)

  setup.remote.snapshot = remoteSnapshot({
    trackUri: track.uri,
    contextUri: null,
    positionMs: 500,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().current?.uri, track.uri)
  assert.equal(setup.engine.getState().queue.length, 0)
  setup.remote.snapshot = playing(2, 500)
  await advance(3_000)
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(2).uri)
  assert.equal(setup.sent('play').length, 1)
  setup.engine.dispose()
})

test('queueing on Spotify Web Player does not restart the current track', async () => {
  const setup = harness()
  const device = { ...speaker, id: 'web-player', type: 'computer' }
  const play = setup.api.play
  setup.api.play = async (target, body) => {
    await play(target, body)
    setup.remote.snapshot = playing(0, 0)
  }
  await setup.engine.selectDevice({ kind: 'remote', device })
  const source = fixtureSource(3)
  setup.engine.play(sourceTrack(0), source)
  await settle()
  setup.remote.device = device
  setup.remote.snapshot = playing(0, 14_000)
  await advance(700)

  setup.engine.enqueue(track)
  await advance(700)
  assert.equal(setup.sent('play').length, 1)
  assert.equal(setup.remote.snapshot?.positionMs, 14_000)
  assert.deepEqual(setup.sent('enqueue'), [
    'enqueue web-player spotify:track:single',
  ])
  assert.equal((await setup.api.queue()).upcoming[0]?.uri, track.uri)
  setup.engine.dispose()
})

test('Next skips to a track already accepted into the native Connect queue', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3))
  setup.remote.snapshot = playing(0, 14_000)
  await advance(700)
  setup.engine.enqueue(track)
  await advance(700)
  setup.engine.next()
  await settle()
  assert.deepEqual(setup.sent('next'), ['next speaker'])
  assert.equal(setup.sent('play').length, 1)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: track.uri,
    contextUri: null,
  })
  await advance(700)
  assert.equal(setup.engine.getState().current?.uri, track.uri)
  assert.deepEqual(setup.engine.getState().queue, [])
  setup.engine.dispose()
})

test('clearing the last native entry stops at the boundary without replaying the current track', async () => {
  const setup = harness()
  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  setup.remote.device = speaker
  setup.engine.play(sourceTrack(0))
  await settle()
  setup.remote.snapshot = playing(0, 14_000)
  await advance(700)
  setup.engine.enqueue(track)
  await advance(700)
  setup.engine.clearQueue()
  await advance(700)
  assert.deepEqual(setup.sent('pause'), [])
  assert.equal(setup.sent('play').length, 1)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: track.uri,
    contextUri: null,
  })
  await advance(3_000)
  assert.deepEqual(setup.sent('pause'), ['pause speaker'])
  assert.equal(setup.engine.getState().current, null)
  setup.engine.dispose()
})

test('a lost append response does not restart the queued track when Spotify plays it', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3))
  setup.remote.snapshot = playing(0, 14_000)
  await advance(700)
  const enqueue = setup.api.enqueue
  setup.api.enqueue = async (device, uri) => {
    await enqueue(device, uri)
    throw new TypeError('Response unavailable')
  }
  setup.engine.enqueue(track)
  await advance(700)
  setup.remote.snapshot = playing(0, 198_000)
  await advance(3_000)
  setup.remote.snapshot = remoteSnapshot({
    trackUri: track.uri,
    contextUri: null,
    positionMs: 250,
  })
  await advance(3_000)
  assert.equal(setup.engine.getState().current?.uri, track.uri)
  assert.equal(setup.sent('enqueue').length, 1)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.engine.getState().queue, [])
  setup.engine.dispose()
})

test('a refused Connect queue update keeps the last sent list and corrects the next track', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3))
  setup.remote.snapshot = playing(0, 14_000)
  await advance(700)
  const sent = setup.engine.saved()?.session?.sent
  assert.deepEqual(
    sent?.map((item) => item.uri),
    [0, 1, 2].map((index) => sourceTrack(index).uri),
  )

  const enqueue = setup.api.enqueue
  setup.api.enqueue = (device, uri) => {
    setup.remote.failures.push(new PlaybackApiError(403, null))
    setup.api.enqueue = enqueue
    return enqueue(device, uri)
  }
  setup.engine.enqueue(track)
  await advance(700)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.sent('enqueue'), [
    'enqueue speaker spotify:track:single',
  ])
  assert.deepEqual(setup.engine.saved()?.session?.sent, sent)
  assert.equal(setup.engine.getState().queue[0]?.item.uri, track.uri)
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(0).uri)

  setup.remote.snapshot = playing(0, 198_000)
  await advance(3_000)
  assert.equal(setup.sent('play').length, 1)
  assert.equal(setup.sent('enqueue').length, 1)
  setup.remote.snapshot = playing(1, 500)
  await advance(3_000)
  assert.equal(setup.engine.getState().current?.uri, track.uri)
  assert.equal(setup.engine.getState().queue.length, 0)
  assert.deepEqual(setup.sent('play').slice(1), [
    'play speaker {"uris":["spotify:track:single","spotify:track:source-1","spotify:track:source-2"]}',
  ])
  setup.engine.dispose()
})

test('a paused Connect queue edit uses plain resume and preserves the position', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3))
  setup.remote.snapshot = playing(0, 14_000)
  await advance(700)
  setup.remote.snapshot = { ...playing(0, 15_000), paused: true }
  await advance(3_000)
  setup.engine.enqueue(track)
  await advance(3_000)

  assert.equal(setup.engine.getState().snapshot?.paused, true)
  assert.equal(setup.engine.getState().snapshot?.positionMs, 15_000)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.sent('resume'), [])

  setup.engine.toggle()
  await settle()
  setup.remote.snapshot = playing(0, 15_000)
  await advance(700)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.sent('resume'), ['resume speaker'])
  assert.deepEqual(setup.sent('enqueue'), [
    'enqueue speaker spotify:track:single',
  ])
  assert.equal((await setup.api.queue()).upcoming[0]?.uri, track.uri)
  assert.equal(setup.engine.getState().snapshot?.positionMs, 15_000)
  assert.equal(setup.engine.getState().queue[0]?.item.uri, track.uri)
  setup.engine.dispose()
})

test('Connect appends coalesced edits and corrects a cleared native queue at the boundary', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3))
  setup.remote.snapshot = playing(0, 14_000)
  await advance(700)

  setup.engine.enqueue(track)
  setup.engine.enqueue(sourceTrack(10))
  setup.engine.enqueue(sourceTrack(11))
  const removed = setup.engine.getState().queue[2]
  assert.ok(removed)
  setup.engine.removeFromQueue(removed.key)
  setup.engine.moveInQueue(1, 0)
  await advance(700)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.sent('enqueue'), [
    'enqueue speaker spotify:track:source-10',
    'enqueue speaker spotify:track:single',
  ])
  assert.deepEqual(
    (await setup.api.queue()).upcoming.map((item) => item.uri),
    [sourceTrack(10).uri, track.uri, sourceTrack(1).uri, sourceTrack(2).uri],
  )

  setup.remote.snapshot = playing(0, 16_000)
  setup.engine.clearQueue()
  setup.engine.enqueue(sourceTrack(12))
  await advance(700)
  assert.equal(setup.sent('play').length, 1)
  assert.equal(setup.sent('enqueue').length, 2)
  assert.equal((await setup.api.queue()).upcoming[0]?.uri, sourceTrack(10).uri)

  setup.remote.snapshot = playing(0, 198_000)
  await advance(3_000)
  setup.remote.snapshot = playing(10, 500)
  await advance(3_000)
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(12).uri)
  assert.equal(setup.engine.getState().queue.length, 0)
  assert.deepEqual(setup.sent('play').slice(1), [
    'play speaker {"uris":["spotify:track:source-12","spotify:track:source-1","spotify:track:source-2"]}',
  ])
  setup.engine.dispose()
})

test('a last-moment Connect edit is checked at the track boundary', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3))
  setup.remote.snapshot = playing(0, 199_700)
  await advance(700)
  setup.engine.enqueue(track)
  await advance(100)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.sent('enqueue'), [])

  setup.remote.snapshot = playing(1, 100)
  await advance(400)
  assert.equal(setup.engine.getState().current?.uri, track.uri)
  assert.deepEqual(setup.sent('play').slice(1), [
    'play speaker {"uris":["spotify:track:single","spotify:track:source-1","spotify:track:source-2"]}',
  ])
  setup.engine.dispose()
})

test('Connect leaves an unknown native queue entry alone', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3))
  setup.remote.snapshot = playing(0, 12_000)
  await advance(700)
  setup.remote.nativeQueue = ['spotify:track:external']
  const reads = setup.sent('queue').length

  setup.engine.enqueue(track)
  await advance(700)
  assert.ok(setup.sent('queue').length > reads)
  assert.deepEqual(setup.sent('enqueue'), [])
  assert.equal(setup.sent('play').length, 1)
  assert.equal(setup.engine.getState().queue[0]?.item.uri, track.uri)
  assert.equal(
    (await setup.api.queue()).upcoming[0]?.uri,
    'spotify:track:external',
  )
  setup.engine.dispose()
})

test('a newer Connect queue append waits for the in-flight append', async () => {
  const setup = harness()
  await playSource(setup, fixtureSource(3))
  setup.remote.snapshot = playing(0, 10_000)
  await advance(700)
  const enqueue = setup.api.enqueue
  let accept: () => void = () => undefined
  setup.api.enqueue = async (device, uri) => {
    await enqueue(device, uri)
    await new Promise<void>((resolve) => {
      accept = resolve
    })
  }
  setup.engine.enqueue(track)
  await advance(700)
  setup.engine.enqueue(sourceTrack(9))
  await advance(700)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.sent('enqueue'), [
    'enqueue speaker spotify:track:single',
  ])
  assert.equal(setup.engine.saved()?.session?.sent[1]?.uri, sourceTrack(1).uri)

  setup.api.enqueue = enqueue
  accept()
  await advance(3_000)
  assert.equal(setup.sent('play').length, 1)
  assert.deepEqual(setup.sent('enqueue'), [
    'enqueue speaker spotify:track:single',
    'enqueue speaker spotify:track:source-9',
  ])
  assert.deepEqual(
    (await setup.api.queue()).upcoming.map((item) => item.uri),
    [track.uri, sourceTrack(9).uri, sourceTrack(1).uri, sourceTrack(2).uri],
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
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(1).uri,
  )
  // Shuffling this album leaves the remembered setting alone.
  setup.engine.toggleShuffle()
  assert.equal(setup.engine.getState().shuffle, true)
  setup.engine.toggleShuffle()
  assert.deepEqual(saved, [])

  setup.engine.play(sourceTrack(0), fixtureSource(5))
  await settle()
  assert.equal(setup.engine.getState().shuffle, true)
  assert.equal(
    setup.engine.getState().upcoming[0]?.item.uri,
    sourceTrack(4).uri,
  )
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
  configure?: (api: PlayerApi) => void,
) {
  const setup = harness(undefined, sonos.api)
  configure?.(setup.api)
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
  assert.equal(sonos.loads[1], `RINCON_FIXTURE:1 append ${next.item.uri} play`)
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
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(2).uri)
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
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(3).uri)
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
  const relink = 'spotify:track:fixture-relinked'
  const setup = await sourceOnRoom(sonos, [], (api) => {
    const readDetails = api.track
    api.track = async (uri) => {
      const details = await readDetails(uri)
      return uri === sourceTrack(1).uri
        ? { ...details, trackUri: relink, linkedFromUri: uri }
        : details
    }
  })
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
  assert.equal(shown?.relinkedTrackUri, relink)
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
  await advance(15_000)
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
  await advance(15_000)
  // The page was asleep while the room played two more tracks.
  sonos.room.state = roomState(sourceTrack(3).uri, {
    positionMs: 4_000,
    hasNext: true,
  })
  await advance(15_000)
  const state = setup.engine.getState()
  assert.equal(state.current?.uri, sourceTrack(3).uri)
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(4).uri)
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
  await advance(15_000)
  sonos.room.state = roomState(track.uri, { positionMs: 500, hasNext: true })
  await advance(15_000)
  let state = setup.engine.getState()
  assert.equal(state.current, track)
  assert.deepEqual(state.queue, [])
  // The source carries on after it, from the tracks already in the room's queue.
  sonos.room.state = roomState(track.uri, {
    positionMs: 198_000,
    hasNext: true,
  })
  await advance(15_000)
  sonos.room.state = roomState(sourceTrack(1).uri, { hasNext: true })
  await advance(15_000)
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
  await advance(15_000)
  assert.equal(
    sonos.loads.at(-1),
    'RINCON_FIXTURE:1 replace spotify:album:first play',
  )
  assert.equal(setup.engine.getState().current, album)
  sonos.room.state = roomState('spotify:track:one', {
    containerUri: album.uri,
    hasNext: true,
  })
  await advance(3_000)
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
  await advance(15_000)
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
  await advance(15_000)
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
  assert.deepEqual(sonos.readReasons, ['room-watching'])
  assert.deepEqual(setup.sent('state'), [])
  await setup.engine.selectDevice({ kind: 'local' })
  assert.deepEqual(saved, [null])
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  assert.deepEqual(saved, [null, kitchen.id])
  setup.engine.dispose()
})

test('a Sonos queue is polled less while paused and stops polling while paused and hidden', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  setup.engine.watch()
  sonos.room.state = roomState(sourceTrack(0).uri, {
    state: 'paused',
    positionMs: 2_000,
    hasNext: true,
  })
  await advance(100)
  assert.equal(setup.engine.getState().snapshot?.paused, true)
  let reads = sonos.reads.length
  await advance(90_000)
  assert.equal(sonos.reads.length - reads, 3)
  assert.deepEqual(sonos.readReasons.slice(reads), [
    'room-paused',
    'room-paused',
    'room-paused',
  ])

  setup.page.visible = false
  reads = sonos.reads.length
  // A read already scheduled while visible may finish, without scheduling more.
  await advance(30_000)
  assert.equal(sonos.reads.length - reads, 1)
  reads = sonos.reads.length
  await advance(30_000)
  assert.equal(sonos.reads.length, reads)

  setup.page.visible = true
  setup.engine.refresh()
  await advance(100)
  assert.equal(sonos.reads.length - reads, 1)
  setup.engine.dispose()
})

test('a hidden page keeps polling the Sonos room while it runs a playing queue', async () => {
  const sonos = fakeSonos()
  const setup = await sourceOnRoom(sonos)
  setup.page.visible = false
  const reads = sonos.reads.length
  await advance(60_000)
  assert.equal(sonos.reads.length - reads, 4)
  assert.equal(sonos.readReasons[reads], 'room-playing')
  setup.engine.dispose()
})

test('a passive page mirrors a Sonos room without reading it at startup or during playback', async () => {
  const sonos = fakeSonos()
  const driver = harness(undefined, sonos.api, { initialRoom: kitchen })
  const follower = harness(undefined, sonos.api, { initialRoom: kitchen })
  const shown = remoteSnapshot({ trackUri: track.uri, trackName: track.title })
  sonos.room.state = roomState(track.uri)
  follower.engine.setSonosPolling(false)
  follower.engine.watch()
  await advance(100)
  assert.deepEqual(sonos.reads, [])
  follower.remote.restricted = { name: 'Fixture speaker', type: 'speaker' }
  follower.remote.snapshot = remoteSnapshot({})
  follower.engine.followSonos(null)
  await advance(100)
  assert.equal(follower.engine.getState().target.kind, 'restricted')
  assert.deepEqual(sonos.lookups, [])

  driver.engine.watch()
  follower.engine.followSonos({
    target: { kind: 'room', room: kitchen },
    snapshot: shown,
    volume: 0.3,
  })
  await advance(100)
  const initial = sonos.reads.length
  assert.equal(initial, 1)
  follower.engine.refresh()
  await advance(30_000)
  assert.equal(sonos.reads.length - initial, 2)
  assert.equal(follower.engine.getState().snapshot?.trackName, track.title)
  assert.equal(follower.engine.getState().volume, 0.3)
  assert.deepEqual(follower.lookups, [])
  assert.deepEqual(sonos.loads, [])
  driver.engine.dispose()
  follower.engine.dispose()
})

test('a passive page uses shared Sonos Connect controls without a lookup', async () => {
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api)
  const snapshot = remoteSnapshot({ contextUri: 'spotify:playlist:x' })
  setup.remote.restricted = { name: 'Fixture hi-fi', type: 'speaker' }
  setup.remote.snapshot = snapshot
  setup.engine.setSonosPolling(false)
  setup.engine.watch()
  await advance(6_000)
  assert.equal(setup.engine.getState().target.kind, 'restricted')
  assert.deepEqual(sonos.lookups, [])

  const target: PlaybackTarget = {
    kind: 'sonos',
    name: 'Fixture hi-fi',
    type: 'speaker',
    group: sonosGroup,
  }
  setup.engine.followSonos({ target, snapshot, volume: 0.3 })
  setup.engine.toggle()
  setup.engine.seek(30_000)
  setup.engine.setVolume(0.5)
  await advance(1_000)
  assert.deepEqual(setup.engine.getState().target, target)
  assert.equal(setup.engine.getState().volume, 0.3)
  assert.deepEqual(sonos.commands, [])

  setup.engine.setSonosPolling(true)
  setup.engine.toggle()
  await settle()
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 pause'])

  setup.engine.setSonosPolling(false)
  setup.engine.followSonos(null)
  await advance(100)
  assert.equal(setup.engine.getState().target.kind, 'restricted')
  assert.deepEqual(sonos.lookups, [])
  setup.engine.dispose()
})

test('a room report begun before demotion cannot replace the shared report after promotion', async () => {
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api, { initialRoom: kitchen })
  const room = sonos.api.state
  let answer: (state: SonosGroupState) => void = () => undefined
  sonos.api.state = () =>
    new Promise((resolve) => {
      answer = resolve
    })
  setup.engine.watch()
  await advance(100)

  setup.engine.setSonosPolling(false)
  const shown = remoteSnapshot({ trackUri: track.uri })
  setup.engine.followSonos({
    target: { kind: 'room', room: kitchen },
    snapshot: shown,
    volume: 0.7,
  })
  sonos.api.state = room
  setup.engine.setSonosPolling(true)
  answer(roomState('spotify:track:old', { volume: 0.4 }))
  await settle()
  assert.equal(setup.engine.getState().snapshot?.trackUri, track.uri)
  assert.equal(setup.engine.getState().volume, 0.7)
  setup.engine.dispose()
})

test('a restricted device match begun before demotion cannot replace shared controls', async () => {
  const sonos = fakeSonos()
  let answer: (group: SonosGroupControl) => void = () => undefined
  sonos.api.find = () =>
    new Promise((resolve) => {
      answer = resolve
    })
  const setup = await watchRestricted(sonos)
  assert.equal(setup.engine.getState().findingSonos, true)
  setup.engine.setSonosPolling(false)
  const target: PlaybackTarget = {
    kind: 'sonos',
    name: 'Fixture hi-fi',
    type: 'speaker',
    group: { ...sonosGroup, id: 'RINCON_SHARED_FIXTURE:1', volume: 0.7 },
  }
  setup.engine.followSonos({
    target,
    snapshot: remoteSnapshot({}),
    volume: 0.7,
  })
  setup.engine.setSonosPolling(true)
  answer(sonosGroup)
  await settle()
  assert.deepEqual(setup.engine.getState().target, target)
  assert.equal(setup.engine.getState().volume, 0.7)
  assert.equal(setup.engine.getState().findingSonos, false)
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

/** A source that can be saved with a session and read again on another page. */
function savedFixtureSource(length: number, startIndex = 0): PlaybackSource {
  return {
    ...fixtureSource(length, startIndex),
    descriptor: {
      type: 'browse',
      collection: 'tracks',
      params: 'sortBy=title&direction=asc',
    },
  }
}

const restoreSource = (saved: SavedSource) =>
  savedFixtureSource(saved.length, saved.startIndex)

/** A saved session as another page receives it from the server. */
function transferred(saved: SavedPlayback | null) {
  return SavedPlaybackSchema.parse(JSON.parse(JSON.stringify(saved)))
}

function playing(index: number, positionMs: number) {
  return remoteSnapshot({
    trackUri: sourceTrack(index).uri,
    contextUri: null,
    positionMs,
  })
}

test('nothing is saved until something is played or queued here', async () => {
  const setup = harness()
  assert.equal(setup.engine.saved(), null)
  setup.remote.device = { ...speaker, active: true }
  setup.remote.snapshot = remoteSnapshot({})
  setup.engine.watch()
  await advance(100)
  // Playback started elsewhere is shown, but it is not this app's session.
  assert.ok(setup.engine.getState().snapshot)
  assert.equal(setup.engine.saved(), null)
  setup.engine.enqueue(track)
  assert.equal(setup.engine.saved()?.queue.length, 1)
  setup.engine.dispose()
})

test('a device update publishes added recording identity without advancing the queue', async () => {
  const setup = harness()
  setup.remote.device = { ...speaker, active: true }
  setup.remote.snapshot = remoteSnapshot({})
  setup.engine.watch()
  await advance(100)
  const before = setup.engine.getState().snapshot
  assert.ok(before)
  setup.engine.enqueue(track)
  const queued = setup.engine.getState().queue
  const calls = [...setup.calls]
  setup.remote.snapshot = remoteSnapshot({
    positionMs: 3_000,
    linkedFromUri: 'spotify:track:original',
    albumUri: 'spotify:album:actual',
  })
  await advance(3_000)
  const after = setup.engine.getState().snapshot
  assert.equal(after?.trackUri, before.trackUri)
  assert.equal(after?.linkedFromUri, 'spotify:track:original')
  assert.equal(after?.albumUri, 'spotify:album:actual')
  assert.deepEqual(setup.engine.getState().queue, queued)
  assert.deepEqual(setup.calls, [...calls, 'state'])
  setup.engine.dispose()
})

test('a saved session is picked up on another page from the track the device has reached', async () => {
  const first = harness(undefined, undefined, { browserId: 'page-one' })
  await playSource(first, savedFixtureSource(40))
  first.remote.snapshot = playing(0, 1_000)
  await advance(700)
  first.engine.enqueue(track)
  const saved = transferred(first.engine.saved())
  assert.equal(saved.current?.uri, sourceTrack(0).uri)
  assert.equal(saved.session?.sent.length, 31)
  assert.deepEqual(saved.source?.remaining, [[1, 40]])
  assert.deepEqual(saved.target, {
    kind: 'spotify',
    device: {
      id: 'speaker',
      name: 'Fixture speaker',
      type: 'speaker',
      volume: 0.4,
    },
    browser: null,
  })
  first.engine.dispose()

  // The device played on with nothing open and is two tracks further.
  const second = harness(
    undefined,
    undefined,
    { browserId: 'page-two', restoreSource },
    first.remote,
  )
  second.remote.device = { ...speaker, active: true }
  second.remote.snapshot = playing(2, 5_000)
  await second.engine.restore(saved)
  await settle()
  const state = second.engine.getState()
  assert.equal(state.current?.uri, sourceTrack(2).uri)
  assert.equal(state.snapshot?.trackUri, sourceTrack(2).uri)
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(3).uri)
  assert.equal(state.source?.label, 'Tracks')
  assert.equal(state.target.kind, 'remote')
  assert.equal(state.starting, false)
  assert.deepEqual(
    state.queue.map((entry) => entry.item.uri),
    [track.uri],
  )
  // Nothing was sent to the device: it kept playing what it had.
  assert.deepEqual(second.sent('play'), [])
  assert.deepEqual(second.sent('transfer'), [])
  assert.deepEqual(second.sent('enqueue'), [])

  // After rejoining, a fresh read delivers the edit saved just before close.
  second.remote.snapshot = playing(2, 25_000)
  await advance(3_000)
  assert.deepEqual(second.sent('play'), [])
  assert.deepEqual(second.sent('enqueue'), [
    'enqueue speaker spotify:track:single',
  ])
  assert.deepEqual(
    (await second.api.queue()).upcoming.slice(0, 2).map((item) => item.uri),
    [track.uri, sourceTrack(3).uri],
  )
  second.remote.snapshot = remoteSnapshot({
    trackUri: track.uri,
    contextUri: null,
  })
  await advance(3_000)
  assert.equal(second.engine.getState().current?.uri, track.uri)
  assert.deepEqual(second.sent('play'), [])
  second.engine.dispose()
})

test('a queued album stays ahead of the remaining source after rejoining Connect', async () => {
  const first = harness()
  await playSource(first, savedFixtureSource(4))
  first.remote.snapshot = playing(0, 5_000)
  await advance(700)
  first.engine.enqueue(album)
  const saved = transferred(first.engine.saved())
  first.engine.dispose()
  const second = harness(undefined, undefined, { restoreSource }, first.remote)
  second.remote.snapshot = playing(2, 5_000)
  await second.engine.restore(saved)
  assert.deepEqual(
    second.engine.getState().queue.map((entry) => entry.item.uri),
    [album.uri],
  )
  assert.deepEqual(
    second.engine.getState().upcoming.map((entry) => entry.item.uri),
    [sourceTrack(3).uri],
  )
  assert.deepEqual(second.sent('play'), [])
  second.engine.dispose()
})

test('rejoining a saved track list with an unavailable source keeps it on Spotify', async () => {
  const first = harness()
  await playSource(first, savedFixtureSource(4))
  first.remote.snapshot = playing(0, 5_000)
  await advance(700)
  const saved = transferred(first.engine.saved())
  first.engine.dispose()
  const second = harness(
    undefined,
    undefined,
    { restoreSource: () => null },
    first.remote,
  )
  await second.engine.restore(saved)
  await advance(4_000)
  assert.deepEqual(second.sent('play'), [])
  assert.deepEqual(second.engine.saved()?.session?.sent, saved.session?.sent)
  second.engine.dispose()
})

test('a restored queue and source are kept when other playback has taken the device', async () => {
  const first = harness()
  await playSource(first, savedFixtureSource(10))
  first.remote.snapshot = playing(0, 1_000)
  await advance(700)
  first.engine.enqueue(track)
  const saved = transferred(first.engine.saved())
  first.engine.dispose()

  const second = harness(undefined, undefined, { restoreSource })
  second.remote.device = { ...speaker, active: true }
  second.remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:something-else',
    contextUri: 'spotify:playlist:other',
  })
  await second.engine.restore(saved)
  await settle()
  const state = second.engine.getState()
  assert.equal(state.current, null)
  assert.equal(state.snapshot?.trackUri, 'spotify:track:something-else')
  assert.equal(state.queue.length, 1)
  assert.equal(state.source?.label, 'Tracks')
  assert.deepEqual(second.sent('play'), [])
  // The queue is still there to carry on with.
  second.engine.next()
  await settle()
  assert.equal(second.engine.getState().current?.uri, track.uri)
  second.engine.dispose()
})

test('a page reloaded while it was playing is shown paused and starts again on Play', async () => {
  const first = harness(undefined, undefined, { browserId: 'the-tab' })
  await playLocally(first, track, {
    context: '',
    track: track.uri,
    position: 30_000,
  })
  first.engine.enqueue(album)
  const saved = transferred(first.engine.saved())
  assert.deepEqual(saved.target, {
    kind: 'spotify',
    device: {
      id: 'browser',
      name: 'Fixture player',
      type: 'computer',
      volume: 0.8,
    },
    browser: 'the-tab',
  })
  const position = saved.snapshot?.positionMs ?? 0
  assert.ok(position >= 30_000)
  first.engine.dispose()

  // The reloaded page is the same client with a new browser player.
  const second = harness(undefined, undefined, { browserId: 'the-tab' })
  second.engine.prepare()
  await settle()
  await advance(2_000)
  await second.engine.restore(saved)
  await settle()
  second.emit('ready', { device_id: 'browser-reloaded' })
  await advance(5_000)
  // Nothing starts by itself, however soon the page is back.
  assert.deepEqual(second.sent('play'), [])
  assert.equal(second.engine.getState().target.kind, 'local')
  assert.equal(second.engine.getState().current?.uri, track.uri)
  assert.equal(second.engine.getState().snapshot?.paused, true)
  assert.equal(second.engine.getState().queue.length, 1)
  second.engine.toggle()
  await settle()
  assert.deepEqual(second.sent('play'), [
    `play browser-reloaded {"uris":["spotify:track:single"],"position_ms":${Math.round(position)}}`,
  ])
  second.engine.dispose()
})

test('a session whose browser has gone is shown paused and starts again on Play', async () => {
  const first = harness(undefined, undefined, { browserId: 'old-tab' })
  await playLocally(first, track, {
    context: '',
    track: track.uri,
    position: 30_000,
  })
  const saved = transferred(first.engine.saved())
  const position = saved.snapshot?.positionMs ?? 0
  first.engine.dispose()

  // Another client: the browser that played is gone, so nothing starts by itself.
  const second = harness(undefined, undefined, { browserId: 'new-tab' })
  second.engine.prepare()
  await settle()
  second.emit('ready', { device_id: 'browser-new' })
  await second.engine.restore(saved)
  await settle()
  let state = second.engine.getState()
  assert.deepEqual(second.sent('play'), [])
  assert.equal(state.target.kind, 'local')
  assert.equal(state.current?.uri, track.uri)
  assert.equal(state.snapshot?.paused, true)
  assert.equal(state.snapshot?.positionMs, position)
  assert.equal(state.starting, false)
  // The paused item is still the session, so it is saved the same again.
  assert.equal(second.engine.saved()?.snapshot?.positionMs, position)

  second.engine.seek(60_000)
  assert.equal(second.engine.getState().snapshot?.positionMs, 60_000)
  second.engine.toggle()
  await settle()
  assert.deepEqual(second.sent('play'), [
    'play browser-new {"uris":["spotify:track:single"],"position_ms":60000}',
  ])
  state = second.engine.getState()
  assert.equal(state.current?.uri, track.uri)
  second.engine.dispose()
})

test('a device that has gone leaves the restored session to start in this browser', async () => {
  const first = harness()
  await playSource(first, savedFixtureSource(10))
  first.remote.snapshot = playing(0, 40_000)
  await advance(700)
  const saved = transferred(first.engine.saved())
  first.engine.dispose()

  const second = harness(undefined, undefined, { restoreSource })
  second.remote.devices = []
  await second.engine.restore(saved)
  await settle()
  const state = second.engine.getState()
  assert.equal(state.target.kind, 'local')
  assert.equal(state.current?.uri, sourceTrack(0).uri)
  assert.equal(state.snapshot?.paused, true)
  assert.deepEqual(second.sent('play'), [])
  second.engine.dispose()
})

test("a Sonos room's session is carried on by another page without restarting the room", async () => {
  const sonos = fakeSonos()
  const first = await sourceOnRoom(sonos)
  const saved = transferred(first.engine.saved())
  assert.deepEqual(saved.target, { kind: 'room', room: kitchen })
  assert.equal(saved.source, null)
  first.engine.dispose()
  const loaded = sonos.loads.length

  // The room moved on to the third track while no page was open.
  sonos.room.state = roomState(sourceTrack(2).uri, {
    positionMs: 9_000,
    hasNext: true,
  })
  const second = harness(undefined, sonos.api, { browserId: 'page-two' })
  await second.engine.restore(saved)
  await settle()
  const state = second.engine.getState()
  assert.deepEqual(state.target, { kind: 'room', room: kitchen })
  assert.equal(state.current?.uri, sourceTrack(2).uri)
  assert.equal(state.snapshot?.trackUri, sourceTrack(2).uri)
  assert.equal(state.volume, 0.2)
  await advance(3_000)
  assert.equal(
    sonos.loads.slice(loaded).filter((load) => load.includes(' replace '))
      .length,
    0,
  )
  assert.deepEqual(sonos.commands, [])
  second.engine.dispose()
})

test('a released session leaves the device playing and drops the queue here', async () => {
  const setup = harness()
  await playSource(setup, savedFixtureSource(10))
  setup.remote.snapshot = playing(0, 1_000)
  await advance(700)
  setup.engine.enqueue(track)
  const calls = setup.calls.filter((call) => call !== 'state').length
  setup.engine.release()
  const state = setup.engine.getState()
  assert.equal(state.current, null)
  assert.deepEqual(state.queue, [])
  assert.equal(state.source, null)
  assert.deepEqual(state.upcoming, [])
  assert.equal(state.snapshot?.trackUri, sourceTrack(0).uri)
  assert.equal(setup.engine.saved(), null)
  // The device is still followed, as playback another client runs.
  setup.remote.snapshot = playing(1, 500)
  await advance(3_000)
  assert.equal(setup.engine.getState().snapshot?.trackUri, sourceTrack(1).uri)
  assert.equal(setup.engine.getState().current, null)
  assert.equal(setup.calls.filter((call) => call !== 'state').length, calls)
  setup.engine.dispose()
})

/** Runs the server's lease rules against a disposable session and a fake clock. */
function fakeSessions() {
  let record = structuredClone(EMPTY_PLAYBACK_SESSION)
  const down = { is: false }
  const api: SessionApi = {
    async sync(input) {
      if (down.is) throw new Error('unreachable')
      const next = syncPlaybackSession(record, structuredClone(input), clock)
      record = next.stored
      return structuredClone(next.result)
    },
    release(input) {
      record = releasePlaybackSession(
        record,
        structuredClone(input),
        clock,
      ).stored
    },
  }
  return {
    api,
    get record() {
      return record
    },
    down,
  }
}

/** One open page of the account: its engine with the shared session around it. */
function page(
  name: string,
  sessions: ReturnType<typeof fakeSessions>,
  world?: SpotifyWorld,
  sonos?: SonosControlApi,
  scrobbles?: PlaybackEngineOptions['scrobbles'],
  readSonosRooms?: () => Promise<SonosRooms>,
) {
  const setup = harness(
    undefined,
    sonos,
    { browserId: `client-${name}`, restoreSource, scrobbles },
    world,
  )
  const sync = createPlaybackSync({
    engine: setup.engine,
    api: sessions.api,
    readSonosRooms,
    clientId: `client-${name}`,
    clientName: name,
    now: () => clock,
    visible: () => setup.page.visible,
  })
  return {
    ...setup,
    sync,
    close() {
      sync.dispose()
      setup.engine.dispose()
    },
  }
}

test('two pages share external Sonos playback and only the master reads the room', async () => {
  const sessions = fakeSessions()
  const firstRoom = fakeSonos()
  firstRoom.room.state = roomState(track.uri)
  const secondRoom = fakeSonos()
  secondRoom.room.state = roomState(track.uri)
  const one = page('first', sessions, undefined, firstRoom.api)
  const two = page('second', sessions, undefined, secondRoom.api)
  one.engine.watch()
  one.sync.start()
  await settle()
  await one.sync.selectDevice({ kind: 'room', room: kitchen })
  await advance(1_000)
  two.engine.watch()
  two.sync.start()
  await advance(36_000)
  assert.equal(sessions.record.state, null)
  assert.equal(two.sync.getState().sharing.role, 'follower')
  assert.deepEqual(two.sync.getState().target, { kind: 'room', room: kitchen })
  assert.equal(two.sync.getState().snapshot?.trackUri, track.uri)
  assert.equal(two.sync.getState().volume, one.sync.getState().volume)
  assert.ok(firstRoom.reads.length >= 3)
  assert.equal(secondRoom.reads.length, 0)
  // A hidden master driving no queue yields the external room to the visible page.
  one.page.visible = false
  await advance(22_000)
  assert.equal(two.sync.getState().sharing.role, 'driver')
  assert.equal(two.sync.getState().target.kind, 'room')
  assert.ok(secondRoom.reads.length > 0)
  one.sync.close()
  one.close()
  sessions.down.is = true
  two.sync.refresh()
  await settle()
  const afterFailure = secondRoom.reads.length
  await advance(35_000)
  assert.equal(secondRoom.reads.length, afterFailure)
  two.close()
})

test('a stalled heartbeat stops room reads when the confirmed lease expires', async () => {
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  sonos.room.state = roomState(track.uri)
  const one = page('first', sessions, undefined, sonos.api)
  one.engine.watch()
  one.sync.start()
  await settle()
  await one.sync.selectDevice({ kind: 'room', room: kitchen })
  await advance(1_000)
  const reads = sonos.reads.length
  assert.ok(reads > 0)
  const send = sessions.api.sync
  let finish = () => {}
  sessions.api.sync = async (input) => {
    const result = await send(input)
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return result
  }
  one.sync.refresh()
  await advance(30_000)
  assert.equal(sonos.reads.length, reads)
  one.sync.close()
  finish()
  await advance(30_000)
  assert.equal(sonos.reads.length, reads)
  one.close()
})

test('room menus on two pages share a master read and can retry a failed refresh', async () => {
  const sessions = fakeSessions()
  let masterReads = 0
  let followerReads = 0
  let failRead = false
  const result: SonosRooms = {
    households: [{ id: 'household', name: 'Fixture', rooms: [] }],
  }
  const first = page(
    'first',
    sessions,
    undefined,
    undefined,
    undefined,
    async () => {
      masterReads += 1
      if (failRead) throw new Error('unavailable')
      return result
    },
  )
  const second = page(
    'second',
    sessions,
    undefined,
    undefined,
    undefined,
    async () => {
      followerReads += 1
      return result
    },
  )
  first.sync.start()
  await settle()
  second.sync.start()
  await settle()
  const both = Promise.all([
    first.sync.loadSonosRooms(),
    second.sync.loadSonosRooms(),
  ])
  await advance(2_000)
  assert.deepEqual(await both, [result, result])
  assert.equal(masterReads, 1)
  failRead = true
  const failure = assert.rejects(
    second.sync.loadSonosRooms(),
    /could not be read/,
  )
  await advance(10_000)
  await failure
  failRead = false
  const retry = second.sync.loadSonosRooms()
  await advance(10_000)
  assert.deepEqual(await retry, result)
  assert.equal(masterReads, 3)
  assert.equal(followerReads, 0)
  second.page.visible = false
  await advance(12_000)
  const fromMaster = first.sync.loadSonosRooms()
  await advance(1_000)
  await fromMaster
  await advance(20_000)
  second.page.visible = true
  const afterSleep = second.sync.loadSonosRooms()
  await advance(10_000)
  assert.deepEqual(await afterSleep, result)
  assert.equal(masterReads, 5)
  assert.equal(followerReads, 0)
  first.close()
  second.close()
})

/** Plays a saved source on the speaker from a page and lets it save. */
async function driveSource(one: ReturnType<typeof page>, length = 40) {
  one.sync.start()
  await settle()
  await one.engine.selectDevice({ kind: 'remote', device: speaker })
  one.sync.play(sourceTrack(0), savedFixtureSource(length))
  await settle()
  one.remote.device = { ...speaker, active: true }
  one.remote.snapshot = playing(0, 1_000)
  await advance(1_000)
}

test('the first page drives the session and a second page shows its queue', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  one.sync.enqueue(track)
  await advance(1_000)
  assert.equal(one.sync.getState().sharing.role, 'driver')
  assert.equal(sessions.record.driver?.name, 'Chrome on Mac')
  assert.equal(sessions.record.state?.current?.uri, sourceTrack(0).uri)

  const two = page('Safari on iPhone', sessions, one.remote)
  two.engine.watch()
  two.sync.start()
  await advance(500)
  const shown = two.sync.getState()
  assert.deepEqual(shown.sharing, {
    role: 'follower',
    driverName: 'Chrome on Mac',
  })
  assert.equal(shown.current?.uri, sourceTrack(0).uri)
  assert.deepEqual(
    shown.queue.map((entry) => entry.item.uri),
    [track.uri],
  )
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(1).uri)
  assert.equal(shown.source?.label, 'Tracks')
  assert.equal(shown.snapshot?.trackUri, sourceTrack(0).uri)
  // The follower has no queue of its own and has sent the device nothing.
  assert.deepEqual(two.engine.getState().queue, [])
  assert.deepEqual(two.sent('play'), [])

  // A change on the driver reaches the follower with its next exchange.
  one.sync.enqueue(album)
  await advance(4_000)
  assert.equal(two.sync.getState().queue.length, 2)

  // Pause goes straight to the device and does not take the session over.
  two.sync.toggle()
  await settle()
  assert.deepEqual(two.sent('pause'), ['pause speaker'])
  assert.equal(two.sync.getState().sharing.role, 'follower')
  one.close()
  two.close()
})

test('a queue change on a follower moves the session to that page', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  const two = page('Safari on iPhone', sessions, one.remote)
  two.engine.watch()
  two.sync.start()
  await advance(500)
  assert.equal(two.sync.getState().sharing.role, 'follower')
  const played = one.sent('play').length

  two.sync.enqueue(track)
  await advance(500)
  const taken = two.sync.getState()
  assert.equal(taken.sharing.role, 'driver')
  assert.equal(taken.current?.uri, sourceTrack(0).uri)
  assert.deepEqual(
    taken.queue.map((entry) => entry.item.uri),
    [track.uri],
  )
  assert.equal(taken.upcoming[0]?.item.uri, sourceTrack(1).uri)
  assert.deepEqual(two.sent('play'), [])
  assert.deepEqual(two.sent('enqueue'), [
    'enqueue speaker spotify:track:single',
  ])
  assert.equal((await two.api.queue()).upcoming[0]?.uri, track.uri)

  // The first page finds out with its next exchange and shows the same queue.
  await advance(4_000)
  const left = one.sync.getState()
  assert.deepEqual(left.sharing, {
    role: 'follower',
    driverName: 'Safari on iPhone',
  })
  assert.deepEqual(
    left.queue.map((entry) => entry.item.uri),
    [track.uri],
  )
  assert.deepEqual(one.engine.getState().queue, [])
  assert.equal(one.sent('play').length, played)

  // The new driver runs the queue: the queued track is due after this one.
  two.remote.snapshot = playing(0, 198_000)
  await advance(3_000)
  two.remote.snapshot = remoteSnapshot({
    trackUri: track.uri,
    contextUri: null,
    positionMs: 500,
  })
  await advance(3_000)
  assert.equal(two.sync.getState().current?.uri, track.uri)
  assert.equal(one.sent('play').length, played)
  assert.deepEqual(two.sent('play'), [])
  one.close()
  two.close()
})

test('the upcoming tracks rearranged on one page are the same on the other', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  const two = page('Safari on iPhone', sessions, one.remote)
  two.engine.watch()
  two.sync.start()
  await advance(500)
  const shown = two.sync.getState().upcoming
  assert.deepEqual(
    shown.slice(0, 3).map((entry) => entry.key),
    one.sync
      .getState()
      .upcoming.slice(0, 3)
      .map((entry) => entry.key),
  )

  // A change made on the follower takes the session over and is made there.
  two.sync.queueUpcoming(shown[1]?.key ?? '')
  await advance(500)
  two.sync.moveUpcoming(0, 1)
  two.sync.removeUpcoming(shown[4]?.key ?? '')
  await advance(500)
  const taken = two.sync.getState()
  assert.equal(taken.sharing.role, 'driver')
  assert.deepEqual(
    taken.queue.map((entry) => entry.item.uri),
    [sourceTrack(2).uri],
  )
  assert.deepEqual(upcomingNumbers(taken), [3, 1, 4, 6, 7])
  assert.deepEqual(two.sent('play'), [])
  assert.deepEqual(two.sent('enqueue'), [])
  assert.deepEqual(
    (await two.api.queue()).upcoming.slice(0, 5).map((item) => item.uri),
    [1, 2, 3, 4, 5].map((index) => sourceTrack(index).uri),
  )

  await advance(4_000)
  const left = one.sync.getState()
  assert.equal(left.sharing.role, 'follower')
  assert.deepEqual(
    left.queue.map((entry) => entry.item.uri),
    [sourceTrack(2).uri],
  )
  assert.deepEqual(upcomingNumbers(left), [3, 1, 4, 6, 7])

  // A page that takes the session back keeps the order and what was removed.
  one.sync.playUpcoming(left.upcoming[1]?.key ?? '')
  await advance(500)
  const back = one.sync.getState()
  assert.equal(back.sharing.role, 'driver')
  assert.equal(back.current?.uri, sourceTrack(1).uri)
  assert.deepEqual(upcomingNumbers(back), [4, 6, 7, 8, 9])
  assert.deepEqual(
    back.queue.map((entry) => entry.item.uri),
    [sourceTrack(2).uri],
  )
  one.close()
  two.close()
})

test('a follower takes the session over when the driver goes away', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  const two = page('Safari on iPhone', sessions, one.remote)
  two.engine.watch()
  two.sync.start()
  await advance(500)
  assert.equal(two.sync.getState().sharing.role, 'follower')

  // The driver's computer sleeps: it stops renewing its lease without a word.
  one.close()
  two.remote.snapshot = playing(1, 2_000)
  await advance(PLAYBACK_LEASE_MS + 4_000)
  const state = two.sync.getState()
  assert.equal(state.sharing.role, 'driver')
  assert.equal(sessions.record.driver?.name, 'Safari on iPhone')
  assert.equal(state.current?.uri, sourceTrack(1).uri)
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(2).uri)
  assert.deepEqual(two.sent('play'), [])
  // What it took over is saved under its own name.
  await advance(1_000)
  assert.equal(sessions.record.state?.current?.uri, sourceTrack(1).uri)
  two.close()
})

test('a hidden follower does not take over or keep asking', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  const two = page('Safari on iPhone', sessions, one.remote)
  two.sync.start()
  await advance(500)
  two.page.visible = false
  one.close()
  await advance(PLAYBACK_LEASE_MS + 10_000)
  assert.equal(two.sync.getState().sharing.role, 'follower')
  // Shown again, it asks at once and carries the session on.
  two.page.visible = true
  two.sync.refresh()
  await advance(500)
  assert.equal(two.sync.getState().sharing.role, 'driver')
  two.close()
})

test('a closed page gives the session up and its reload carries it on', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  one.sync.enqueue(track)
  one.sync.close()
  one.close()
  assert.equal(sessions.record.driver, null)
  assert.equal(sessions.record.state?.queue.length, 1)

  const again = page('Chrome on Mac', sessions, one.remote)
  again.remote.snapshot = playing(0, 20_000)
  again.sync.start()
  await advance(500)
  const state = again.sync.getState()
  assert.equal(state.sharing.role, 'driver')
  assert.equal(state.current?.uri, sourceTrack(0).uri)
  assert.equal(state.queue.length, 1)
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(1).uri)
  assert.deepEqual(again.sent('play'), [])
  again.close()
})

test('playback works alone while the session cannot be reached', async () => {
  const sessions = fakeSessions()
  sessions.down.is = true
  const one = page('Chrome on Mac', sessions)
  one.sync.start()
  await settle()
  await one.engine.selectDevice({ kind: 'remote', device: speaker })
  one.sync.play(track)
  await settle()
  assert.deepEqual(one.sent('play'), [
    'play speaker {"uris":["spotify:track:single"]}',
  ])
  assert.equal(one.sync.getState().sharing.role, 'driver')
  // Once it answers again, the session is saved.
  sessions.down.is = false
  await advance(4_000)
  assert.equal(sessions.record.state?.current?.uri, track.uri)
  one.close()
})

test('what was started while the session could not be reached replaces the older session', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  one.sync.close()
  one.close()
  assert.equal(sessions.record.state?.current?.uri, sourceTrack(0).uri)

  sessions.down.is = true
  const two = page('Safari on iPhone', sessions)
  two.sync.start()
  await settle()
  await two.engine.selectDevice({ kind: 'remote', device: speaker })
  two.sync.play(track)
  two.sync.enqueue(sourceTrack(5))
  await settle()
  two.remote.device = { ...speaker, active: true }
  two.remote.snapshot = remoteSnapshot({
    trackUri: track.uri,
    contextUri: null,
    positionMs: 1_000,
  })
  await advance(1_000)

  sessions.down.is = false
  await advance(8_000)
  const shown = two.sync.getState()
  assert.equal(shown.current?.uri, track.uri)
  assert.deepEqual(
    shown.queue.map((entry) => entry.item.uri),
    [sourceTrack(5).uri],
  )
  assert.equal(shown.source, null)
  assert.equal(sessions.record.state?.current?.uri, track.uri)
  assert.deepEqual(
    sessions.record.state?.queue.map((entry) => entry.item.uri),
    [sourceTrack(5).uri],
  )
  assert.equal(sessions.record.state?.source, null)
  two.close()
})

test('a reloaded driver takes the session back from the lease it left behind', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  // The page goes without giving its lease up, and loads again at once.
  one.close()
  const again = harness(
    undefined,
    undefined,
    { browserId: 'client-Chrome on Mac', restoreSource },
    one.remote,
  )
  const sync = createPlaybackSync({
    engine: again.engine,
    api: sessions.api,
    clientId: 'client-reloaded',
    clientName: 'Chrome on Mac',
    now: () => clock,
    resuming: true,
  })
  sync.start()
  await advance(500)
  assert.equal(sessions.record.driver?.clientId, 'client-reloaded')
  assert.equal(sync.getState().sharing.role, 'driver')
  assert.equal(sync.getState().current?.uri, sourceTrack(0).uri)
  assert.deepEqual(again.sent('play'), [])
  sync.dispose()
  again.engine.dispose()
})

test('a second load of the same tab does not run the queue beside the first', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  // A duplicated tab has the first tab's storage, so the same browser ID.
  const copy = harness(
    undefined,
    undefined,
    { browserId: 'client-Chrome on Mac', restoreSource },
    one.remote,
  )
  const sync = createPlaybackSync({
    engine: copy.engine,
    api: sessions.api,
    clientId: 'client-copy',
    clientName: 'Chrome on Mac',
    now: () => clock,
  })
  copy.engine.watch()
  sync.start()
  await advance(4_000)
  assert.equal(sync.getState().sharing.role, 'follower')
  assert.equal(one.sync.getState().sharing.role, 'driver')
  assert.equal(copy.engine.saved(), null)
  sync.dispose()
  copy.engine.dispose()
  one.close()
})

test('the server is asked less often while nothing plays, and a hidden page asks only to run a playing queue', async () => {
  const sessions = fakeSessions()
  let asked = 0
  const api: SessionApi = {
    sync(input) {
      asked += 1
      return sessions.api.sync(input)
    },
    release: sessions.api.release,
  }
  const setup = harness(undefined, undefined, {
    browserId: 'the-tab',
    restoreSource,
  })
  const sync = createPlaybackSync({
    engine: setup.engine,
    api,
    clientId: 'client-pace',
    clientName: 'Chrome on Mac',
    now: () => clock,
    visible: () => setup.page.visible,
  })
  sync.start()
  await settle()
  asked = 0
  await advance(24_000)
  assert.equal(asked, 3)

  await setup.engine.selectDevice({ kind: 'remote', device: speaker })
  sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  setup.remote.device = { ...speaker, active: true }
  setup.remote.snapshot = playing(0, 1_000)
  await advance(1_000)
  asked = 0
  await advance(12_000)
  assert.ok(asked >= 4, `asked ${asked} times while playing`)

  // Hidden, the page still runs the playing queue and keeps its lease.
  setup.page.visible = false
  asked = 0
  await advance(12_000)
  assert.ok(asked >= 4, `asked ${asked} times while hidden and playing`)
  assert.equal(sessions.record.driver?.clientId, 'client-pace')

  setup.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(0).uri,
    contextUri: null,
    positionMs: 30_000,
    paused: true,
  })
  await advance(8_000)
  assert.equal(sessions.record.state?.snapshot?.paused, true)
  asked = 0
  await advance(60_000)
  assert.equal(asked, 0)

  // Shown again, it asks at once.
  setup.page.visible = true
  sync.refresh()
  await settle()
  assert.equal(asked, 1)
  assert.equal(sync.getState().sharing.role, 'driver')
  sync.dispose()
  setup.engine.dispose()
})

test('a session on a Sonos room is shown and taken over on another page', async () => {
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  const one = page('Chrome on Mac', sessions, undefined, sonos.api)
  one.sync.start()
  await settle()
  await one.sync.selectDevice({ kind: 'room', room: kitchen })
  one.sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  sonos.room.state = roomState(sourceTrack(0).uri, {
    positionMs: 2_000,
    hasNext: true,
  })
  await advance(4_000)
  assert.equal(sessions.record.state?.target.kind, 'room')
  const loaded = sonos.loads.length

  const two = page('Safari on iPhone', sessions, undefined, sonos.api)
  two.engine.watch()
  two.sync.start()
  await advance(1_000)
  let shown = two.sync.getState()
  assert.equal(shown.sharing.role, 'follower')
  assert.deepEqual(shown.target, { kind: 'room', room: kitchen })
  assert.equal(shown.snapshot?.trackUri, sourceTrack(0).uri)
  assert.equal(shown.current?.uri, sourceTrack(0).uri)

  two.sync.next()
  await advance(1_000)
  shown = two.sync.getState()
  assert.equal(shown.sharing.role, 'driver')
  assert.equal(shown.current?.uri, sourceTrack(1).uri)
  // The room skipped in its own queue; nothing was started again.
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 next'])
  assert.equal(
    sonos.loads.slice(loaded).filter((load) => load.includes(' replace '))
      .length,
    0,
  )
  one.close()
  two.close()
})

/**
 * Plays a saved source on the Sonos room from one page, lets the room take
 * the tracks that follow, then closes the page: no page is left open.
 */
async function roomSessionLeftPlaying(
  sessions: ReturnType<typeof fakeSessions>,
  sonos: ReturnType<typeof fakeSonos>,
) {
  const one = page('Chrome on Mac', sessions, undefined, sonos.api)
  one.sync.start()
  await settle()
  await one.sync.selectDevice({ kind: 'room', room: kitchen })
  one.sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  sonos.room.state = roomState(sourceTrack(0).uri, {
    positionMs: 60_000,
    hasNext: true,
  })
  await advance(15_000)
  one.sync.close()
  one.close()
  return { loaded: sonos.loads.length }
}

/** The app opened again later on any computer or phone. */
async function reopen(
  sessions: ReturnType<typeof fakeSessions>,
  sonos?: ReturnType<typeof fakeSonos>,
  world?: SpotifyWorld,
) {
  const again = page('Safari on iPhone', sessions, world, sonos?.api)
  again.engine.watch()
  again.sync.start()
  await advance(1_000)
  return again
}

test('a Sonos room that played on with every page closed is rejoined where it is', async () => {
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  const { loaded } = await roomSessionLeftPlaying(sessions, sonos)
  assert.equal(sessions.record.driver, null)
  assert.equal(sessions.record.state?.session?.sent.length, 11)

  // Half an hour later the room is three tracks further along its queue.
  clock += 30 * 60_000
  sonos.room.state = roomState(sourceTrack(3).uri, {
    positionMs: 50_000,
    hasNext: true,
  })
  const reads = sonos.reads.length
  const again = await reopen(sessions, sonos)
  assert.equal(sonos.readReasons[reads], 'room-rejoin')
  let shown = again.sync.getState()
  assert.equal(shown.sharing.role, 'driver')
  assert.deepEqual(shown.target, { kind: 'room', room: kitchen })
  assert.equal(shown.current?.uri, sourceTrack(3).uri)
  assert.equal(shown.snapshot?.trackUri, sourceTrack(3).uri)
  assert.equal(shown.snapshot?.paused, false)
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(4).uri)
  assert.deepEqual(shown.rejoin, {
    status: 'rejoined',
    device: 'Fixture kitchen',
  })
  // Nothing on the room was started or loaded again.
  assert.deepEqual(sonos.commands, [])
  assert.equal(
    sonos.loads.slice(loaded).filter((load) => !load.includes(' append '))
      .length,
    0,
  )

  // The controls work on the room's own queue.
  again.sync.next()
  await settle()
  assert.deepEqual(sonos.commands, ['RINCON_FIXTURE:1 next'])
  shown = again.sync.getState()
  assert.equal(shown.current?.uri, sourceTrack(4).uri)
  assert.equal(shown.rejoin, null)
  sonos.room.state = roomState(sourceTrack(4).uri, { hasNext: true })
  await advance(3_000)
  again.sync.toggle()
  await settle()
  assert.deepEqual(sonos.commands.at(-1), 'RINCON_FIXTURE:1 pause')
  again.close()
})

test('a Sonos room that was given other music is not rejoined and is left alone', async () => {
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  const { loaded } = await roomSessionLeftPlaying(sessions, sonos)
  clock += 30 * 60_000
  // A playlist was started on the room from the Sonos app.
  sonos.room.state = roomState('spotify:track:from-the-sonos-app', {
    positionMs: 70_000,
    hasNext: true,
    containerUri: 'spotify:playlist:sonos-app',
  })
  const again = await reopen(sessions, sonos)
  const shown = again.sync.getState()
  assert.deepEqual(shown.target, { kind: 'local' })
  assert.equal(shown.current, null)
  assert.equal(shown.snapshot, null)
  assert.equal(shown.source?.label, 'Tracks')
  assert.deepEqual(shown.rejoin, {
    status: 'changed',
    device: 'Fixture kitchen',
  })
  await advance(30_000)
  assert.deepEqual(sonos.commands, [])
  assert.equal(sonos.loads.length, loaded)
  again.close()
})

test('a Sonos room whose queue was replaced or went back is not rejoined', async () => {
  for (const changed of [
    // Another track, loaded without a playlist.
    roomState('spotify:track:something-else', { positionMs: 1_000 }),
    // An earlier track of the queue, playing.
    roomState(sourceTrack(0).uri, { positionMs: 1_000, hasNext: true }),
    // The saved track again, from near its start: the queue was replaced.
    roomState(sourceTrack(0).uri, { positionMs: 0, state: 'playing' }),
  ]) {
    const sessions = fakeSessions()
    const sonos = fakeSonos()
    const { loaded } = await roomSessionLeftPlaying(sessions, sonos)
    clock += 10 * 60_000
    if (changed.track?.uri === sourceTrack(0).uri && changed.positionMs > 0)
      sessions.record.state = sessions.record.state && {
        ...sessions.record.state,
        session: sessions.record.state.session && {
          ...sessions.record.state.session,
          index: 2,
          item: sourceTrack(2),
          anchorUri: sourceTrack(2).uri,
        },
      }
    sonos.room.state = changed
    const again = await reopen(sessions, sonos)
    const shown = again.sync.getState()
    assert.equal(shown.rejoin?.status, 'changed', JSON.stringify(changed))
    assert.deepEqual(shown.target, { kind: 'local' })
    assert.deepEqual(sonos.commands, [])
    assert.equal(sonos.loads.length, loaded)
    again.close()
  }
})

test('a Sonos room whose queue has ended is shown idle with the session to start again', async () => {
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  const { loaded } = await roomSessionLeftPlaying(sessions, sonos)
  clock += 3 * 60 * 60_000
  sonos.room.state = roomState(sourceTrack(0).uri, { state: 'idle' })
  const again = await reopen(sessions, sonos)
  const shown = again.sync.getState()
  assert.deepEqual(shown.rejoin, { status: 'ended', device: 'Fixture kitchen' })
  assert.equal(shown.snapshot?.paused, true)
  await advance(30_000)
  assert.deepEqual(sonos.commands, [])
  assert.equal(sonos.loads.length, loaded)
  again.close()
})

test("a restored room's queue is not added to before the room has been read", async () => {
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  const { loaded } = await roomSessionLeftPlaying(sessions, sonos)
  // The room holds fewer tracks ahead than it is normally given.
  const record = sessions.record.state
  assert.ok(record?.session)
  sessions.record.state = {
    ...record,
    session: { ...record.session, sent: record.session.sent.slice(0, 2) },
  }
  sonos.room.state = roomState('spotify:track:something-else', {
    positionMs: 1_000,
  })
  const gate: { open: () => void } = { open: () => undefined }
  const held: SonosControlApi = {
    ...sonos.api,
    async state(groupId, volume) {
      await new Promise<void>((resolve) => {
        gate.open = () => resolve()
      })
      return sonos.api.state(groupId, volume)
    },
  }
  const again = page('Safari on iPhone', sessions, undefined, held)
  again.sync.start()
  await advance(1_000)
  assert.deepEqual(again.sync.getState().rejoin, {
    status: 'checking',
    device: 'Fixture kitchen',
  })
  assert.equal(sonos.loads.length, loaded)
  gate.open()
  await advance(1_000)
  assert.equal(again.sync.getState().rejoin?.status, 'changed')
  assert.equal(sonos.loads.length, loaded)
  again.close()
})

test('a Spotify device that played on with every page closed is rejoined where it is', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  await advance(5_000)
  one.sync.close()
  one.close()
  const played = one.sent('play').length

  clock += 20 * 60_000
  one.remote.snapshot = playing(5, 30_000)
  const again = await reopen(sessions, undefined, one.remote)
  const shown = again.sync.getState()
  assert.equal(shown.current?.uri, sourceTrack(5).uri)
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(6).uri)
  assert.deepEqual(shown.target, { kind: 'remote', device: speaker })
  assert.deepEqual(shown.rejoin, {
    status: 'rejoined',
    device: 'Fixture speaker',
  })
  assert.deepEqual(again.sent('play'), [])
  assert.equal(one.sent('play').length, played)
  again.close()
})

test('reopening can queue another track after an already accepted Spotify addition', async () => {
  const one = harness()
  await playSource(one, savedFixtureSource(4))
  one.remote.snapshot = playing(0, 5_000)
  await advance(700)
  one.engine.enqueue(track)
  await advance(700)
  const saved = transferred(one.engine.saved())
  assert.equal(saved.session?.queuedThrough, 1)
  one.engine.dispose()

  const again = harness(undefined, undefined, { restoreSource }, one.remote)
  await again.engine.restore(saved)
  again.engine.enqueue(sourceTrack(12))
  await advance(700)
  assert.deepEqual(again.sent('enqueue'), [
    'enqueue speaker spotify:track:source-12',
  ])
  assert.deepEqual(again.sent('play'), [])
  assert.deepEqual(
    (await again.api.queue()).upcoming.map((item) => item.uri),
    [
      track.uri,
      sourceTrack(12).uri,
      ...[1, 2, 3].map((i) => sourceTrack(i).uri),
    ],
  )
  again.engine.dispose()
})

test('reopening follows a track from an in-flight Spotify queue append', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  const enqueue = one.api.enqueue
  let accept: () => void = () => undefined
  const accepted = new Promise<void>((resolve) => {
    accept = resolve
  })
  one.api.enqueue = async (device, uri) => {
    await enqueue(device, uri)
    await accepted
  }
  one.sync.enqueue(track)
  await advance(5_000)
  assert.deepEqual(one.sent('enqueue'), [
    'enqueue speaker spotify:track:single',
  ])
  assert.equal((await one.api.queue()).upcoming[0]?.uri, track.uri)
  assert.equal(one.sent('play').length, 1)
  one.sync.close()
  one.close()
  accept()
  const saved = transferred(sessions.record.state)
  assert.equal(
    saved.session?.sent.some((item) => item.uri === track.uri),
    false,
  )
  assert.equal(
    saved.session?.pendingSent?.some((item) => item.uri === track.uri),
    true,
  )
  sessions.record.state = saved

  clock += 20 * 60_000
  const { remote } = one
  remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:fixture-relinked',
    linkedFromUri: track.uri,
    trackName: 'Fixture relinked recording',
    contextUri: null,
    positionMs: 30_000,
  })
  const again = await reopen(sessions, undefined, remote)
  const shown = again.sync.getState()
  assert.equal(shown.rejoin?.status, 'rejoined')
  assert.equal(shown.current?.uri, track.uri)
  assert.deepEqual(shown.queue, [])
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(1).uri)
  assert.deepEqual(again.sent('play'), [])
  assert.deepEqual(again.sent('enqueue'), [])
  again.close()
})

test('reopening preserves tracks that only one possible Spotify list passed', async () => {
  const sessions = fakeSessions()
  const { remote } = await closedOn(sessions)
  const saved = sessions.record.state
  assert.ok(saved?.session && saved.source)
  const [one, two, ...upcoming] = saved.source.upcoming
  const [current, first, second, ...following] = saved.session.sent
  assert.ok(one && two && current && first && second)
  sessions.record.state = transferred({
    ...saved,
    source: { ...saved.source, upcoming: [two, one, ...upcoming] },
    session: {
      ...saved.session,
      pendingSent: [current, second, first, ...following],
    },
  })

  clock += 20 * 60_000
  remote.snapshot = { ...playing(2, 30_000), paused: true }
  const again = await reopen(sessions, undefined, remote)
  const shown = again.sync.getState()
  assert.equal(shown.rejoin?.status, 'rejoined')
  assert.equal(shown.current?.uri, sourceTrack(2).uri)
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(1).uri)
  assert.equal(again.engine.saved()?.session?.sent[1]?.uri, sourceTrack(1).uri)
  assert.deepEqual(again.sent('play'), [])
  again.close()
})

test('reopening leaves playback outside a pending Spotify list alone', async () => {
  const sessions = fakeSessions()
  const { remote } = await closedOn(sessions)
  const saved = sessions.record.state
  assert.ok(saved?.session)
  const edited = {
    ...saved,
    session: { ...saved.session, pendingSent: [saved.session.item, track] },
  }

  // A title alone cannot confirm the list, and neither can a Spotify playlist.
  for (const snapshot of [
    {
      trackUri: 'spotify:track:unrelated',
      trackName: track.title,
      contextUri: null,
    },
    { trackUri: track.uri, contextUri: 'spotify:playlist:unrelated' },
  ]) {
    remote.snapshot = remoteSnapshot({ ...snapshot, positionMs: 30_000 })
    const again = harness(undefined, undefined, { restoreSource }, remote)
    await again.engine.restore(edited)
    const shown = again.engine.getState()
    assert.equal(shown.rejoin?.status, 'changed')
    assert.equal(shown.current, null)
    assert.equal(shown.snapshot?.trackUri, snapshot.trackUri)
    assert.deepEqual(again.sent('play'), [])
    again.engine.dispose()
  }
})

test('each successful queue rejoin notice lasts ten seconds', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  await advance(5_000)
  one.sync.close()
  one.close()
  const saved = sessions.record.state
  assert.ok(saved)

  const again = page('Safari on iPhone', sessions, one.remote)
  one.remote.snapshot = playing(5, 30_000)
  await again.engine.restore(saved)
  assert.equal(again.engine.getState().rejoin?.status, 'rejoined')
  await advance(5_000)

  one.remote.snapshot = playing(6, 30_000)
  await again.engine.restore(saved)
  await advance(9_900)
  assert.equal(again.engine.getState().rejoin?.status, 'rejoined')
  await advance(100)
  assert.equal(again.engine.getState().rejoin, null)
  assert.equal(again.engine.getState().current?.uri, sourceTrack(6).uri)
  again.close()
})

test('a Spotify device playing something else is shown but not rejoined', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  await advance(5_000)
  one.sync.close()
  one.close()
  clock += 20 * 60_000
  one.remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:from-the-app',
    contextUri: 'spotify:playlist:from-the-app',
  })
  const again = await reopen(sessions, undefined, one.remote)
  const shown = again.sync.getState()
  assert.equal(shown.current, null)
  assert.equal(shown.snapshot?.trackUri, 'spotify:track:from-the-app')
  assert.equal(shown.rejoin?.status, 'changed')
  assert.equal(shown.source?.label, 'Tracks')
  assert.deepEqual(again.sent('play'), [])
  again.close()
})

test('a Spotify list that ran out and went back to its start is not rejoined', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  one.remote.snapshot = playing(0, 90_000)
  await advance(12_000)
  one.sync.close()
  one.close()
  clock += 4 * 60 * 60_000
  one.remote.snapshot = remoteSnapshot({
    trackUri: sourceTrack(0).uri,
    contextUri: null,
    positionMs: 0,
    paused: true,
  })
  const again = await reopen(sessions, undefined, one.remote)
  const shown = again.sync.getState()
  assert.equal(shown.rejoin?.status, 'ended')
  assert.equal(shown.snapshot?.paused, true)
  assert.deepEqual(again.sent('play'), [])
  again.close()
})

test('a session taken over for a command here gives no note about rejoining', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  const two = page('Safari on iPhone', sessions, one.remote)
  two.engine.watch()
  two.sync.start()
  await advance(1_000)
  two.sync.enqueue(track)
  await advance(1_000)
  assert.equal(two.sync.getState().sharing.role, 'driver')
  assert.equal(two.sync.getState().rejoin, null)
  one.close()
  two.close()
})

/** The tracks of another album, played from its track list. */
const anotherAlbum: PlayableItem[] = [0, 1, 2].map((index) => ({
  ...track,
  uri: `spotify:track:another-${index}`,
  title: `Another ${index}`,
  albumId: 'album-another',
}))
function anotherAlbumSource(): PlaybackSource {
  return {
    label: 'Another album',
    href: '/albums/album-another',
    length: 1,
    startIndex: 0,
    kind: 'album',
    descriptor: { type: 'album', tracks: anotherAlbum },
    load: async (index) => (index === 0 ? [...anotherAlbum] : []),
  }
}
const anotherPlay =
  'play speaker {"uris":["spotify:track:another-0","spotify:track:another-1","spotify:track:another-2"]}'

test('Play on an album replaces what this browser is playing', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  one.sync.start()
  one.engine.prepare()
  await settle()
  one.sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  one.emit('ready', { device_id: 'browser' })
  await settle()
  one.local.state = sdkState({
    context: '',
    track: sourceTrack(0).uri,
    position: 1_000,
  })
  await advance(5_000)
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await advance(2_000)
  one.local.state = sdkState({
    context: '',
    track: 'spotify:track:another-0',
    position: 500,
  })
  await advance(10_000)
  const plays = one.sent('play')
  assert.equal(plays.length, 2)
  assert.match(
    plays[1] ?? '',
    /^play browser \{"uris":\["spotify:track:another-0"/,
  )
  assert.equal(one.sync.getState().current?.uri, 'spotify:track:another-0')
  one.close()
})

test('Play on a track replaces playback started on another device', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  one.remote.device = { ...speaker, active: true }
  one.remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:from-the-app',
    contextUri: 'spotify:playlist:from-the-app',
    positionMs: 60_000,
  })
  one.engine.watch()
  one.sync.start()
  await advance(1_000)
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  // Spotify reports the earlier track for a few seconds.
  for (let second = 0; second < 4; second += 1) {
    one.remote.snapshot = remoteSnapshot({
      trackUri: 'spotify:track:from-the-app',
      contextUri: 'spotify:playlist:from-the-app',
      positionMs: 62_000 + second * 1_000,
    })
    await advance(1_000)
  }
  one.remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:another-0',
    contextUri: null,
    positionMs: 500,
  })
  await advance(10_000)
  assert.deepEqual(one.sent('play'), [anotherPlay])
  assert.equal(one.sync.getState().current?.uri, 'spotify:track:another-0')
  one.close()
})

test('Play on a follower replaces what the other page started', async () => {
  const sessions = fakeSessions()
  const one = page('Safari on iPhone', sessions)
  await driveSource(one)
  const two = page('Chrome on Mac', sessions, one.remote)
  two.engine.watch()
  two.sync.start()
  await advance(5_000)
  assert.equal(two.sync.getState().sharing.role, 'follower')
  two.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await advance(2_000)
  two.remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:another-0',
    contextUri: null,
    positionMs: 500,
  })
  await advance(10_000)
  const plays = two.sent('play')
  assert.equal(plays.length, 1)
  assert.match(
    plays[0] ?? '',
    /^play speaker \{"uris":\["spotify:track:another-0"/,
  )
  assert.equal(one.sent('play').length, 1)
  assert.equal(two.sync.getState().current?.uri, 'spotify:track:another-0')
  one.close()
  two.close()
})

test('Play after a reload replaces the track the page was on', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  one.sync.start()
  one.engine.prepare()
  await settle()
  one.sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  one.emit('ready', { device_id: 'browser' })
  await settle()
  one.local.state = sdkState({
    context: '',
    track: sourceTrack(0).uri,
    position: 1_000,
  })
  await advance(5_000)
  one.sync.close()
  one.close()

  const again = harness(
    undefined,
    undefined,
    { browserId: 'client-Chrome on Mac', restoreSource },
    one.remote,
  )
  const sync = createPlaybackSync({
    engine: again.engine,
    api: sessions.api,
    clientId: 'client-reloaded',
    clientName: 'Chrome on Mac',
    now: () => clock,
    resuming: true,
  })
  again.engine.prepare()
  sync.start()
  await settle()
  again.emit('ready', { device_id: 'browser-reloaded' })
  await advance(5_000)
  // The reloaded page has the session back and plays nothing by itself.
  assert.equal(sync.getState().sharing.role, 'driver')
  assert.equal(sync.getState().current?.uri, sourceTrack(0).uri)
  assert.deepEqual(again.sent('play'), [])
  sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await advance(2_000)
  again.local.state = sdkState({
    context: '',
    track: 'spotify:track:another-0',
    position: 500,
  })
  await advance(10_000)
  const plays = again.sent('play')
  assert.equal(plays.length, 1)
  assert.match(
    plays[0] ?? '',
    /^play browser-reloaded \{"uris":\["spotify:track:another-0"/,
  )
  assert.equal(sync.getState().current?.uri, 'spotify:track:another-0')
  sync.dispose()
  again.engine.dispose()
})

/** The device plays the earlier track from its beginning, as if nothing was asked. */
async function restartEarlier(
  one: ReturnType<typeof page>,
  seconds: number,
  from = 0,
) {
  for (let second = 0; second < seconds; second += 1) {
    one.remote.snapshot = remoteSnapshot({
      trackUri: 'spotify:track:from-the-app',
      contextUri: 'spotify:playlist:from-the-app',
      positionMs: (from + second) * 1_000,
    })
    await advance(1_000)
  }
}

function playingElsewhere() {
  const one = page('Chrome on Mac', fakeSessions())
  one.remote.device = { ...speaker, active: true }
  one.remote.snapshot = remoteSnapshot({
    trackUri: 'spotify:track:from-the-app',
    contextUri: 'spotify:playlist:from-the-app',
    positionMs: 60_000,
  })
  one.engine.watch()
  one.sync.start()
  return one
}

/** The start was reported and the music the device kept is what is shown. */
function assertNotStarted(one: ReturnType<typeof page>, shown: string) {
  const state = one.sync.getState()
  assert.equal(state.current, null)
  assert.equal(state.starting, false)
  assert.match(state.failure?.message ?? '', /did not start/)
  assert.equal(state.snapshot?.trackUri, shown)
}

test('a start the device answers with what it was playing is reported and never sent again', async () => {
  const one = playingElsewhere()
  await advance(1_000)
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await restartEarlier(one, 5)
  assert.deepEqual(one.sent('play'), [anotherPlay])
  assertNotStarted(one, 'spotify:track:from-the-app')
  // The device is left playing; nothing more is sent to it.
  await restartEarlier(one, 30, 5)
  assert.deepEqual(one.sent('play'), [anotherPlay])
  assert.deepEqual(one.sent('pause'), [])
  one.close()
})

test('pressing Play again after an ignored start sends it again', async () => {
  const one = playingElsewhere()
  await advance(1_000)
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await restartEarlier(one, 5)
  assertNotStarted(one, 'spotify:track:from-the-app')
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await advance(1_000)
  assert.deepEqual(one.sent('play'), [anotherPlay, anotherPlay])
  await begins(one, { trackUri: 'spotify:track:another-0' }, 4)
  const state = one.sync.getState()
  assert.equal(state.current?.uri, 'spotify:track:another-0')
  assert.equal(state.snapshot?.trackUri, 'spotify:track:another-0')
  assert.equal(state.failure, null)
  one.close()
})

/** A page opened while its device is idle: it has not heard the device play. */
async function idleDevice() {
  const one = page('Chrome on Mac', fakeSessions())
  one.engine.watch()
  one.sync.start()
  await advance(1_000)
  await one.sync.selectDevice({ kind: 'remote', device: speaker })
  one.remote.device = { ...speaker, active: true }
  return one
}

/** The device begins a track from its start, a second at a time. */
async function begins(
  one: ReturnType<typeof page>,
  values: Partial<PlaybackSnapshot>,
  seconds: number,
) {
  for (let second = 0; second < seconds; second += 1) {
    one.remote.snapshot = remoteSnapshot({
      contextUri: null,
      ...values,
      positionMs: second * 1_000,
    })
    await advance(1_000)
  }
}

test('a page that never heard its device play reports an ignored track start', async () => {
  const one = await idleDevice()
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await restartEarlier(one, 5)
  assert.deepEqual(one.sent('play'), [anotherPlay])
  assert.deepEqual(one.asked, ['spotify:track:another-0'])
  assertNotStarted(one, 'spotify:track:from-the-app')
  await restartEarlier(one, 14, 5)
  assert.deepEqual(one.sent('play'), [anotherPlay])
  assert.deepEqual(one.asked, ['spotify:track:another-0'])
  one.close()
})

test('another recording Spotify plays for a track is the track started', async () => {
  const one = await idleDevice()
  one.playsAs('spotify:track:another-0', 'spotify:track:another-0-here')
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await begins(one, { trackUri: 'spotify:track:another-0-here' }, 6)
  assert.deepEqual(one.sent('play'), [anotherPlay])
  assert.deepEqual(one.asked, ['spotify:track:another-0'])
  const state = one.sync.getState()
  assert.equal(state.current?.uri, 'spotify:track:another-0')
  assert.equal(state.snapshot?.trackUri, 'spotify:track:another-0-here')
  assert.equal(state.starting, false)
  assert.equal(state.failure, null)
  one.close()
})

test('a recording of the same name that Spotify did not name is the track started', async () => {
  const one = await idleDevice()
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await begins(
    one,
    {
      trackUri: 'spotify:track:another-0-reissue',
      trackName: ' spotify name of spotify:track:ANOTHER-0',
    },
    6,
  )
  assert.deepEqual(one.sent('play'), [anotherPlay])
  const state = one.sync.getState()
  assert.equal(state.current?.uri, 'spotify:track:another-0')
  assert.equal(state.snapshot?.trackUri, 'spotify:track:another-0-reissue')
  assert.equal(state.failure, null)
  one.close()
})

test('a track sent with the one started, begun again by the device, is not taken for a skip', async () => {
  const one = await idleDevice()
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  // The device held the third track of this album and plays it again.
  await begins(one, { trackUri: 'spotify:track:another-2' }, 5)
  assert.deepEqual(one.sent('play'), [anotherPlay])
  assert.deepEqual(one.asked, ['spotify:track:another-0'])
  assertNotStarted(one, 'spotify:track:another-2')
  one.close()
})

test('a track Spotify cannot play here gives way to the next one sent', async () => {
  const one = await idleDevice()
  one.playsAs('spotify:track:another-0', null)
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await begins(one, { trackUri: 'spotify:track:another-1' }, 6)
  assert.deepEqual(one.sent('play'), [anotherPlay])
  assert.deepEqual(one.asked, ['spotify:track:another-0'])
  const state = one.sync.getState()
  assert.equal(state.snapshot?.trackUri, 'spotify:track:another-1')
  assert.equal(state.starting, false)
  assert.equal(state.failure, null)
  one.close()
})

test('a track that began is taken for the one started when Spotify cannot say', async () => {
  const one = await idleDevice()
  one.failLookup('spotify:track:another-0')
  one.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await restartEarlier(one, 6)
  assert.deepEqual(one.sent('play'), [anotherPlay])
  assert.deepEqual(one.asked, ['spotify:track:another-0'])
  const state = one.sync.getState()
  assert.equal(state.current?.uri, 'spotify:track:another-0')
  assert.equal(state.failure, null)
  one.close()
})

test('a page that never heard its device play reports an ignored album start', async () => {
  const one = await idleDevice()
  const albumPlay = 'play speaker {"context_uri":"spotify:album:first"}'
  one.sync.play(album)
  await restartEarlier(one, 5)
  assert.deepEqual(one.sent('play'), [albumPlay])
  assert.deepEqual(one.asked, [])
  assertNotStarted(one, 'spotify:track:from-the-app')
  await restartEarlier(one, 14, 5)
  assert.deepEqual(one.sent('play'), [albumPlay])
  one.close()
})

test('This browser chosen on another open page unlocks its audio in the click and takes the playback', async () => {
  const sessions = fakeSessions()
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  const two = page('Safari on iPhone', sessions, one.remote)
  two.engine.prepare()
  two.engine.watch()
  two.sync.start()
  await advance(5_000)
  assert.equal(two.sync.getState().sharing.role, 'follower')
  assert.deepEqual(two.sent('sdk activate'), [])

  const moved = two.sync.selectDevice({ kind: 'local' })
  // Nothing has been awaited yet, so this is still inside the click: the
  // session has not been asked for, and the audio is already unlocked.
  assert.equal(two.sync.getState().sharing.role, 'follower')
  assert.equal(two.sent('sdk activate').length, 1)
  await settle()
  two.emit('ready', { device_id: 'phone-browser' })
  await moved
  assert.equal(two.sync.getState().sharing.role, 'driver')
  assert.deepEqual(two.sent('transfer'), ['transfer phone-browser true'])
  assert.deepEqual(two.engine.getState().target, { kind: 'local' })
  assert.equal(two.engine.getState().failure, null)
  // Nothing was started again: the playback moved as it was.
  assert.deepEqual(two.sent('play'), [])
  one.close()
  two.close()
})

test('a browser Spotify has not listed yet still takes the playback a few seconds later', async () => {
  const setup = harness()
  const { engine, remote } = setup
  await engine.selectDevice({ kind: 'remote', device: speaker })
  engine.play(album)
  await settle()
  remote.device = { ...speaker, active: true }
  remote.snapshot = remoteSnapshot({ positionMs: 1_000 })
  await advance(700)
  // Spotify answers "no such device" for the first few seconds after a
  // browser registers. A check of the device made meanwhile may take one of
  // these answers, so at least three reach the transfer.
  for (let refusal = 0; refusal < 5; refusal += 1)
    remote.failures.push(new PlaybackApiError(404, null))
  const moved = engine.selectDevice({ kind: 'local' })
  await settle()
  setup.emit('ready', { device_id: 'browser' })
  await advance(4_000)
  await moved
  assert.ok(setup.sent('transfer').length > 3)
  assert.equal(setup.sent('transfer').at(-1), 'transfer browser true')
  assert.deepEqual(remote.failures, [])
  assert.deepEqual(engine.getState().target, { kind: 'local' })
  assert.equal(engine.getState().failure, null)
  engine.dispose()
})

test('a browser Spotify never lists is reported and the playback stays where it was', async () => {
  const setup = harness()
  const { engine, remote } = setup
  await engine.selectDevice({ kind: 'remote', device: speaker })
  engine.play(album)
  await settle()
  remote.device = { ...speaker, active: true }
  remote.snapshot = remoteSnapshot({ positionMs: 1_000 })
  await advance(700)
  for (let refusal = 0; refusal < 12; refusal += 1)
    remote.failures.push(new PlaybackApiError(404, null))
  const moved = engine.selectDevice({ kind: 'local' })
  await settle()
  setup.emit('ready', { device_id: 'browser' })
  await advance(6_000)
  await moved
  remote.failures.length = 0
  // The first attempt and six more, 700 ms apart.
  assert.equal(setup.sent('transfer').length, 7)
  assert.equal(engine.getState().target.kind, 'remote')
  assert.match(engine.getState().failure?.message ?? '', /not available/)
  engine.dispose()
})

test('a page that has just taken the session over notices a start its device ignores', async () => {
  const sessions = fakeSessions()
  const one = page('Safari on iPhone', sessions)
  await driveSource(one)
  const two = page('Chrome on Mac', sessions, one.remote)
  two.sync.start()
  await settle()
  // This page has not read the device itself yet when Play is pressed.
  assert.equal(two.sync.getState().sharing.role, 'follower')
  two.sync.play(anotherAlbum[0] ?? track, anotherAlbumSource())
  await advance(1_000)
  // The device starts the track it was on again instead.
  for (let second = 0; second < 5; second += 1) {
    two.remote.snapshot = playing(0, second * 1_000)
    await advance(1_000)
  }
  assert.deepEqual(two.sent('play'), [anotherPlay])
  assertNotStarted(two, sourceTrack(0).uri)
  one.close()
  two.close()
})

const fromTheApp = {
  trackUri: 'spotify:track:from-the-app',
  contextUri: 'spotify:playlist:from-the-app',
}

test('other music put on as a track ran out is left playing', async () => {
  const one = page('Chrome on Mac', fakeSessions())
  await driveSource(one)
  one.remote.snapshot = playing(0, 198_000)
  await advance(3_000)
  const played = one.sent('play').length
  // Someone starts a playlist in the Spotify app while the device still had
  // tracks of the queue to play.
  one.remote.snapshot = remoteSnapshot({ ...fromTheApp, positionMs: 20_000 })
  await advance(10_000)
  assert.equal(one.sent('play').length, played)
  const state = one.sync.getState()
  assert.equal(state.current, null)
  assert.equal(state.snapshot?.trackUri, fromTheApp.trackUri)
  assert.equal(state.source?.label, 'Tracks')
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(1).uri)
  one.close()
})

test('a page that reads the device once a minute starts nothing over other music', async () => {
  const one = page('Chrome on Mac', fakeSessions())
  await driveSource(one)
  one.remote.snapshot = playing(0, 150_000)
  await advance(3_000)
  const played = one.sent('play').length
  // A background tab is slowed down to a read a minute. By the next one the
  // track would have ended, and other music is playing.
  clock += 60_000
  one.remote.snapshot = remoteSnapshot({ ...fromTheApp, positionMs: 20_000 })
  await advance(10_000)
  assert.equal(one.sent('play').length, played)
  assert.equal(one.sync.getState().current, null)
  assert.equal(one.sync.getState().snapshot?.trackUri, fromTheApp.trackUri)
  one.close()
})

test('a page that reads the device once a minute still carries the queue on when the device has stopped', async () => {
  const one = page('Chrome on Mac', fakeSessions())
  await driveSource(one, 1)
  one.sync.enqueue(album)
  one.remote.snapshot = playing(0, 150_000)
  await advance(3_000)
  assert.equal(one.sent('play').length, 1)
  clock += 60_000
  one.remote.snapshot = { ...playing(0, 0), paused: true }
  await advance(3_000)
  assert.equal(one.sent('play').length, 2)
  assert.match(
    one.sent('play')[1] ?? '',
    /^play speaker \{"context_uri":"spotify:album:first"/,
  )
  one.close()
})

test('a page that slept follows a device that played on and leaves other music alone', async () => {
  const one = page('Chrome on Mac', fakeSessions())
  await driveSource(one)
  one.remote.snapshot = playing(0, 60_000)
  await advance(3_000)
  const played = one.sent('play').length
  // The computer sleeps for an hour while the speaker plays on.
  clock += 60 * 60_000
  one.remote.snapshot = playing(4, 30_000)
  await advance(3_000)
  let state = one.sync.getState()
  assert.equal(state.current?.uri, sourceTrack(4).uri)
  assert.equal(state.snapshot?.trackUri, sourceTrack(4).uri)
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(5).uri)
  assert.equal(one.sent('play').length, played)
  // It is followed from there as before.
  one.remote.snapshot = playing(4, 198_000)
  await advance(3_000)
  one.remote.snapshot = playing(5, 500)
  await advance(3_000)
  assert.equal(one.sync.getState().current?.uri, sourceTrack(5).uri)
  // Asleep again, and this time other music was put on meanwhile.
  clock += 60 * 60_000
  one.remote.snapshot = remoteSnapshot({ ...fromTheApp, positionMs: 20_000 })
  await advance(10_000)
  state = one.sync.getState()
  assert.equal(state.current, null)
  assert.equal(state.snapshot?.trackUri, fromTheApp.trackUri)
  assert.equal(state.source?.label, 'Tracks')
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(6).uri)
  assert.equal(one.sent('play').length, played)
  one.close()
})

test('a page that slept while its device went quiet keeps the track and starts nothing', async () => {
  const one = page('Chrome on Mac', fakeSessions())
  await driveSource(one)
  one.remote.devices = [speaker]
  one.remote.snapshot = playing(0, 60_000)
  await advance(3_000)
  const played = one.sent('play').length
  // Overnight the track ran out long ago and the device reports nothing.
  clock += 8 * 60 * 60_000
  one.remote.device = null
  one.remote.snapshot = null
  await advance(30_000)
  const state = one.sync.getState()
  assert.equal(one.sent('play').length, played)
  assert.equal(state.current?.uri, sourceTrack(0).uri)
  assert.equal(state.snapshot?.paused, true)
  assert.equal(state.snapshot?.positionMs, 60_000)
  assert.equal(state.starting, false)
  assert.equal(state.failure, null)
  // Play starts it where the page last saw it.
  one.sync.toggle()
  await settle()
  assert.match(
    one.sent('play').at(-1) ?? '',
    /^play speaker \{"uris":\["spotify:track:source-0","spotify:track:source-1".*"position_ms":60000\}$/,
  )
  one.close()
})

/** A page plays the saved source on the speaker, reaches a track and closes. */
async function closedOn(sessions: ReturnType<typeof fakeSessions>, index = 0) {
  const one = page('Chrome on Mac', sessions)
  await driveSource(one)
  one.remote.devices = [speaker]
  for (let reached = 1; reached <= index; reached += 1) {
    one.remote.snapshot = playing(reached - 1, 198_000)
    await advance(3_000)
    one.remote.snapshot = playing(reached, 500)
    await advance(3_000)
  }
  await advance(5_000)
  one.sync.close()
  one.close()
  return { remote: one.remote, closedAt: clock }
}

/** Source tracks as Spotify's play history lists them, newest first. */
function playedSince(closedAt: number, indexes: number[]) {
  return indexes
    .map((index, order) => ({
      uri: sourceTrack(index).uri,
      name: `Track ${index}`,
      playedAt: closedAt + (order + 1) * 200_000,
    }))
    .reverse()
}

test('the queue moves on past what Spotify played while every page was closed', async () => {
  const sessions = fakeSessions()
  const { remote, closedAt } = await closedOn(sessions)
  // The saved track and two more played on in the Spotify app, which was
  // then closed, so the device reports nothing.
  clock += 3 * 60 * 60_000
  remote.device = null
  remote.snapshot = null
  remote.history = playedSince(closedAt, [0, 1, 2])
  const again = await reopen(sessions, undefined, remote)
  const shown = again.sync.getState()
  assert.equal(shown.current?.uri, sourceTrack(3).uri)
  assert.equal(shown.snapshot, null)
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(4).uri)
  assert.equal(shown.rejoin?.status, 'ended')
  assert.deepEqual(again.sent('play'), [])
  assert.equal(again.sent('history').length, 1)
  assert.equal(sessions.record.state?.current?.uri, sourceTrack(3).uri)
  // Play starts the track now due from its beginning, with those after it.
  again.sync.toggle()
  await settle()
  assert.match(
    again.sent('play')[0] ?? '',
    /^play speaker \{"uris":\["spotify:track:source-3","spotify:track:source-4"/,
  )
  assert.doesNotMatch(again.sent('play')[0] ?? '', /position_ms/)
  again.close()
})

test('history recovery leaves a newly queued track ahead of the old Spotify list', async () => {
  const sessions = fakeSessions()
  const { remote, closedAt } = await closedOn(sessions)
  const saved = sessions.record.state
  assert.ok(saved)
  // This queue edit was saved while Spotify still held the original list.
  const sequence = saved.sequence + 1
  const queue = [...saved.queue, { key: `queue-${sequence}`, item: track }]
  clock += 3 * 60 * 60_000
  remote.device = null
  remote.snapshot = null
  remote.history = playedSince(closedAt, [0, 1, 2])
  const again = harness(undefined, undefined, { restoreSource }, remote)
  await again.engine.restore({ ...saved, sequence, queue })
  await settle()
  const shown = again.engine.getState()
  assert.equal(shown.current, null)
  assert.deepEqual(shown.queue, queue)
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(3).uri)
  assert.deepEqual(again.sent('play'), [])

  again.engine.toggle()
  await settle()
  assert.match(
    again.sent('play')[0] ?? '',
    /^play speaker \{"uris":\["spotify:track:single","spotify:track:source-3"/,
  )
  again.engine.dispose()
})

test('nothing played while every page was closed leaves the saved track to start again', async () => {
  const sessions = fakeSessions()
  const { remote } = await closedOn(sessions)
  clock += 3 * 60 * 60_000
  remote.device = null
  remote.snapshot = null
  remote.history = []
  const again = await reopen(sessions, undefined, remote)
  const shown = again.sync.getState()
  assert.equal(shown.current?.uri, sourceTrack(0).uri)
  assert.equal(shown.snapshot?.paused, true)
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(1).uri)
  assert.deepEqual(again.sent('play'), [])
  again.close()
})

test('other music on the device does not stop the queue moving on past what was played', async () => {
  const sessions = fakeSessions()
  const { remote, closedAt } = await closedOn(sessions)
  clock += 3 * 60 * 60_000
  remote.snapshot = remoteSnapshot({ ...fromTheApp, positionMs: 20_000 })
  remote.history = [
    { uri: fromTheApp.trackUri, name: 'Other', playedAt: clock - 1_000 },
    ...playedSince(closedAt, [0, 1]),
  ]
  const again = await reopen(sessions, undefined, remote)
  const shown = again.sync.getState()
  assert.equal(shown.current, null)
  assert.equal(shown.snapshot?.trackUri, fromTheApp.trackUri)
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(2).uri)
  assert.equal(shown.rejoin?.status, 'changed')
  assert.deepEqual(again.sent('play'), [])
  again.close()
})

test('a list that ran out while every page was closed leaves the queue after it', async () => {
  const sessions = fakeSessions()
  const { remote } = await closedOn(sessions, 1)
  // The device played all it was given, went back to the first track and
  // stopped there.
  clock += 4 * 60 * 60_000
  remote.snapshot = { ...playing(0, 0), paused: true }
  const again = await reopen(sessions, undefined, remote)
  const shown = again.sync.getState()
  assert.equal(shown.current, null)
  assert.equal(shown.snapshot, null)
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(31).uri)
  assert.equal(shown.rejoin?.status, 'ended')
  assert.deepEqual(again.sent('play'), [])
  assert.deepEqual(again.sent('history'), [])
  // Play carries the source on from there.
  again.sync.toggle()
  await settle()
  assert.match(
    again.sent('play')[0] ?? '',
    /^play speaker \{"uris":\["spotify:track:source-31","spotify:track:source-32"/,
  )
  again.close()
})

test('music left paused on the device by another app is picked up when the app opens', async () => {
  const sessions = fakeSessions()
  const { remote } = await closedOn(sessions)
  clock += 20 * 60_000
  remote.snapshot = remoteSnapshot({
    ...fromTheApp,
    positionMs: 40_000,
    paused: true,
  })
  const again = await reopen(sessions, undefined, remote)
  const shown = again.sync.getState()
  assert.equal(shown.current, null)
  assert.equal(shown.snapshot?.trackUri, fromTheApp.trackUri)
  assert.equal(shown.snapshot?.paused, true)
  assert.equal(shown.rejoin?.status, 'changed')
  assert.equal(shown.source?.label, 'Tracks')
  // Play carries on with what the device holds; nothing is started over it.
  again.sync.toggle()
  await settle()
  assert.deepEqual(again.sent('resume'), ['resume speaker'])
  assert.deepEqual(again.sent('play'), [])
  again.close()
})

/** A page pauses the saved source on the speaker, which Spotify then forgets. */
async function wentQuiet(sessions: ReturnType<typeof fakeSessions>) {
  const one = page('Chrome on Mac', sessions)
  one.engine.watch()
  await driveSource(one)
  one.remote.devices = [speaker]
  one.remote.snapshot = { ...playing(0, 60_000), paused: true }
  await advance(3_000)
  one.remote.device = null
  one.remote.snapshot = null
  await advance(30_000)
  const state = one.sync.getState()
  assert.equal(state.current?.uri, sourceTrack(0).uri)
  assert.equal(state.snapshot?.paused, true)
  assert.equal(state.snapshot?.positionMs, 60_000)
  return one
}

test('a device that went quiet and plays on later through its tracks is followed again', async () => {
  const one = await wentQuiet(fakeSessions())
  const played = one.sent('play').length
  // It is started again from the Spotify app and has reached the third track.
  one.remote.device = { ...speaker, active: true }
  one.remote.snapshot = playing(2, 10_000)
  await advance(6_000)
  let state = one.sync.getState()
  assert.equal(state.current?.uri, sourceTrack(2).uri)
  assert.equal(state.snapshot?.trackUri, sourceTrack(2).uri)
  assert.equal(state.snapshot?.paused, false)
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(3).uri)
  // It is followed from there as before.
  one.remote.snapshot = playing(2, 198_000)
  await advance(3_000)
  one.remote.snapshot = playing(3, 500)
  await advance(3_000)
  state = one.sync.getState()
  assert.equal(state.current?.uri, sourceTrack(3).uri)
  assert.equal(one.sent('play').length, played)
  one.close()
})

test('a device that went quiet and was left paused further on is picked up there', async () => {
  const one = await wentQuiet(fakeSessions())
  const played = one.sent('play').length
  one.remote.device = { ...speaker, active: true }
  one.remote.snapshot = { ...playing(1, 45_000), paused: true }
  await advance(6_000)
  const state = one.sync.getState()
  assert.equal(state.current?.uri, sourceTrack(1).uri)
  assert.equal(state.snapshot?.paused, true)
  assert.equal(state.snapshot?.positionMs, 45_000)
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(2).uri)
  // Play carries on with what the device holds.
  one.sync.toggle()
  await settle()
  assert.deepEqual(one.sent('resume'), ['resume speaker'])
  assert.equal(one.sent('play').length, played)
  one.close()
})

test('other music found after a device went quiet is shown and the queue moved past what was played', async () => {
  const one = await wentQuiet(fakeSessions())
  const played = one.sent('play').length
  const quietAt = clock
  // The Spotify app played the kept track and the next one, then a playlist.
  clock += 20 * 60_000
  one.remote.history = playedSince(quietAt, [0, 1])
  one.remote.device = { ...speaker, active: true }
  one.remote.snapshot = remoteSnapshot({ ...fromTheApp, positionMs: 20_000 })
  await advance(6_000)
  const state = one.sync.getState()
  assert.equal(state.current, null)
  assert.equal(state.snapshot?.trackUri, fromTheApp.trackUri)
  assert.equal(state.source?.label, 'Tracks')
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(2).uri)
  assert.equal(one.sent('play').length, played)
  one.close()
})

test('a device that went quiet before the app closed is still rejoined when the app opens', async () => {
  const sessions = fakeSessions()
  const one = await wentQuiet(sessions)
  assert.equal(sessions.record.state?.session?.sent[0]?.uri, sourceTrack(0).uri)
  one.sync.close()
  one.close()
  clock += 60 * 60_000
  one.remote.device = { ...speaker, active: true }
  one.remote.snapshot = playing(2, 10_000)
  const again = await reopen(sessions, undefined, one.remote)
  const shown = again.sync.getState()
  assert.equal(shown.current?.uri, sourceTrack(2).uri)
  assert.equal(shown.snapshot?.trackUri, sourceTrack(2).uri)
  assert.equal(shown.upcoming[0]?.item.uri, sourceTrack(3).uri)
  assert.equal(shown.rejoin?.status, 'rejoined')
  assert.deepEqual(again.sent('play'), [])
  again.close()
})

test('a device reported paused again on the kept track changes nothing and is not asked about again', async () => {
  const one = await wentQuiet(fakeSessions())
  const asked = one.sent('history').length
  const played = one.sent('play').length
  // The Spotify app is opened again and shows its last track from the start.
  one.remote.device = { ...speaker, active: true }
  one.remote.snapshot = { ...playing(0, 0), paused: true }
  await advance(30_000)
  const state = one.sync.getState()
  assert.equal(state.current?.uri, sourceTrack(0).uri)
  assert.equal(state.snapshot?.positionMs, 60_000)
  assert.equal(one.sent('history').length, asked)
  assert.equal(one.sent('play').length, played)
  // Play starts it again where it stopped.
  one.sync.toggle()
  await settle()
  assert.match(one.sent('play').at(-1) ?? '', /"position_ms":60000\}$/)
  one.close()
})

test('a Sonos room that reported no track for a while is followed again when it plays on', async () => {
  const sonos = fakeSonos()
  const one = page('Chrome on Mac', fakeSessions(), undefined, sonos.api)
  one.engine.watch()
  one.sync.start()
  await settle()
  await one.sync.selectDevice({ kind: 'room', room: kitchen })
  one.sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  sonos.room.state = roomState(sourceTrack(0).uri, {
    positionMs: 60_000,
    hasNext: true,
  })
  await advance(15_000)
  const loaded = sonos.loads.length
  // The room is switched to another input and reports no track.
  sonos.room.state = roomState(null)
  await advance(40_000)
  let state = one.sync.getState()
  assert.equal(state.current?.uri, sourceTrack(0).uri)
  assert.equal(state.snapshot?.paused, true)
  assert.deepEqual(state.target, { kind: 'room', room: kitchen })
  // Back on its queue, it has reached the third track.
  sonos.room.state = roomState(sourceTrack(2).uri, {
    positionMs: 20_000,
    hasNext: true,
  })
  await advance(25_000)
  state = one.sync.getState()
  assert.equal(state.current?.uri, sourceTrack(2).uri)
  assert.equal(state.snapshot?.trackUri, sourceTrack(2).uri)
  assert.equal(state.snapshot?.paused, false)
  assert.equal(state.upcoming[0]?.item.uri, sourceTrack(3).uri)
  assert.deepEqual(state.target, { kind: 'room', room: kitchen })
  // Nothing on the room was started or loaded again.
  assert.deepEqual(sonos.commands, [])
  assert.equal(
    sonos.loads.slice(loaded).filter((load) => !load.includes(' append '))
      .length,
    0,
  )
  one.close()
})

/** Collects the plays an engine hands on for scrobbling. */
function scrobbleLog(enabled = true) {
  const plays: LastfmPlay[] = []
  return {
    plays,
    scrobbles: {
      enabled: () => enabled,
      report: (reported: LastfmPlay[]) => {
        plays.push(...reported)
      },
    },
  }
}

/** Lets a room play a track from one position to another, read as it goes. */
async function roomPlays(
  sonos: ReturnType<typeof fakeSonos>,
  uri: string,
  from: number,
  to: number,
  values: Partial<SonosGroupState> = {},
) {
  for (let positionMs = from; positionMs <= to; positionMs += 3_000) {
    sonos.room.state = roomState(uri, { positionMs, ...values })
    await advance(3_000)
  }
}

async function trackOnRoom(log: ReturnType<typeof scrobbleLog>) {
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api, { scrobbles: log.scrobbles })
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  setup.engine.play(track)
  await settle()
  return { sonos, setup }
}

test('a track played on a Sonos room is reported once half of it was heard', async () => {
  const log = scrobbleLog()
  const { sonos, setup } = await trackOnRoom(log)
  const startedAt = clock
  await roomPlays(sonos, track.uri, 0, 93_000)
  assert.equal(log.plays.length, 0)
  await roomPlays(sonos, track.uri, 96_000, 198_000)
  assert.equal(log.plays.length, 1)
  const [play] = log.plays
  assert.deepEqual(
    { ...play, startedAt: 0 },
    {
      trackUri: track.uri,
      track: `Spotify name of ${track.uri}`,
      artist: 'Spotify artist',
      album: 'Spotify album',
      durationMs: 180_000,
      startedAt: 0,
    },
  )
  // The play is dated from when the track began on the room.
  assert.ok(Math.abs((play?.startedAt ?? 0) - startedAt) <= 3_000)
  assert.equal(setup.engine.saved()?.listen?.reported, true)
  setup.engine.dispose()
})

test('a play still waiting for track details is not marked reported after Sonos lease loss', async () => {
  const log = scrobbleLog()
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api, {
    initialRoom: kitchen,
    scrobbles: log.scrobbles,
  })
  const trackDetails = setup.api.track
  const answers: Array<() => void> = []
  setup.api.track = async (uri) => {
    const details = await trackDetails(uri)
    await new Promise<void>((resolve) => answers.push(resolve))
    return details
  }
  setup.engine.play(track)
  await settle()
  await roomPlays(sonos, track.uri, 0, 120_000)
  assert.ok(answers.length > 0)
  assert.equal(log.plays.length, 0)
  assert.equal(setup.engine.saved()?.listen?.reported, false)

  setup.engine.setSonosPolling(false)
  setup.engine.setSonosPolling(true)
  setup.api.track = trackDetails
  for (const answer of answers) answer()
  await settle()
  assert.equal(log.plays.length, 0)
  assert.equal(setup.engine.saved()?.listen?.reported, false)

  sonos.room.state = roomState(track.uri, { positionMs: 125_000 })
  await advance(100)
  assert.equal(log.plays.length, 1)
  assert.equal(setup.engine.saved()?.listen?.reported, true)
  setup.engine.dispose()
})

test('a track skipped on a Sonos room is not reported, and nothing is counted with scrobbling off', async () => {
  const log = scrobbleLog()
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api, { scrobbles: log.scrobbles })
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  setup.engine.play(sourceTrack(0), fixtureSource(40))
  await settle()
  await roomPlays(sonos, sourceTrack(0).uri, 0, 30_000, { hasNext: true })
  setup.engine.next()
  await settle()
  await roomPlays(sonos, sourceTrack(1).uri, 0, 60_000, { hasNext: true })
  assert.equal(log.plays.length, 0)
  await roomPlays(sonos, sourceTrack(1).uri, 63_000, 120_000, {
    hasNext: true,
  })
  assert.deepEqual(
    log.plays.map((play) => play.trackUri),
    [sourceTrack(1).uri],
  )
  setup.engine.dispose()

  const off = scrobbleLog(false)
  const quiet = await trackOnRoom(off)
  await roomPlays(quiet.sonos, track.uri, 0, 150_000)
  assert.equal(off.plays.length, 0)
  assert.equal(quiet.setup.engine.saved()?.listen, null)
  quiet.setup.engine.dispose()
})

test('music this app did not load on a Sonos room is not reported', async () => {
  const log = scrobbleLog()
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api, {
    initialRoom: kitchen,
    scrobbles: log.scrobbles,
  })
  setup.engine.watch()
  await roomPlays(sonos, 'spotify:track:elsewhere', 0, 150_000)
  assert.equal(
    setup.engine.getState().snapshot?.trackUri,
    'spotify:track:elsewhere',
  )
  assert.equal(setup.engine.getState().current, null)
  assert.equal(log.plays.length, 0)
  setup.engine.dispose()
})

test('a track that runs out between two reads of the room is reported with the one before the skip left out', async () => {
  const log = scrobbleLog()
  const sonos = fakeSonos()
  const setup = harness(undefined, sonos.api, { scrobbles: log.scrobbles })
  await setup.engine.selectDevice({ kind: 'room', room: kitchen })
  setup.engine.play(sourceTrack(0), fixtureSource(40))
  await settle()
  await roomPlays(sonos, sourceTrack(0).uri, 0, 90_000, { hasNext: true })
  assert.equal(log.plays.length, 0)
  // The page goes without a read for about 80 seconds.
  clock += 68_000
  sonos.room.state = roomState(sourceTrack(0).uri, {
    positionMs: 173_000,
    hasNext: true,
  })
  await advance(15_000)
  assert.deepEqual(
    log.plays.map((play) => play.trackUri),
    [sourceTrack(0).uri],
  )
  // The room went two tracks on within seconds: the one between was skipped.
  sonos.room.state = roomState(sourceTrack(2).uri, {
    positionMs: 1_000,
    hasNext: true,
  })
  await advance(15_000)
  assert.equal(setup.engine.getState().current?.uri, sourceTrack(2).uri)
  assert.equal(log.plays.length, 1)
  setup.engine.dispose()
})

test('tracks a Sonos room played with every page closed are reported when it is rejoined', async () => {
  const log = scrobbleLog()
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  const one = page(
    'Chrome on Mac',
    sessions,
    undefined,
    sonos.api,
    log.scrobbles,
  )
  one.sync.start()
  await settle()
  await one.sync.selectDevice({ kind: 'room', room: kitchen })
  one.sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  const startedAt = clock
  await roomPlays(sonos, sourceTrack(0).uri, 0, 60_000, { hasNext: true })
  await advance(1_000)
  one.sync.close()
  one.close()
  assert.equal(log.plays.length, 0)
  assert.equal(sessions.record.state?.listen?.reported, false)

  // Half an hour later the room is three tracks further along its queue.
  clock += 30 * 60_000
  sonos.room.state = roomState(sourceTrack(3).uri, {
    positionMs: 50_000,
    hasNext: true,
  })
  const again = page(
    'Safari on iPhone',
    sessions,
    undefined,
    sonos.api,
    log.scrobbles,
  )
  again.engine.watch()
  again.sync.start()
  await advance(4_000)
  assert.equal(again.sync.getState().current?.uri, sourceTrack(3).uri)
  assert.deepEqual(
    log.plays.map((play) => play.trackUri),
    [sourceTrack(0).uri, sourceTrack(1).uri, sourceTrack(2).uri],
  )
  const [first, second, third] = log.plays
  assert.ok(Math.abs((first?.startedAt ?? 0) - startedAt) <= 3_000)
  // Each track is dated back from the one after it, by its own length.
  assert.equal((third?.startedAt ?? 0) - (second?.startedAt ?? 0), 180_000)
  assert.ok((third?.startedAt ?? 0) + 180_000 <= clock - 50_000)

  // The track the room is on is reported in its turn, once.
  await roomPlays(sonos, sourceTrack(3).uri, 53_000, 110_000, {
    hasNext: true,
  })
  assert.equal(log.plays.length, 4)
  assert.equal(log.plays[3]?.trackUri, sourceTrack(3).uri)
  again.close()
})

test('a track reported before a reload is not reported again after it', async () => {
  const log = scrobbleLog()
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  const one = page(
    'Chrome on Mac',
    sessions,
    undefined,
    sonos.api,
    log.scrobbles,
  )
  one.sync.start()
  await settle()
  await one.sync.selectDevice({ kind: 'room', room: kitchen })
  one.sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  await roomPlays(sonos, sourceTrack(0).uri, 0, 120_000, { hasNext: true })
  await advance(1_000)
  assert.equal(log.plays.length, 1)
  one.sync.close()
  one.close()
  assert.equal(sessions.record.state?.listen?.reported, true)

  // The room is paused for twenty minutes, then the app is opened again.
  clock += 20 * 60_000
  sonos.room.state = roomState(sourceTrack(0).uri, {
    state: 'paused',
    positionMs: 125_000,
    hasNext: true,
  })
  const again = page(
    'Safari on iPhone',
    sessions,
    undefined,
    sonos.api,
    log.scrobbles,
  )
  again.engine.watch()
  again.sync.start()
  await advance(4_000)
  assert.equal(again.sync.getState().current?.uri, sourceTrack(0).uri)
  await roomPlays(sonos, sourceTrack(0).uri, 128_000, 197_000, {
    hasNext: true,
  })
  sonos.room.state = roomState(sourceTrack(1).uri, {
    positionMs: 1_000,
    hasNext: true,
  })
  await advance(3_000)
  assert.equal(log.plays.length, 1)
  again.close()
})

test('a Sonos room found stopped after its whole queue is reported to the end of it', async () => {
  const log = scrobbleLog()
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  const one = page(
    'Chrome on Mac',
    sessions,
    undefined,
    sonos.api,
    log.scrobbles,
  )
  one.sync.start()
  await settle()
  await one.sync.selectDevice({ kind: 'room', room: kitchen })
  one.sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  await roomPlays(sonos, sourceTrack(0).uri, 0, 198_000, { hasNext: true })
  await roomPlays(sonos, sourceTrack(1).uri, 1_000, 31_000, { hasNext: true })
  await advance(1_000)
  one.sync.close()
  one.close()
  assert.deepEqual(
    log.plays.map((play) => play.trackUri),
    [sourceTrack(0).uri],
  )
  const given = sessions.record.state?.session?.sent.length ?? 0
  assert.ok(given > 2)

  // Hours later the room has stopped back at the first of its tracks.
  clock += 3 * 60 * 60_000
  sonos.room.state = roomState(sourceTrack(0).uri, {
    state: 'paused',
    positionMs: 0,
  })
  const again = page(
    'Safari on iPhone',
    sessions,
    undefined,
    sonos.api,
    log.scrobbles,
  )
  again.engine.watch()
  again.sync.start()
  await advance(4_000)
  assert.deepEqual(again.sync.getState().rejoin, {
    status: 'ended',
    device: 'Fixture kitchen',
  })
  assert.deepEqual(
    log.plays.map((play) => play.trackUri),
    Array.from({ length: given }, (_, index) => sourceTrack(index).uri),
  )
  again.close()
})

test("a stopped Sonos room's tracks are reported from Spotify's play history", async () => {
  const log = scrobbleLog()
  const sessions = fakeSessions()
  const sonos = fakeSonos()
  const one = page(
    'Chrome on Mac',
    sessions,
    undefined,
    sonos.api,
    log.scrobbles,
  )
  one.sync.start()
  await settle()
  await one.sync.selectDevice({ kind: 'room', room: kitchen })
  one.sync.play(sourceTrack(0), savedFixtureSource(40))
  await settle()
  await roomPlays(sonos, sourceTrack(0).uri, 0, 120_000, { hasNext: true })
  await advance(1_000)
  one.sync.close()
  one.close()
  const closedAt = clock
  assert.equal(log.plays.length, 1)

  clock += 3 * 60 * 60_000
  sonos.room.state = roomState(sourceTrack(0).uri, { state: 'idle' })
  const again = page(
    'Safari on iPhone',
    sessions,
    {
      device: null,
      restricted: null,
      snapshot: null,
      devices: [],
      failures: [],
      history: playedSince(closedAt, [0, 1, 2]),
    },
    sonos.api,
    log.scrobbles,
  )
  again.engine.watch()
  again.sync.start()
  await advance(4_000)
  assert.equal(again.sync.getState().current?.uri, sourceTrack(3).uri)
  // The first track was reported while it played; Spotify dates a play by its end.
  assert.deepEqual(
    log.plays
      .slice(1)
      .map(({ trackUri, startedAt }) => ({ trackUri, startedAt })),
    [
      { trackUri: sourceTrack(1).uri, startedAt: closedAt + 400_000 - 180_000 },
      { trackUri: sourceTrack(2).uri, startedAt: closedAt + 600_000 - 180_000 },
    ],
  )
  again.close()
})
