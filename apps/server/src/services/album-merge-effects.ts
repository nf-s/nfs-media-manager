import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/schemas/common'
import { refreshArtistListeningTotals } from './artist-listening'
import {
  defineChangeEffect,
  type ChangeDirection,
  type ChangeEffectEntry,
  type ChangeEffectHandler,
  type ChangeReader,
  type ChangeTransaction,
} from './library-change-effect'

const ALBUM_GONE = 'An album in this change is no longer in the library.'
const EDITION_MOVED = 'An edition was regrouped since. Undo that change first.'
const NAME_MOVED =
  'A later change moved this album name. Undo that change first.'

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
const unique = (ids: (string | null)[]) => [
  ...new Set(ids.flatMap((id) => (id === null ? [] : [id]))),
]

/*
 * The modules that relink and recount reach the journal, which imports this
 * module, so they are loaded when an effect runs.
 */
async function refreshListening(tx: ChangeTransaction, albumIds: string[]) {
  const { refreshAlbumListening } = await import('./lastfm-album-links')
  await refreshAlbumListening(tx, albumIds)
}
async function relinkTrackNames(
  tx: ChangeTransaction,
  username: string,
  names: TrackNameKey[],
) {
  const { writeScrobbleTrackLinks } = await import('./track-links')
  await writeScrobbleTrackLinks(tx, username, names)
}

/* Listening values an album keeps from before its scrobbles were counted. */

const LISTENING_KEYS = [
  'scrobbles',
  'lastListenedAt',
  'scrobblesLast1y',
  'scrobblesLast5y',
]
const ListeningImageSchema = z.object({
  id: z.string(),
  values: z.record(z.string(), JsonValueSchema),
  /** The album had metadata, and browse values in it. */
  metadata: z.boolean(),
  browse: z.boolean(),
})
/** An album's stored listening browse values. */
export type AlbumListeningImage = z.infer<typeof ListeningImageSchema>
const ListeningImagesSchema = z.array(ListeningImageSchema)
const listeningKeys = sql`array[${idList(LISTENING_KEYS)}]::text[]`

/** The listening browse values of the given albums as they are now. */
export async function readAlbumListening(
  reader: ChangeReader,
  albumIds: string[],
): Promise<AlbumListeningImage[]> {
  if (!albumIds.length) return []
  return ListeningImagesSchema.parse(
    (
      await reader.execute(sql`
        select m.id, coalesce((
          select jsonb_object_agg(k, m.metadata->'browse'->k)
          from unnest(${listeningKeys}) k
          where m.metadata->'browse' ? k), '{}'::jsonb) as values,
          m.metadata is not null as metadata,
          coalesce(m.metadata ? 'browse', false) as browse
        from media_item m where m.id in (${idList(albumIds)})`)
    ).rows,
  )
}

/**
 * Recounts the albums' listening values. On undo, an album whose record has
 * no stored scrobbles again gets back the values it had before the change,
 * which a recount cannot work out.
 */
async function refreshAlbums(
  tx: ChangeTransaction,
  albumIds: string[],
  listening: AlbumListeningImage[],
  direction: ChangeDirection,
) {
  await refreshListening(tx, albumIds)
  if (direction !== 'undo' || !listening.length) return
  const browse = sql`((coalesce(m.metadata->'browse', '{}'::jsonb)
    - ${listeningKeys}) || r.values)`
  await tx.execute(sql`
    update media_item m set metadata = case
      when ${browse} <> '{}'::jsonb or r.browse
        then jsonb_set(coalesce(m.metadata, '{}'::jsonb), '{browse}', ${browse})
      when r.metadata or coalesce(m.metadata, '{}'::jsonb) - 'browse' <> '{}'::jsonb
        then coalesce(m.metadata, '{}'::jsonb) - 'browse'
      end
    from jsonb_to_recordset(${JSON.stringify(listening)}::jsonb)
      as r(id text, values jsonb, metadata boolean, browse boolean)
    where m.id = r.id
      and not exists (
        select 1 from lastfm_scrobble s where s.album_media_item_id = m.id)
      and not exists (
        select 1 from album a join lastfm_scrobble s
          on s.album_media_item_id = a.media_item_id
        where a.edition_of_id = m.id)`)
}

