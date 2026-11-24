import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type {
  LibraryChangeDetails,
  LibraryChangePart,
} from '@repo/schemas/library-changes'
import { JsonValueSchema } from '@repo/schemas/common'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import { writeArtistCredits } from './artist-names'
import { createStandaloneTracks } from './lastfm-standalone-tracks'
import {
  defineChangeEffect,
  type ChangeEffectEntry,
  type ChangeEffectHandler,
  type ChangeReader,
  type ChangeTransaction,
} from './library-change-effect'
import { matchRejectionEffects } from './library-match-rejections'
import {
  clearCatalogMediaAlias,
  setCatalogMediaAlias,
} from './catalog-discoveries'

const TRACK_GONE = 'A track in this change is no longer in the library.'
const SPOTIFY_TAKEN =
  'Another track has this Spotify track now. Undo that change first.'

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
const IdRowsSchema = z.array(z.object({ id: z.string() }))

async function presentTrackIds(reader: ChangeReader, ids: string[]) {
  if (!ids.length) return new Set<string>()
  return new Set(
    IdRowsSchema.parse(
      (
        await reader.execute(sql`
          select media_item_id as id from library_track
          where media_item_id in (${idList(ids)})`)
      ).rows,
    ).map((row) => row.id),
  )
}

/* Last.fm-only tracks that never had a row: a first import matched the name at once. */

const NameSchema = z.object({ artistKey: z.string(), trackKey: z.string() })

const standaloneTracks = defineChangeEffect({
  type: 'lastfm-standalone-tracks',
  payload: z.object({ username: z.string(), names: z.array(NameSchema) }),
  blocker: async () => null,
  async apply(tx, { username, names }, direction) {
    if (direction === 'undo') await createStandaloneTracks(tx, username, names)
    return null
  },
  restores: ({ username, names }, direction) =>
    direction === 'undo'
      ? names.map((name) => standaloneLastfmTrackId(username, name))
      : [],
})

/**
 * The effect that makes the Last.fm-only tracks of the given names on Undo,
 * for names an automatic rule matched before they had a track of their own.
 */
export function standaloneTracksEntry(
  username: string,
  names: z.infer<typeof NameSchema>[],
  recordIds: string[],
): ChangeEffectEntry {
  return standaloneTracks.entry({ username, names }, [
    ...names.map((name) => standaloneLastfmTrackId(username, name)),
    ...recordIds,
  ])
}

/* Tracks a change made or removed that hold no scrobbled names. */

const RemovedRowsSchema = z.array(z.object({ record_id: z.string() }))

/*
 * The archive reaches the album services, which reach the journal that
 * imports this module, so it is loaded when an effect runs.
 */
async function restoreTracks(
  tx: ChangeTransaction,
  changeId: string,
  ids: string[],
) {
  const { restoreRemovedTracks } = await import('./track-archive')
  const present = await presentTrackIds(tx, ids)
  await restoreRemovedTracks(
    tx,
    changeId,
    ids.filter((id) => !present.has(id)),
  )
}

/** Archives and removes the given tracks that nothing holds any more. */
async function removeUnusedTracks(
  tx: ChangeTransaction,
  changeId: string,
  ids: string[],
) {
  if (!ids.length) return
  const { archiveTracks, storeRemovals } = await import('./track-archive')
  const unused = IdRowsSchema.parse(
    (
      await tx.execute(sql`
        select mi.id from media_item mi
        where mi.id in (${idList(ids)})
          and not exists (select 1 from catalog_observation o where o.media_item_id = mi.id)
          and not exists (select 1 from catalog_addition a where a.media_item_id = mi.id)
          and not exists (select 1 from track t where t.track_media_item_id = mi.id)
          and not exists (select 1 from playlist_item p where p.media_item_id = mi.id)
          and not exists (select 1 from lastfm_track_source s
            where s.track_media_item_id = mi.id)`)
    ).rows,
  ).map((row) => row.id)
  if (!unused.length) return
  const archived = await archiveTracks(tx, unused)
  await tx.execute(sql`delete from media_item where id in (${idList(unused)})`)
  await storeRemovals(tx, changeId, archived)
}

