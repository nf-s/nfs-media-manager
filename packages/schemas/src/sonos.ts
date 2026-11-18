import { z } from 'zod'

/** The Control API's only scope: playback, volume, grouping and favourites. */
export const SONOS_SCOPE = 'playback-control-all'

/** Browser-generated for one page load. Used only to correlate Sonos diagnostics. */
export const SONOS_PAGE_HEADER = 'X-Sonos-Page'
export const SONOS_REASON_HEADER = 'X-Sonos-Reason'
export const SonosStateReasonSchema = z.enum([
  'room-playing',
  'room-paused',
  'room-watching',
  'room-rejoin',
])
export type SonosStateReason = z.infer<typeof SonosStateReasonSchema>
export const SonosPageHeaderSchema = z
  .string()
  .max(44)
  .transform((header) => header.split('/'))
  .pipe(z.tuple([z.uuidv4(), z.enum(['visible', 'hidden'])]))

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
  /**
   * Spotify content can be started on the group: the Spotify account its
   * household plays with is known.
   */
  playable: z.boolean(),
})
export const SonosHouseholdSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  rooms: z.array(SonosRoomSchema),
})
export const SonosRoomsSchema = z.object({
  households: z.array(SonosHouseholdSchema),
})

export const SonosActionsSchema = SonosRoomSchema.shape.actions
export const SonosGroupIdSchema = z.string().regex(/^[A-Za-z0-9_:.-]{1,128}$/)
export const SonosHouseholdIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_:.-]{1,200}$/)

/** The Spotify playback the player shows, to find the Sonos group playing it. */
export const SonosPlaybackQuerySchema = z
  .object({
    trackUri: z.string().regex(/^spotify:track:[A-Za-z0-9]{22}$/),
    /** The device name Spotify reports; Sonos uses the group name. */
    device: z.string().min(1).max(200),
  })
  .strict()
/** A Sonos group the player can control. */
export const SonosGroupControlSchema = z.object({
  id: SonosGroupIdSchema,
  name: z.string(),
  household: SonosHouseholdIdSchema,
  /** Spotify content can be started on the group; see `SonosRoomSchema`. */
  playable: z.boolean(),
  actions: SonosActionsSchema,
  /** 0 to 1, or null when the group's volume is fixed. */
  volume: z.number().min(0).max(1).nullable(),
})
export const SonosPlaybackMatchSchema = z.object({
  group: SonosGroupControlSchema.nullable(),
})
export const SonosCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['play', 'pause', 'next', 'previous']) }).strict(),
  z
    .object({
      action: z.literal('seek'),
      positionMs: z
        .number()
        .int()
        .min(0)
        .max(24 * 60 * 60 * 1000),
    })
    .strict(),
  z
    .object({ action: z.literal('volume'), volume: z.number().min(0).max(1) })
    .strict(),
])
export const SonosCommandResultSchema = z.object({ done: z.literal(true) })

/** Spotify content Sonos can load on a group. */
export const SonosContentUriSchema = z
  .string()
  .regex(/^spotify:(track|album):[A-Za-z0-9]{22}$/)
/** Loads Spotify tracks or albums into a group's own queue. */
export const SonosContentInputSchema = z
  .object({
    household: SonosHouseholdIdSchema,
    /**
     * `replace` starts a new queue with the first item and adds the rest
     * after it, `append` adds to the end of the queue, and `next` places the
     * items directly after the track now playing.
     */
    mode: z.enum(['replace', 'append', 'next']),
    uris: z.array(SonosContentUriSchema).min(1).max(25),
    /** Whether the group plays afterwards; adding to a paused group keeps it paused. */
    play: z.boolean(),
    /** With `replace`: tracks to skip before playing, to start an album at a chosen track. */
    skip: z.number().int().min(0).max(200).optional(),
    /** With `replace`: where in the first track to start. */
    positionMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000)
      .optional(),
  })
  .strict()
export const SonosContentResultSchema = z.object({ done: z.literal(true) })

export const SonosGroupStateQuerySchema = z
  .object({ volume: z.enum(['true', 'false']).optional() })
  .strict()
/** What a group plays now, as Sonos reports it. */
export const SonosGroupStateSchema = z.object({
  state: SonosPlaybackStateSchema.nullable(),
  positionMs: z.number().int().min(0),
  /** Null when nothing is loaded on the group. */
  track: z
    .object({
      /** `spotify:track:…` when the track comes from Spotify. */
      uri: z.string().nullable(),
      name: z.string().nullable(),
      artist: z.string().nullable(),
      album: z.string().nullable(),
      artworkUrl: z.string().nullable(),
      durationMs: z.number().int().min(0).nullable(),
    })
    .nullable(),
  /** Whether the group's queue has a track after the current one. */
  hasNext: z.boolean(),
  /** The `spotify:album:…` or `spotify:playlist:…` the queue was loaded from. */
  containerUri: z.string().nullable(),
  actions: SonosActionsSchema,
  /** 0 to 1, or null when the group's volume is fixed; absent unless asked for. */
  volume: z.number().min(0).max(1).nullable().optional(),
})

export type SonosAccountStatus = z.infer<typeof SonosAccountStatusSchema>
export type SonosRoom = z.infer<typeof SonosRoomSchema>
export type SonosRooms = z.infer<typeof SonosRoomsSchema>
export type SonosGroupControl = z.infer<typeof SonosGroupControlSchema>
export type SonosCommand = z.infer<typeof SonosCommandSchema>
export type SonosContentInput = z.infer<typeof SonosContentInputSchema>
export type SonosGroupState = z.infer<typeof SonosGroupStateSchema>