/* Editions: the first album an album is an edition of. */

const EditionStepSchema = z.object({
  id: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
})
/** One album's first album before and after a change; null for a first album. */
export type EditionStep = z.infer<typeof EditionStepSchema>

const EditionRowsSchema = z.array(
  z.object({ id: z.string(), edition_of_id: z.string().nullable() }),
)

/** The first album each given album is an edition of, for those that exist. */
export async function readEditionOf(reader: ChangeReader, albumIds: string[]) {
  if (!albumIds.length) return new Map<string, string | null>()
  return new Map(
    EditionRowsSchema.parse(
      (
        await reader.execute(sql`
          select media_item_id as id, edition_of_id from album
          where media_item_id in (${idList(albumIds)})`)
      ).rows,
    ).map((row) => [row.id, row.edition_of_id]),
  )
}

/** Sets the first album of each album. */
export async function writeEditionOf(
  tx: ChangeTransaction,
  values: { id: string; editionOf: string | null }[],
) {
  if (!values.length) return
  await tx.execute(sql`
    update album a set edition_of_id = r."editionOf", updated_at = now()
    from jsonb_to_recordset(${JSON.stringify(values)}::jsonb)
      as r(id text, "editionOf" text)
    where a.media_item_id = r.id`)
}

async function editionBlocker(
  reader: ChangeReader,
  steps: EditionStep[],
  direction: ChangeDirection,
) {
  const result = (step: EditionStep) =>
    direction === 'undo' ? step.from : step.to
  const ids = unique(steps.flatMap((step) => [step.id, step.from, step.to]))
  const current = await readEditionOf(reader, ids)
  if (ids.some((id) => !current.has(id))) return ALBUM_GONE
  if (
    steps.some(
      (step) =>
        current.get(step.id) !== (direction === 'undo' ? step.to : step.from),
    )
  )
    return EDITION_MOVED
  // No album may end up an edition of an edition.
  const after = new Map(current)
  for (const step of steps) after.set(step.id, result(step))
  if (
    steps.some((step) => {
      const first = result(step)
      return first !== null && after.get(first) !== null
    })
  )
    return EDITION_MOVED
  const regrouped = steps.flatMap((step) =>
    result(step) === null ? [] : [step.id],
  )
  if (!regrouped.length) return null
  const editions = IdRowsSchema.parse(
    (
      await reader.execute(sql`
        select media_item_id as id from album
        where edition_of_id in (${idList(regrouped)})
          and media_item_id not in (${idList(steps.map((step) => step.id))})
        limit 1`)
    ).rows,
  )
  return editions.length ? EDITION_MOVED : null
}

const editions = defineChangeEffect({
  type: 'album-edition',
  payload: z.object({
    steps: z.array(EditionStepSchema),
    listening: ListeningImagesSchema,
  }),
  blocker: (reader, { steps }, direction) =>
    editionBlocker(reader, steps, direction),
  async apply(tx, { steps, listening }, direction) {
    await writeEditionOf(
      tx,
      steps.map((step) => ({
        id: step.id,
        editionOf: direction === 'undo' ? step.from : step.to,
      })),
    )
    const albumIds = unique(
      steps.flatMap((step) => [step.id, step.from, step.to]),
    )
    return () => refreshAlbums(tx, albumIds, listening, direction)
  },
})

/**
 * The effect of regrouping albums as editions, written already with
 * `writeEditionOf`. `listening` is read before the change.
 */
export function albumEditionEffect(
  steps: EditionStep[],
  listening: AlbumListeningImage[],
): ChangeEffectEntry {
  return editions.entry(
    { steps, listening },
    unique(steps.flatMap((step) => [step.id, step.from, step.to])),
  )
}

/* Album names: the album a scrobbled artist and album name is linked to. */

