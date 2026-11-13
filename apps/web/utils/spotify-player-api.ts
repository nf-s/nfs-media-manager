import { z } from 'zod'
import type { PlaybackSnapshot } from './playback'

const DeviceSchema = z.object({
  id: z.string().nullable(),
  is_active: z.boolean(),
  is_restricted: z.boolean().optional(),
  name: z.string(),
  type: z.string(),
  volume_percent: z.number().min(0).max(100).nullable().optional(),
  supports_volume: z.boolean().optional(),
})
const DevicesSchema = z.object({ devices: z.array(DeviceSchema) })
const TrackSchema = z.object({
  uri: z.string(),
  name: z.string(),
  duration_ms: z.number().nonnegative(),
  track_number: z.number().int().optional(),
  disc_number: z.number().int().optional(),
  artists: z.array(z.object({ name: z.string() })).default([]),
  album: z
    .object({
      name: z.string(),
      images: z.array(z.object({ url: z.string() })).default([]),
    })
    .optional(),
})
const StateSchema = z.object({
  device: DeviceSchema,
  context: z.object({ uri: z.string() }).nullable().optional(),
  progress_ms: z.number().nonnegative().nullable(),
  is_playing: z.boolean(),
  item: z.unknown(),
})
const ErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    reason: z.string().optional(),
  }),
})

export type PlaybackDevice = {
  id: string
  name: string
  type: string
  active: boolean
  restricted: boolean
  /** 0 to 1, or null when the device does not report or accept a volume. */
  volume: number | null
}

/** A device Spotify reports but does not let apps control; it has no usable ID. */
export type RestrictedDevice = { name: string; type: string }

export class PlaybackApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(`Spotify player request failed (HTTP ${status})`)
    this.name = 'PlaybackApiError'
  }
}

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function device(value: z.infer<typeof DeviceSchema>): PlaybackDevice | null {
  if (!value.id) return null
  return {
    id: value.id,
    name: value.name,
    type: value.type.toLowerCase(),
    active: value.is_active,
    restricted: value.is_restricted ?? false,
    volume:
      value.supports_volume === false ||
      value.volume_percent === null ||
      value.volume_percent === undefined
        ? null
        : value.volume_percent / 100,
  }
}

/** Normalises Spotify's playback state response; exported for tests. */
export function remotePlayback(
  value: unknown,
  at: number,
): {
  /** The device playback is on, when apps can control it. */
  device: PlaybackDevice | null
  /** The device playback is on, when apps can only observe it. */
  restricted: RestrictedDevice | null
  snapshot: PlaybackSnapshot | null
} {
  const state = StateSchema.parse(value)
  const track = TrackSchema.safeParse(state.item)
  const reported = device(state.device)
  const controllable = reported !== null && !reported.restricted
  return {
    device: controllable ? reported : null,
    restricted: controllable
      ? null
      : { name: state.device.name, type: state.device.type.toLowerCase() },
    snapshot: track.success
      ? {
          trackUri: track.data.uri,
          linkedFromUri: null,
          trackName: track.data.name,
          artists: track.data.artists.map((artist) => artist.name).join(', '),
          albumName: track.data.album?.name ?? '',
          artworkUrl: httpsUrl(track.data.album?.images[0]?.url),
          durationMs: track.data.duration_ms,
          positionMs: state.progress_ms ?? 0,
          paused: !state.is_playing,
          contextUri: state.context?.uri ?? null,
          hasNext: null,
          trackNumber: track.data.track_number ?? null,
          discNumber: track.data.disc_number ?? null,
          at,
        }
      : null,
  }
}

type TokenSource = (refresh?: boolean) => Promise<string>
type Query = Record<string, string | number | undefined>

/**
 * Spotify's player endpoints, called from the browser with the short-lived
 * access token. These are user-initiated playback controls and do not pass
 * through the server's provider request gate.
 */
export function createPlayerApi(
  token: TokenSource,
  fetcher: typeof fetch = fetch,
) {
  async function send(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    query: Query = {},
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(`https://api.spotify.com/v1/me/player${path}`)
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value))
    const request = async (refresh: boolean) =>
      fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${await token(refresh)}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    let response = await request(false)
    // The cached token may have been replaced; ask the server once more.
    if (response.status === 401) response = await request(true)
    if (response.ok) return response
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      /* Spotify sends some failures without a body. */
    }
    const parsed = ErrorSchema.safeParse(payload)
    throw new PlaybackApiError(
      response.status,
      parsed.success ? (parsed.data.error.reason ?? null) : null,
    )
  }
  return {
    async devices(): Promise<PlaybackDevice[]> {
      const response = await send('GET', '/devices')
      return DevicesSchema.parse(await response.json()).devices.flatMap(
        (entry) => {
          const parsed = device(entry)
          return parsed ? [parsed] : []
        },
      )
    },
    async state() {
      const response = await send('GET', '')
      const at = Date.now()
      if (response.status === 204)
        return { device: null, restricted: null, snapshot: null }
      return remotePlayback(await response.json(), at)
    },
    async play(deviceId: string, body: unknown) {
      await send('PUT', '/play', { device_id: deviceId }, body)
    },
    async transfer(deviceId: string, play: boolean) {
      await send('PUT', '', {}, { device_ids: [deviceId], play })
    },
    async resume(deviceId: string) {
      await send('PUT', '/play', { device_id: deviceId })
    },
    async pause(deviceId: string) {
      await send('PUT', '/pause', { device_id: deviceId })
    },
    async next(deviceId: string) {
      await send('POST', '/next', { device_id: deviceId })
    },
    async previous(deviceId: string) {
      await send('POST', '/previous', { device_id: deviceId })
    },
    async seek(deviceId: string, positionMs: number) {
      await send('PUT', '/seek', {
        device_id: deviceId,
        position_ms: Math.max(0, Math.round(positionMs)),
      })
    },
    async volume(deviceId: string, volume: number) {
      await send('PUT', '/volume', {
        device_id: deviceId,
        volume_percent: Math.round(Math.min(1, Math.max(0, volume)) * 100),
      })
    },
  }
}

export type PlayerApi = ReturnType<typeof createPlayerApi>