/**
 * Remembers an undone merge of tracks that hold no scrobbled names as tracks
 * kept separate, so no automatic rule makes it again; Redo forgets it.
 */
async function rememberUndoneMerge(
  tx: ChangeTransaction,
  changeId: string,
  keptFrom: string,
  ids: string[],
  direction: 'undo' | 'redo',
) {
  const pairs = ids.map((id) =>
    keptFrom < id
      ? { lowId: keptFrom, highId: id }
      : { lowId: id, highId: keptFrom },
  )
  const input = sql`jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb)
    as r("lowId" text, "highId" text)`
  if (direction === 'undo')
    await tx.execute(sql`
      insert into library_keep_separate (kind, low_id, high_id, change_id)
      select 'track', r."lowId", r."highId", ${changeId} from ${input}
      on conflict do nothing`)
  else
    await tx.execute(sql`
      delete from library_keep_separate k using ${input}
      where k.kind = 'track' and k.low_id = r."lowId"
        and k.high_id = r."highId" and k.change_id = ${changeId}`)
}

const trackPresence = defineChangeEffect({
  type: 'automatic-track-presence',
  payload: z.object({
    ids: z.array(z.string()),
    /** The change made the tracks. False when it removed them. */
    created: z.boolean(),
    /** The track a removed one was merged into, kept separate on Undo. */
    keptFrom: z.string().nullable().default(null),
  }),
  async blocker(reader, { ids, created }, direction, { changeId }) {
    if (created === (direction === 'undo')) return null
    const present = await presentTrackIds(reader, ids)
    const missing = ids.filter((id) => !present.has(id))
    if (!missing.length) return null
    const archived = new Set(
      RemovedRowsSchema.parse(
        (
          await reader.execute(sql`
            select record_id from library_change_removal
            where change_id = ${changeId} and record_id in (${idList(missing)})`)
        ).rows,
      ).map((row) => row.record_id),
    )
    return missing.every((id) => archived.has(id)) ? null : TRACK_GONE
  },
  async apply(tx, { ids, created, keptFrom }, direction, { changeId }) {
    if (keptFrom)
      await rememberUndoneMerge(tx, changeId, keptFrom, ids, direction)
    if (created === (direction === 'redo')) {
      await restoreTracks(tx, changeId, ids)
      return null
    }
    return () => removeUnusedTracks(tx, changeId, ids)
  },
  restores: ({ ids, created }, direction) =>
    created === (direction === 'redo') ? ids : [],
})

/**
 * The effect that removes tracks the change made when it is undone, and makes
 * them again from their archive on Redo. Record it first, so Redo makes the
 * tracks before other effects move parts onto them.
 */
export const createdTracksEntry = (ids: string[]) =>
  trackPresence.entry({ ids, created: true, keptFrom: null }, ids)

/**
 * The effect that puts back tracks the change archived and removed although
 * they held no scrobbled names. Record it last, so Undo puts the tracks back
 * before other effects move parts onto them. With `keptFrom`, the track they
 * were merged into, Undo also keeps them separate from it.
 */
export const removedTracksEntry = (ids: string[], keptFrom?: string) =>
  trackPresence.entry({ ids, created: false, keptFrom: keptFrom ?? null }, [
    ...ids,
    ...(keptFrom ? [keptFrom] : []),
  ])

/* The Spotify identity a search wrote onto a track that was already there. */