const LinkImageSchema = z.object({
  albumId: z.string().nullable(),
  source: z.string(),
  strategy: z.string().nullable(),
  candidateIds: z.array(z.string()),
  createdAt: z.string(),
})
type LinkImage = z.infer<typeof LinkImageSchema>
const LinkRowsSchema = z.array(
  LinkImageSchema.extend({ artistKey: z.string(), albumKey: z.string() }),
)
const NameStepSchema = z.object({
  artistKey: z.string(),
  albumKey: z.string(),
  before: LinkImageSchema.nullable(),
  after: LinkImageSchema.nullable(),
  /** Scrobbles of the name that pointed at another album than its link. */
  exceptions: z.array(
    z.object({ id: z.string(), albumId: z.string().nullable() }),
  ),
})
type NameStep = z.infer<typeof NameStepSchema>
const ExceptionRowsSchema = z.array(
  z.object({
    id: z.string(),
    artistKey: z.string(),
    albumKey: z.string(),
    albumId: z.string().nullable(),
  }),
)
const TrackNameKeySchema = z.object({
  artistKey: z.string(),
  trackKey: z.string(),
})
type TrackNameKey = z.infer<typeof TrackNameKeySchema>
const RejectionSchema = z.object({
  id: z.string(),
  mediaItemId: z.string(),
  value: JsonValueSchema,
  note: z.string().nullable(),
  createdByUserId: z.string().nullable(),
})
/** An album listening rejection stored when a name is kept unlinked. */
export type AlbumNameRejection = z.infer<typeof RejectionSchema>
const IdRowsSchema = z.array(z.object({ id: z.string() }))

type NameKey = { artistKey: string; albumKey: string }
const nameId = (key: NameKey) => JSON.stringify([key.artistKey, key.albumKey])
const keysInput = (keys: NameKey[]) =>
  sql`jsonb_to_recordset(${JSON.stringify(
    keys.map(({ artistKey, albumKey }) => ({ artistKey, albumKey })),
  )}::jsonb) as k("artistKey" text, "albumKey" text)`

async function readLinks(
  reader: ChangeReader,
  username: string,
  keys: NameKey[],
  lock = false,
) {
  if (!keys.length) return new Map<string, LinkImage>()
  const rows = LinkRowsSchema.parse(
    (
      await reader.execute(sql`
        select l.artist_key as "artistKey", l.album_key as "albumKey",
          l.album_media_item_id as "albumId", l.source, l.strategy,
          l.candidate_ids as "candidateIds",
          to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as "createdAt"
        from lastfm_album_link l join ${keysInput(keys)}
          on l.artist_key = k."artistKey" and l.album_key = k."albumKey"
        where l.username = ${username}
        ${lock ? sql`for update of l` : sql``}`)
    ).rows,
  )
  return new Map(
    rows.map(({ artistKey, albumKey, ...link }) => [
      nameId({ artistKey, albumKey }),
      link,
    ]),
  )
}

const sameLink = (left: LinkImage | null, right: LinkImage | null) =>
  left === null || right === null
    ? left === right
    : left.albumId === right.albumId && left.source === right.source

/** Album names as they were before a change, read by `captureAlbumNames`. */
export type CapturedAlbumNames = {
  username: string
  keys: NameKey[]
  before: Map<string, LinkImage>
  exceptions: z.infer<typeof ExceptionRowsSchema>
  trackKeys: TrackNameKey[]
}

/**
 * Reads, and holds for the transaction, the links of scrobbled album names
 * and where their scrobbles point, before a change moves them. Pass the result
 * to `albumNameEffect` once the change is made.
 */
export async function captureAlbumNames(
  tx: ChangeTransaction,
  username: string,
  keys: NameKey[],
): Promise<CapturedAlbumNames> {
  const before = await readLinks(tx, username, keys, true)
  if (!keys.length)
    return { username, keys, before, exceptions: [], trackKeys: [] }
  const exceptions = ExceptionRowsSchema.parse(
    (
      await tx.execute(sql`
        select s.id, s.artist_key as "artistKey", s.album_key as "albumKey",
          s.album_media_item_id as "albumId"
        from lastfm_scrobble s join ${keysInput(keys)}
          on s.artist_key = k."artistKey" and s.album_key = k."albumKey"
        left join lastfm_album_link l on l.username = s.username
          and l.artist_key = s.artist_key and l.album_key = s.album_key
        where s.username = ${username}
          and s.album_media_item_id is distinct from l.album_media_item_id`)
    ).rows,
  )
  const trackKeys = z.array(TrackNameKeySchema).parse(
    (
      await tx.execute(sql`
        select distinct s.artist_key as "artistKey", s.track_key as "trackKey"
        from lastfm_scrobble s join ${keysInput(keys)}
          on s.artist_key = k."artistKey" and s.album_key = k."albumKey"
        where s.username = ${username}`)
    ).rows,
  )
  return { username, keys, before, exceptions, trackKeys }
}

