import { z } from 'zod'
import { SonosGroupControlSchema, SonosRoomsSchema } from './sonos'
import { TIDAL_SIMILAR_LIMIT } from './tidal-limits'

export const spotifyIdPattern = /^[A-Za-z0-9]{22}$/
export const PlaybackIsrcSchema = z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/)

/**
 * The player's shared session: what one signed-in account is playing and has
 * queued, saved so a reload or another device can carry on with it.
 */

const UriSchema = z.string().min(1).max(200)
const TextSchema = z.string().max(2000)
const LinkSchema = z.string().max(8000)

export const PlayableItemSchema = z.object({
  kind: z.enum(['album', 'track']),
  /** `spotify:album:…` for an album, `spotify:track:…` for a single track. */
  uri: UriSchema,
  /** An album played from a chosen track starts at this track URI. */
  startUri: UriSchema.optional(),
  title: TextSchema,
  artist: TextSchema,
  /** The library album; null for a library track not linked to one. */
  albumId: z.string().max(200).nullable(),
  /** The Spotify album when this item names an exact release. */
  albumUri: UriSchema.optional(),
  albumTitle: TextSchema,
  artworkUrl: LinkSchema.nullable(),
  trackCount: z.number().int().nonnegative().nullable(),
  /** The library track, when the item is one. */
  trackId: z.string().max(200).optional(),
  /** The credited artists with their library IDs, for links. */
  credits: z
    .array(z.object({ id: z.string().max(200).nullable(), name: TextSchema }))
    .max(200)
    .optional(),
})
export type PlayableItem = z.infer<typeof PlayableItemSchema>

export const QueueEntrySchema = z.object({
  key: z.string().min(1).max(100),
  item: PlayableItemSchema,
})
export type QueueEntry = z.infer<typeof QueueEntrySchema>

/** One observation of what a device is playing. */
export const PlaybackSnapshotSchema = z.object({
  trackUri: UriSchema.nullable(),
  /** The requested track when Spotify substituted another recording for it. */
  linkedFromUri: UriSchema.nullable(),
  /** The requested track confirmed by Spotify's market lookup. */
  verifiedRequestedTrackUri: UriSchema.optional(),
  isrc: PlaybackIsrcSchema.optional(),
  /** The relinked Spotify catalog URI when the device reports the requested URI. */
  relinkedTrackUri: UriSchema.optional(),
  isLocal: z.boolean().optional(),
  trackName: TextSchema,
  artists: TextSchema,
  albumName: TextSchema,
  albumUri: UriSchema.nullable(),
  artistLinks: z
    .array(z.object({ name: TextSchema, uri: UriSchema.nullable() }))
    .max(200),
  artworkUrl: LinkSchema.nullable(),
  durationMs: z.number().nonnegative(),
  positionMs: z.number().nonnegative(),
  paused: z.boolean(),
  contextUri: UriSchema.nullable(),
  /** Whether more tracks follow in the context; null when the source cannot say. */
  hasNext: z.boolean().nullable(),
  trackNumber: z.number().int().nullable(),
  discNumber: z.number().int().nullable(),
  /** Clock time of the observation, in milliseconds. */
  at: z.number().nonnegative(),
})
export type PlaybackSnapshot = z.infer<typeof PlaybackSnapshotSchema>

