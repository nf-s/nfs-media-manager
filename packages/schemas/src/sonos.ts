import { z } from 'zod'

/** The Control API's only scope: playback, volume, grouping and favourites. */
export const SONOS_SCOPE = 'playback-control-all'

export const SonosAccountStatusSchema = z.object({
  /** The integration key, secret and redirect URI are saved in Providers. */
  configured: z.boolean(),
  connected: z.boolean(),
  redirectUri: z.string().nullable(),
})
export const SonosAuthorizeInputSchema = z.object({}).strict()
export const SonosAuthorizeResultSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
})
export const SonosCallbackSchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().max(256).optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.error), {
    message: 'Expected an authorization code or denial',
  })
export const SonosDisconnectResultSchema = z.object({
  disconnected: z.literal(true),
})

export const SonosPlaybackStateSchema = z.enum([
  'idle',
  'buffering',
  'paused',
  'playing',
])

/** A Sonos group: one room, or several rooms playing together. */
export const SonosRoomSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Rooms in the group, the coordinator first. */
  players: z.array(z.string()),
  state: SonosPlaybackStateSchema.nullable(),
  /** The music service Sonos reports, such as Spotify. */
  service: z.string().nullable(),
  track: z.string().nullable(),
  artist: z.string().nullable(),
  /** Controls Sonos accepts for what the group is playing now. */
  actions: z.object({
    pause: z.boolean(),
    play: z.boolean(),
    next: z.boolean(),
    previous: z.boolean(),
    seek: z.boolean(),
  }),
})
export const SonosHouseholdSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  rooms: z.array(SonosRoomSchema),
})
export const SonosRoomsSchema = z.object({
  households: z.array(SonosHouseholdSchema),
})

export type SonosAccountStatus = z.infer<typeof SonosAccountStatusSchema>
export type SonosRoom = z.infer<typeof SonosRoomSchema>
export type SonosRooms = z.infer<typeof SonosRoomsSchema>