/** The albums the captured names were linked to or pointed at. */
export function capturedAlbumIds(captured: CapturedAlbumNames) {
  return unique([
    ...[...captured.before.values()].map((link) => link.albumId),
    ...captured.exceptions.map((row) => row.albumId),
  ])
}

/**
 * Recounts what depends on where album names point: the track names
 * scrobbled under them, the albums' listening values and artist totals.
 */
export async function refreshAlbumNames(
  tx: ChangeTransaction,
  username: string,
  trackKeys: TrackNameKey[],
  albumIds: string[],
) {
  await relinkTrackNames(tx, username, trackKeys)
  await refreshListening(tx, albumIds)
  await refreshArtistListeningTotals(tx)
}

async function writeLinks(
  tx: ChangeTransaction,
  username: string,
  links: { key: NameKey; link: LinkImage | null }[],
) {
  const removed = links.filter(({ link }) => link === null)
  if (removed.length)
    await tx.execute(sql`
      delete from lastfm_album_link l using ${keysInput(
        removed.map(({ key }) => key),
      )}
      where l.username = ${username} and l.artist_key = k."artistKey"
        and l.album_key = k."albumKey"`)
  const kept = links.flatMap(({ key, link }) =>
    link ? [{ ...key, ...link }] : [],
  )
  if (kept.length)
    await tx.execute(sql`
      insert into lastfm_album_link (username, artist_key, album_key,
        album_media_item_id, source, strategy, candidate_ids, created_at)
      select ${username}, r."artistKey", r."albumKey", r."albumId", r.source,
        r.strategy, r."candidateIds", r."createdAt"::timestamp
      from jsonb_to_recordset(${JSON.stringify(kept)}::jsonb)
        as r("artistKey" text, "albumKey" text, "albumId" text, source text,
          strategy text, "candidateIds" jsonb, "createdAt" text)
      on conflict (username, artist_key, album_key) do update set
        album_media_item_id = excluded.album_media_item_id,
        source = excluded.source, strategy = excluded.strategy,
        candidate_ids = excluded.candidate_ids,
        created_at = excluded.created_at, updated_at = now()`)
}

async function writeRejections(
  tx: ChangeTransaction,
  rejections: AlbumNameRejection[],
  stored: boolean,
) {
  if (!rejections.length) return
  if (!stored) {
    await tx.execute(sql`
      delete from media_override
      where id in (${idList(rejections.map((row) => row.id))})`)
    return
  }
  await tx.execute(sql`
    insert into media_override (id, media_item_id, field, value, note,
      created_by_user_id)
    select r.id, r."mediaItemId", 'albumListeningLinkRejection', r.value,
      r.note, (select u.id from "user" u where u.id = r."createdByUserId")
    from jsonb_to_recordset(${JSON.stringify(rejections)}::jsonb)
      as r(id text, "mediaItemId" text, value jsonb, note text,
        "createdByUserId" text)
    where exists (select 1 from media_item m where m.id = r."mediaItemId")
    on conflict do nothing`)
}

const NamePayloadSchema = z.object({
  username: z.string(),
  steps: z.array(NameStepSchema),
  trackKeys: z.array(TrackNameKeySchema),
  rejections: z.array(RejectionSchema),
  listening: ListeningImagesSchema,
})

const stepAlbums = (steps: NameStep[]) =>
  unique(
    steps.flatMap((step) => [
      step.before?.albumId ?? null,
      step.after?.albumId ?? null,
      ...step.exceptions.map((row) => row.albumId),
    ]),
  )