const CatalogIdSchema = z.string().regex(spotifyIdPattern)
export const PlaybackCatalogArtworkSchema = z
  .url({ protocol: /^https$/ })
  .max(8000)
  .refine((value) => {
    try {
      const url = new URL(value)
      return !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  })
const CatalogNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((name) => !name.includes('\0'))

/** The catalog portion of a device, queue or recovery result. */
export const PlaybackCatalogItemSchema = z.object({
  kind: z.enum(['track', 'album']),
  spotifyId: CatalogIdSchema,
  title: CatalogNameSchema,
  artworkUrl: PlaybackCatalogArtworkSchema.optional(),
  isrc: PlaybackIsrcSchema.optional(),
  album: z
    .object({ spotifyId: CatalogIdSchema.optional(), title: CatalogNameSchema })
    .optional(),
  artists: z
    .array(
      z.object({
        name: CatalogNameSchema,
        spotifyId: CatalogIdSchema.optional(),
      }),
    )
    .max(50),
  durationSec: z.number().int().positive().max(86_400).optional(),
})
export type PlaybackCatalogItem = z.infer<typeof PlaybackCatalogItemSchema>

export const PlaybackCatalogInputSchema = z
  .object({
    operation: z.enum(['playback', 'playback-queue', 'playback-recovery']),
    items: z.array(PlaybackCatalogItemSchema).min(1).max(50),
  })
  .strict()
export type PlaybackCatalogInput = z.infer<typeof PlaybackCatalogInputSchema>

const PlaybackCatalogReferenceSchema = z.object({
  id: z.string(),
  inLibrary: z.boolean(),
})

export const PlaybackCatalogResultSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(['track', 'album']),
      spotifyId: CatalogIdSchema,
      item: PlaybackCatalogReferenceSchema,
      libraryTrackId: z.string().optional(),
      album: PlaybackCatalogReferenceSchema.nullable(),
      artists: z.array(
        z.object({
          name: z.string(),
          id: z.string(),
          spotifyId: CatalogIdSchema.optional(),
        }),
      ),
    }),
  ),
})
export type PlaybackCatalogResult = z.infer<typeof PlaybackCatalogResultSchema>

/** One track of a source entry: the entry's index and the track's place in it. */
export const SourceTrackSchema = z.object({
  index: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
  item: PlayableItemSchema,
})
export type SourceTrack = z.infer<typeof SourceTrackSchema>

/** Enough to restore the source and its playing order. */
export const SourceDescriptorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('browse'),
    collection: z.enum(['albums', 'tracks']),
    /** The captured browse query string. */
    params: LinkSchema,
  }),
  z.object({
    type: z.literal('playlist'),
    id: z.string().min(1).max(200),
    params: LinkSchema,
  }),
  /** A playlist made in the app, played from its entries in position order. */
  z.object({
    type: z.literal('library-playlist'),
    id: z.string().min(1).max(200),
    library: z.enum(['albums', 'tracks']),
  }),
  /** An opened album, or the chosen rows of its track table. */
  z.object({
    type: z.literal('album'),
    tracks: z.array(PlayableItemSchema).max(2000),
  }),
  z.object({
    type: z.literal('similar-tracks'),
    itemId: z.string().min(1).max(200),
    /** The recommendations as shown at Play time, in their displayed order. */
    tracks: z.array(PlayableItemSchema.nullable()).max(TIDAL_SIMILAR_LIMIT),
  }),
])
export type SourceDescriptor = z.infer<typeof SourceDescriptorSchema>

const SOURCE_PROGRESS_MAX = 50_000

export const SavedSourceSchema = z.object({
  descriptor: SourceDescriptorSchema,
  label: TextSchema,
  href: LinkSchema,
  length: z.number().int().nonnegative(),
  startIndex: z.number().int().nonnegative(),
  kind: z.enum(['album', 'list']),
  /** Entries not yet used up, as ascending `[from, to)` index ranges. */
  remaining: z
    .array(
      z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    )
    .max(SOURCE_PROGRESS_MAX),
  /** `index:position` of the tracks played, and of those passed over. */
  played: z.array(z.string().max(40)).max(SOURCE_PROGRESS_MAX),
  skipped: z.array(z.string().max(40)).max(SOURCE_PROGRESS_MAX),
  exhausted: z.array(z.number().int().nonnegative()).max(SOURCE_PROGRESS_MAX),
  upcoming: z.array(SourceTrackSchema).max(100),
  history: z.array(SourceTrackSchema).max(100),
})
export type SavedSource = z.infer<typeof SavedSourceSchema>

