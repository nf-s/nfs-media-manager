import { z } from 'zod'
import { SPOTIFY_PLAYBACK_UNAVAILABLE } from '@repo/schemas/spotify'
import { PlaybackApiError } from './spotify-player-api'

/** A failure reported by, or while setting up, the in-browser Spotify player. */
export class SdkFailure extends Error {
  constructor(readonly kind: string) {
    super(`Spotify player: ${kind}`)
    this.name = 'SdkFailure'
  }
}

export type PlaybackFailure = { status: 'error' | 'expired'; message: string }

const expired: PlaybackFailure = {
  status: 'expired',
  message: 'Sign in again to keep playing.',
}
const ServerFailureSchema = z.object({
  statusCode: z.number(),
  message: z.string().min(1),
})
const sdkMessages: Record<string, string> = {
  initialization_error:
    'This browser cannot play Spotify audio. Choose another device.',
  account_error: 'Spotify Premium is required to play in the browser.',
  playback_error: 'Spotify could not play that track.',
  load: 'The Spotify player could not be loaded.',
}

function failed(message: string): PlaybackFailure {
  return { status: 'error', message }
}

/** What to show for a failed playback action; `expired` needs a new connection. */
export function playbackFailure(error: unknown): PlaybackFailure {
  if (error instanceof PlaybackApiError) {
    if (error.status === 401) return expired
    if (error.status === 403)
      return failed(
        error.reason === 'PREMIUM_REQUIRED'
          ? 'Spotify Premium is required.'
          : 'Spotify did not allow that on this device.',
      )
    if (error.status === 404)
      return failed('That device is not available. Choose another.')
    if (error.status === 429)
      return failed('Spotify is limiting requests. Try again shortly.')
    return failed('Spotify could not complete that request.')
  }
  if (error instanceof SdkFailure) {
    if (error.kind === 'authentication_error') return expired
    return failed(
      sdkMessages[error.kind] ??
        'The Spotify player did not connect. Try again.',
    )
  }
  const server = ServerFailureSchema.safeParse(error)
  if (server.success) {
    if (server.data.message === SPOTIFY_PLAYBACK_UNAVAILABLE) return expired
    if (server.data.statusCode === 422) return failed(server.data.message)
  }
  return failed('Playback could not start. Check the connection and try again.')
}
