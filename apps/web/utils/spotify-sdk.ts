import { z } from 'zod'
import type { PlaybackSnapshot } from './playback'

type SdkListener = (payload: unknown) => void

/** The parts of Spotify's Web Playback SDK player this app uses. */
export interface SpotifySdkPlayer {
  connect(): Promise<boolean>
  disconnect(): void
  addListener(event: string, listener: SdkListener): boolean
  getCurrentState(): Promise<unknown>
  setVolume(volume: number): Promise<void>
  togglePlay(): Promise<void>
  seek(positionMs: number): Promise<void>
  previousTrack(): Promise<void>
  nextTrack(): Promise<void>
  activateElement(): Promise<void>
}

export interface SpotifySdk {
  Player: new (options: {
    name: string
    getOAuthToken: (callback: (token: string) => void) => void
    volume?: number
    enableMediaSession?: boolean
  }) => SpotifySdkPlayer
}

declare global {
  interface Window {
    Spotify?: SpotifySdk
    onSpotifyWebPlaybackSDKReady?: () => void
  }
}

export const sdkErrorEvents = [
  'initialization_error',
  'authentication_error',
  'account_error',
  'playback_error',
]

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js'
let loading: Promise<SpotifySdk> | null = null

/** Loads the SDK script once; a failed load can be retried. */
export function loadSpotifySdk(): Promise<SpotifySdk> {
  if (window.Spotify) return Promise.resolve(window.Spotify)
  loading ??= new Promise<SpotifySdk>((resolve, reject) => {
    const script = document.createElement('script')
    const fail = () => {
      loading = null
      script.remove()
      reject(new Error('The Spotify player could not be loaded'))
    }
    window.onSpotifyWebPlaybackSDKReady = () =>
      window.Spotify ? resolve(window.Spotify) : fail()
    script.src = SDK_URL
    script.async = true
    script.onerror = fail
    document.head.appendChild(script)
  })
  return loading
}

const TrackSchema = z.object({
  uri: z.string(),
  name: z.string(),
  duration_ms: z.number().nonnegative().optional(),
  artists: z.array(z.object({ name: z.string() })).default([]),
  album: z
    .object({
      name: z.string().optional(),
      images: z.array(z.object({ url: z.string() })).default([]),
    })
    .optional(),
  linked_from: z
    .object({ uri: z.string().nullable().optional() })
    .nullable()
    .optional(),
})
const StateSchema = z.object({
  context: z
    .object({ uri: z.string().nullable().optional() })
    .nullable()
    .optional(),
  paused: z.boolean(),
  position: z.number().nonnegative(),
  duration: z.number().nonnegative().optional(),
  track_window: z.object({
    current_track: TrackSchema.nullable(),
    next_tracks: z.array(z.unknown()).default([]),
  }),
})
const ReadySchema = z.object({ device_id: z.string().min(1) })

export function sdkDeviceId(value: unknown): string | null {
  const parsed = ReadySchema.safeParse(value)
  return parsed.success ? parsed.data.device_id : null
}

/** Normalises an SDK playback state; null when this browser is not playing. */
export function sdkPlayback(
  value: unknown,
  at: number,
): PlaybackSnapshot | null {
  const parsed = StateSchema.safeParse(value)
  const track = parsed.success ? parsed.data.track_window.current_track : null
  if (!parsed.success || !track) return null
  const artwork = track.album?.images[0]?.url
  return {
    trackUri: track.uri,
    linkedFromUri: track.linked_from?.uri ?? null,
    trackName: track.name,
    artists: track.artists.map((artist) => artist.name).join(', '),
    albumName: track.album?.name ?? '',
    artworkUrl: artwork?.startsWith('https://') ? artwork : null,
    durationMs: parsed.data.duration ?? track.duration_ms ?? 0,
    positionMs: parsed.data.position,
    paused: parsed.data.paused,
    contextUri: parsed.data.context?.uri || null,
    hasNext: parsed.data.track_window.next_tracks.length > 0,
    trackNumber: null,
    discNumber: null,
    at,
  }
}