const albumNames = defineChangeEffect({
  type: 'album-name',
  payload: NamePayloadSchema,
  async blocker(reader, { username, steps }, direction) {
    const restored = steps.flatMap((step) => {
      const link = direction === 'undo' ? step.before : step.after
      return link?.albumId ? [link.albumId] : []
    })
    const left = steps.flatMap((step) => {
      const link = direction === 'undo' ? step.after : step.before
      return link?.albumId ? [link.albumId] : []
    })
    const albums = await readEditionOf(reader, unique([...restored, ...left]))
    if ([...restored, ...left].some((id) => !albums.has(id))) return ALBUM_GONE
    const current = await readLinks(reader, username, steps)
    return steps.some(
      (step) =>
        !sameLink(
          current.get(nameId(step)) ?? null,
          direction === 'undo' ? step.after : step.before,
        ),
    )
      ? NAME_MOVED
      : null
  },
  async apply(
    tx,
    { username, steps, trackKeys, rejections, listening },
    direction,
  ) {
    await writeLinks(
      tx,
      username,
      steps.map((step) => ({
        key: step,
        link: direction === 'undo' ? step.before : step.after,
      })),
    )
    await tx.execute(sql`
      update lastfm_scrobble s set album_media_item_id = r."albumId"
      from jsonb_to_recordset(${JSON.stringify(
        steps.map((step) => ({
          artistKey: step.artistKey,
          albumKey: step.albumKey,
          albumId:
            (direction === 'undo' ? step.before : step.after)?.albumId ?? null,
        })),
      )}::jsonb) as r("artistKey" text, "albumKey" text, "albumId" text)
      where s.username = ${username} and s.artist_key = r."artistKey"
        and s.album_key = r."albumKey"
        and s.album_media_item_id is distinct from r."albumId"`)
    const exceptions = steps.flatMap((step) => step.exceptions)
    if (direction === 'undo' && exceptions.length)
      // A scrobble keeps no pointer to an album that has left the library.
      await tx.execute(sql`
        update lastfm_scrobble s set album_media_item_id = a.media_item_id
        from jsonb_to_recordset(${JSON.stringify(exceptions)}::jsonb)
          as r(id text, "albumId" text)
        left join album a on a.media_item_id = r."albumId"
        where s.id = r.id`)
    await writeRejections(tx, rejections, direction === 'redo')
    const albumIds = stepAlbums(steps)
    return async () => {
      await refreshAlbumNames(tx, username, trackKeys, [])
      await refreshAlbums(tx, albumIds, listening, direction)
    }
  },
})

/**
 * The effect of a change to album names captured with `captureAlbumNames`,
 * or null when no link or scrobble moved. `listening` is read before the
 * change; `rejections` are stored by the change.
 */
export async function albumNameEffect(
  tx: ChangeTransaction,
  captured: CapturedAlbumNames,
  {
    listening,
    rejections = [],
  }: {
    listening: AlbumListeningImage[]
    rejections?: AlbumNameRejection[]
  },
): Promise<ChangeEffectEntry | null> {
  const after = await readLinks(tx, captured.username, captured.keys)
  const steps = captured.keys.flatMap((key): NameStep[] => {
    const before = captured.before.get(nameId(key)) ?? null
    const now = after.get(nameId(key)) ?? null
    const exceptions = captured.exceptions
      .filter((row) => nameId(row) === nameId(key))
      .map(({ id, albumId }) => ({ id, albumId }))
    const unchanged =
      !exceptions.length &&
      (before === null || now === null
        ? before === now
        : before.albumId === now.albumId &&
          before.source === now.source &&
          before.strategy === now.strategy)
    return unchanged
      ? []
      : [
          {
            artistKey: key.artistKey,
            albumKey: key.albumKey,
            before,
            after: now,
            exceptions,
          },
        ]
  })
  if (!steps.length && !rejections.length) return null
  return albumNames.entry(
    {
      username: captured.username,
      steps,
      trackKeys: captured.trackKeys,
      rejections,
      listening,
    },
    [...stepAlbums(steps), ...rejections.map((row) => row.mediaItemId)],
  )
}

/** Joining album editions and moving scrobbled album names. */
export const albumMergeEffects: ChangeEffectHandler[] = [
  editions.handler,
  albumNames.handler,
]