const CreditImageSchema = z.object({
  artistId: z.string(),
  name: z.string(),
  billingOrder: z.number().int(),
  creditedAs: z.string().nullable(),
})
const RowImageSchema = z.object({
  inLibrary: z.boolean().optional(),
  sourceLabel: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  metadata: JsonValueSchema.nullable(),
  spotifyTrackId: z.string().nullable(),
  spotifyUrl: z.string().nullable(),
  durationSec: z.number().int().nullable(),
  isrc: z.string().nullable(),
  spotifyAlbumId: z.string().nullable(),
  albumName: z.string().nullable(),
  albumId: z.string().nullable(),
  albumStrategy: z.string().nullable(),
  credits: z.array(CreditImageSchema),
})
/** The columns a Spotify search writes on a track, with its artist credits. */
export type TrackRowImage = z.infer<typeof RowImageSchema>
const RowImagesSchema = z.array(RowImageSchema)

/** A track's identity columns and artist credits as they are now, or null. */
export async function readTrackRowImage(
  reader: ChangeReader,
  id: string,
): Promise<TrackRowImage | null> {
  const [image] = RowImagesSchema.parse(
    (
      await reader.execute(sql`
        select mi.in_library as "inLibrary",
          mi.source_label as "sourceLabel", mi.artwork_url as "artworkUrl",
          mi.metadata, lt.spotify_track_id as "spotifyTrackId",
          lt.spotify_url as "spotifyUrl", lt.duration_sec as "durationSec",
          lt.isrc, lt.spotify_album_id as "spotifyAlbumId",
          lt.album_name as "albumName", lt.album_media_item_id as "albumId",
          lt.album_link_strategy as "albumStrategy",
          coalesce((
            select jsonb_agg(jsonb_build_object('artistId', c.artist_id,
              'name', a.name, 'billingOrder', c.billing_order,
              'creditedAs', c.credited_as) order by c.billing_order, c.artist_id)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '[]'::jsonb)
            as credits
        from media_item mi join library_track lt on lt.media_item_id = mi.id
        where mi.id = ${id}`)
    ).rows,
  )
  return image ?? null
}

const sameCredits = (
  left: z.infer<typeof CreditImageSchema>[],
  right: z.infer<typeof CreditImageSchema>[],
) =>
  left.length === right.length &&
  left.every(
    (credit, index) =>
      credit.artistId === right[index]?.artistId &&
      credit.billingOrder === right[index]?.billingOrder &&
      credit.creditedAs === right[index]?.creditedAs,
  )

const text = (value: string | null) => sql`${value}::text`
const json = (value: TrackRowImage['metadata']) =>
  value === null ? sql`null::jsonb` : sql`${JSON.stringify(value)}::jsonb`

/** Sets a column to `to` only where it still holds `from`. */
const swap = (column: string, from: SQL, to: SQL) =>
  sql`${sql.identifier(column)} = case
    when ${sql.identifier(column)} is not distinct from ${from} then ${to}
    else ${sql.identifier(column)} end`