const RoomTargetSchema = z.object({
  kind: z.literal('room'),
  room: z.object({
    id: z.string().min(1).max(200),
    name: TextSchema,
    household: z.string().min(1).max(200),
  }),
})

/** Where the playback is, in terms any signed-in browser can resolve. */
export const SavedTargetSchema = z.discriminatedUnion('kind', [
  RoomTargetSchema,
  z.object({
    kind: z.literal('spotify'),
    /** The Spotify device; null for one Spotify gives no usable ID for. */
    device: z
      .object({
        id: z.string().min(1).max(200),
        name: TextSchema,
        type: z.string().max(100),
        volume: z.number().min(0).max(1).nullable(),
      })
      .nullable(),
    /** The client whose own browser player is that device, if it is one. */
    browser: z.string().max(100).nullable(),
  }),
])
export type SavedTarget = z.infer<typeof SavedTargetSchema>

/**
 * How much of a track on a Sonos room has been heard, kept with the session
 * so a reloaded page neither scrobbles the track twice nor starts counting
 * again.
 */
export const PlaybackListenSchema = z.object({
  uri: UriSchema,
  /** Clock time the track began, in milliseconds. */
  startedAt: z.number().nonnegative(),
  heardMs: z.number().nonnegative(),
  /** The track's length; 0 until it is known. */
  durationMs: z.number().nonnegative(),
  /** The play has been reported for scrobbling. */
  reported: z.boolean(),
})
export type PlaybackListen = z.infer<typeof PlaybackListenSchema>

export const SavedPlaybackSchema = z.object({
  version: z.literal(1),
  /** Clock time of the save, in milliseconds. */
  savedAt: z.number().nonnegative(),
  queue: z.array(QueueEntrySchema).max(2000),
  /** The number the next queue entry's key is made from. */
  sequence: z.number().int().nonnegative(),
  current: PlayableItemSchema.nullable(),
  currentFromSource: z.boolean(),
  /** The item being followed and the tracks the device was given with it. */
  session: z
    .object({
      item: PlayableItemSchema,
      sent: z.array(PlayableItemSchema).max(200),
      index: z.number().int().nonnegative(),
      anchorUri: UriSchema.nullable(),
      /** The recording Spotify confirmed for this session's current track. */
      verifiedRecordingUri: UriSchema.optional(),
      /** Last index queued ahead of the Spotify playback context, if any remain. */
      queuedThrough: z.number().int().nonnegative().optional(),
      /** The possible sequence while a Spotify queue command is in flight. */
      pendingSent: z.array(PlayableItemSchema).min(1).max(200).optional(),
      /** The native queue's last index in pendingSent. */
      pendingQueuedThrough: z.number().int().nonnegative().optional(),
    })
    .nullable(),
  /** What the device was playing at the save, with its position then. */
  snapshot: PlaybackSnapshotSchema.nullable(),
  shuffle: z.boolean(),
  target: SavedTargetSchema,
  source: SavedSourceSchema.nullable(),
  /** The listen of the track a Sonos room plays, for scrobbling. */
  listen: PlaybackListenSchema.nullable().optional(),
})
export type SavedPlayback = z.infer<typeof SavedPlaybackSchema>

export const PlaybackClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
export const SONOS_PLAYBACK_CLIENT_HEADER = 'X-Playback-Client'

export const PlaybackClientSchema = z.object({
  clientId: PlaybackClientIdSchema,
  /** How the client is named to the account's other clients. */
  name: z.string().max(80),
})
export type PlaybackClient = z.infer<typeof PlaybackClientSchema>

const sonosEncoder = new TextEncoder()
const encodedSonosSize = (value: unknown) =>
  sonosEncoder.encode(JSON.stringify(value)).byteLength

/** Driver's live Sonos display, independent of the saved queue. */
export const SharedSonosObservationSchema = z
  .object({
    target: z.discriminatedUnion('kind', [
      RoomTargetSchema,
      z.object({
        kind: z.literal('sonos'),
        name: TextSchema,
        type: TextSchema,
        group: SonosGroupControlSchema,
      }),
    ]),
    snapshot: PlaybackSnapshotSchema.nullable(),
    volume: z.number().min(0).max(1).nullable(),
  })
  .refine((observation) => encodedSonosSize(observation) <= 100_000)
export type SharedSonosObservation = z.infer<
  typeof SharedSonosObservationSchema
>

const SonosRoomsRequestIdSchema = z.number().int().nonnegative()
export const SharedSonosRoomsReportSchema = z.object({
  id: SonosRoomsRequestIdSchema.min(1),
  result: z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      rooms: SonosRoomsSchema.refine(
        (rooms) => encodedSonosSize(rooms) <= 200_000,
      ),
    }),
    z.object({ ok: z.literal(false) }),
  ]),
})
export type SharedSonosRoomsReport = z.infer<
  typeof SharedSonosRoomsReportSchema
>

export const SharedSonosRoomsStateSchema = z.object({
  requested: SonosRoomsRequestIdSchema,
  completed: SharedSonosRoomsReportSchema.nullable(),
})
export type SharedSonosRoomsState = z.infer<typeof SharedSonosRoomsStateSchema>

/**
 * One exchange with the shared session. Exactly one client at a time runs the
 * queue (the driver); it holds a short lease that each exchange renews.
 */
export const PlaybackSyncInputSchema = z
  .object({
    clientId: PlaybackClientIdSchema,
    clientName: z.string().max(80),
    /** The session revision the client has; 0 when it has none. */
    revision: z.number().int().nonnegative(),
    /** Take the lease from the client holding it. Otherwise it is taken only when free. */
    claim: z.boolean(),
    /**
     * The state to save. It is stored only when the client holds the lease
     * and `revision` is the stored one. Null clears the session.
     */
    state: SavedPlaybackSchema.nullable().optional(),
    /** The client can share Sonos data and identify its lease on Sonos requests. */
    sonosManaged: z.literal(true).optional(),
    sonosObservation: SharedSonosObservationSchema.nullable().optional(),
    /** The last room-list completion this client has seen. */
    sonosRoomsRequest: SonosRoomsRequestIdSchema.optional(),
    /** Acknowledges the cached list so unchanged results need not be returned. */
    sonosRoomsSeen: SonosRoomsRequestIdSchema.optional(),
    sonosRoomsReport: SharedSonosRoomsReportSchema.optional(),
  })
  .strict()
export type PlaybackSyncInput = z.infer<typeof PlaybackSyncInputSchema>

export const PlaybackSyncResultSchema = z.object({
  revision: z.number().int().nonnegative(),
  /** Whether the client holds the lease after this exchange. */
  role: z.enum(['driver', 'follower']),
  driver: PlaybackClientSchema.nullable(),
  /** The stored state differs from the revision the client sent. */
  changed: z.boolean(),
  /** The stored state when `changed`; otherwise null. */
  state: SavedPlaybackSchema.nullable(),
  /** Omitted by older servers. True once a driver has activated this mode. */
  sonosManaged: z.boolean().optional(),
  sonosObservation: SharedSonosObservationSchema.nullable().optional(),
  sonosRooms: SharedSonosRoomsStateSchema.optional(),
})
export type PlaybackSyncResult = z.infer<typeof PlaybackSyncResultSchema>

/** Gives the lease up when a client closes, with its last state. */
export const PlaybackReleaseInputSchema = z
  .object({
    clientId: PlaybackClientIdSchema,
    revision: z.number().int().nonnegative(),
    state: SavedPlaybackSchema.nullable().optional(),
  })
  .strict()
export type PlaybackReleaseInput = z.infer<typeof PlaybackReleaseInputSchema>

export const PlaybackReleaseResultSchema = z.object({
  released: z.boolean(),
  revision: z.number().int().nonnegative(),
})

/** How long a lease lasts without being renewed. */
export const PLAYBACK_LEASE_MS = 12_000