async function writeRowImage(
  tx: ChangeTransaction,
  id: string,
  from: TrackRowImage,
  to: TrackRowImage,
) {
  // A column changed since by something else keeps its newer value.
  await tx.execute(sql`
    update media_item set ${sql.join(
      [
        swap('source_label', text(from.sourceLabel), text(to.sourceLabel)),
        swap('artwork_url', text(from.artworkUrl), text(to.artworkUrl)),
        swap('metadata', json(from.metadata), json(to.metadata)),
        ...(from.inLibrary !== undefined && to.inLibrary !== undefined
          ? [
              swap(
                'in_library',
                sql`${from.inLibrary}::boolean`,
                sql`${to.inLibrary}::boolean`,
              ),
            ]
          : []),
      ],
      sql`, `,
    )}
    where id = ${id}`)
  await tx.execute(sql`
    update library_track set ${sql.join(
      [
        swap(
          'spotify_track_id',
          text(from.spotifyTrackId),
          text(to.spotifyTrackId),
        ),
        swap('spotify_url', text(from.spotifyUrl), text(to.spotifyUrl)),
        swap(
          'duration_sec',
          sql`${from.durationSec}::int`,
          sql`${to.durationSec}::int`,
        ),
        swap('isrc', text(from.isrc), text(to.isrc)),
        swap(
          'spotify_album_id',
          text(from.spotifyAlbumId),
          text(to.spotifyAlbumId),
        ),
        swap('album_name', text(from.albumName), text(to.albumName)),
      ],
      sql`, `,
    )}
    where media_item_id = ${id}`)
  // The album can have left the library since.
  await tx.execute(sql`
    update library_track set
      album_media_item_id = (select media_item_id from album
        where media_item_id = ${to.albumId}),
      album_link_strategy = case when exists (select 1 from album
        where media_item_id = ${to.albumId}) then ${to.albumStrategy} end
    where media_item_id = ${id}
      and album_media_item_id is not distinct from ${from.albumId}::text
      and album_link_strategy is not distinct from ${from.albumStrategy}::text`)
  const current = await readTrackRowImage(tx, id)
  if (current && sameCredits(current.credits, from.credits)) {
    await tx.execute(sql`
      delete from media_credit where media_item_id = ${id} and role = 'artist'`)
    await writeArtistCredits(
      tx,
      to.credits.map((credit) => ({
        mediaItemId: id,
        name: credit.name,
        role: 'artist',
        billingOrder: credit.billingOrder,
        creditedAs: credit.creditedAs,
      })),
    )
  }
}

const trackRowState = defineChangeEffect({
  type: 'track-row-state',
  payload: z.object({
    id: z.string(),
    before: RowImageSchema,
    after: RowImageSchema,
  }),
  async blocker(reader, { id, before, after }, direction) {
    const current = await readTrackRowImage(reader, id)
    if (!current) return TRACK_GONE
    const wanted = direction === 'undo' ? before : after
    if (
      wanted.spotifyTrackId === null ||
      wanted.spotifyTrackId === current.spotifyTrackId
    )
      return null
    const [taken] = IdRowsSchema.parse(
      (
        await reader.execute(sql`
          select media_item_id as id from library_track
          where spotify_track_id = ${wanted.spotifyTrackId}
            and media_item_id <> ${id}`)
      ).rows,
    )
    return taken ? SPOTIFY_TAKEN : null
  },
  async apply(tx, { id, before, after }, direction) {
    await writeRowImage(
      tx,
      id,
      direction === 'undo' ? after : before,
      direction === 'undo' ? before : after,
    )
    return null
  },
})

/**
 * The effect that puts back what a change wrote on a track's identity columns
 * and credits, or null when nothing differs.
 */
export function trackRowStateEntry(
  id: string,
  before: TrackRowImage,
  after: TrackRowImage,
): ChangeEffectEntry | null {
  return JSON.stringify(before) === JSON.stringify(after)
    ? null
    : trackRowState.entry({ id, before, after }, [id])
}

const spotifyCatalogBinding = defineChangeEffect({
  type: 'spotify-catalog-binding',
  payload: z.object({
    id: z.string(),
    aliasId: z.string(),
    spotifyId: z.string(),
    before: RowImageSchema,
    after: RowImageSchema,
  }),
  async blocker(reader, { id, aliasId, spotifyId }, direction) {
    const [tracks, result] = await Promise.all([
      presentTrackIds(reader, [id, aliasId]),
      reader.execute(sql`
        select
          (select media_item_id from library_track where spotify_track_id = ${spotifyId}) as "playable",
          (select media_item_id from catalog_media_alias where alias_id = ${aliasId}) as "destination"`),
    ])
    if (tracks.size !== 2) return TRACK_GONE
    const state = z
      .object({
        playable: z.string().nullable(),
        destination: z.string().nullable(),
      })
      .parse(result.rows[0])
    return state.playable === (direction === 'undo' ? id : aliasId) &&
      state.destination === (direction === 'undo' ? id : null)
      ? null
      : SPOTIFY_TAKEN
  },
  async apply(tx, { id, aliasId, spotifyId, before, after }, direction) {
    if (direction === 'undo') {
      await clearCatalogMediaAlias(tx, aliasId)
      await writeRowImage(tx, id, after, before)
      await tx.execute(sql`
        update library_track set spotify_track_id = ${spotifyId}
        where media_item_id = ${aliasId}`)
    } else {
      await tx.execute(sql`
        update library_track set spotify_track_id = null where media_item_id = ${aliasId}`)
      await writeRowImage(tx, id, before, after)
      await setCatalogMediaAlias(tx, aliasId, id)
    }
    return null
  },
})

export function spotifyCatalogBindingEntry(
  id: string,
  aliasId: string,
  spotifyId: string,
  before: TrackRowImage,
  after: TrackRowImage,
) {
  return spotifyCatalogBinding.entry(
    { id, aliasId, spotifyId, before, after },
    [id, aliasId],
  )
}

/* The search result an owner accepted, as stored on the search job. */

const OptionsSchema = z.record(z.string(), JsonValueSchema)
const OptionRowsSchema = z.array(z.object({ options: OptionsSchema }))

/** The given options of a job as stored now; absent keys are left out. */
export async function readJobOptions(
  reader: ChangeReader,
  jobId: string,
  keys: string[],
) {
  const [row] = OptionRowsSchema.parse(
    (
      await reader.execute(sql`
        select options from scrape_job where id = ${jobId}`)
    ).rows,
  )
  return Object.fromEntries(
    Object.entries(row?.options ?? {}).filter(([key]) => keys.includes(key)),
  )
}

const searchAcceptance = defineChangeEffect({
  type: 'spotify-search-acceptance',
  payload: z.object({
    jobId: z.string(),
    keys: z.array(z.string()),
    before: OptionsSchema,
    after: OptionsSchema,
  }),
  blocker: async () => null,
  async apply(tx, { jobId, keys, before, after }, direction) {
    await tx.execute(sql`
      update scrape_job
      set options = (options - array[${idList(keys)}]::text[]) || ${JSON.stringify(
        direction === 'undo' ? before : after,
      )}::jsonb
      where id = ${jobId}`)
    return null
  },
})

/** The effect that clears an accepted search from its job on Undo. */
export const searchAcceptanceEntry = (
  jobId: string,
  keys: string[],
  before: z.infer<typeof OptionsSchema>,
  after: z.infer<typeof OptionsSchema>,
  recordIds: string[],
) => searchAcceptance.entry({ jobId, keys, before, after }, recordIds)

const EffectSizeSchema = z.object({
  positionIds: z.array(z.unknown()).optional(),
  entries: z.array(z.unknown()).optional(),
})

/** The album positions and playlist entries effects moved, for History. */
export function membershipDetails(
  effects: ChangeEffectEntry[],
): LibraryChangeDetails | null {
  const moved = (type: string, key: 'positionIds' | 'entries') =>
    effects
      .filter((effect) => effect.type === type)
      .reduce((total, effect) => {
        const payload = EffectSizeSchema.safeParse(effect.payload)
        return total + (payload.success ? (payload.data[key]?.length ?? 0) : 0)
      }, 0)
  const counts: Partial<Record<LibraryChangePart, number>> = {}
  const positions = moved('track-position-move', 'positionIds')
  const entries = moved('track-playlist-entry-move', 'entries')
  if (positions) counts.position = positions
  if (entries) counts['playlist-entry'] = entries
  return Object.keys(counts).length ? { counts } : null
}

/** Tracks an automatic match created, removed or changed, and remembered decisions. */
export const automaticMatchEffects: ChangeEffectHandler[] = [
  standaloneTracks.handler,
  trackPresence.handler,
  trackRowState.handler,
  spotifyCatalogBinding.handler,
  searchAcceptance.handler,
  ...matchRejectionEffects,
]
