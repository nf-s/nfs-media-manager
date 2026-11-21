import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  TrackMergeCautionSchema,
  type TrackMergeCaution,
} from '@repo/schemas/library-changes'
import type { TrackDuplicateRule } from '@repo/schemas/track-duplicates'
import { createStableId } from '@/lib/media-utils'
import { trackMatchKeys } from '@/lib/track-matching'
import { mediaItem } from '@/schemas/db'
import { readKeptSeparate } from './keep-separate-effects'
import type { ChangeTransaction } from './library-change-effect'
import { readTrackMergeOutlines } from './track-merge-plan'

/** The most tracks one group can hold. Larger clusters are split. */
const TRACK_DUPLICATE_GROUP_LIMIT = 12

// Bump when the rules change, so the next maintenance tick rebuilds.
const RULES_VERSION = 1
/** Groups built by another role or other rules are rebuilt. */
export const trackDuplicateBuilder = sql`current_user || ':track-duplicates-' || ${String(RULES_VERSION)}::text`

// Larger buckets of one artist and title are joined in a chain from the most
// played track, not pair by pair.
const PAIRWISE_BUCKET_LIMIT = 24
/**
 * The most new groups one rebuild of the whole library plans a merge for, so
 * that the work of one scheduled invocation is bounded. The groups left over
 * are planned by the rebuilds that follow.
 */
export const TRACK_DUPLICATE_PLAN_LIMIT = 2000
// Rows in one statement. Each statement is a round trip from the Worker.
const WRITE_BATCH = 2000
const EVIDENCE_LIMIT = 3

/** Holds the published groups while one transaction rewrites them. */
export const lockTrackDuplicates = sql`hashtextextended(current_schema() || ':track_duplicates', 0)`

/** Tracks in a published group. For Browse's Possible duplicates view. */
export const trackDuplicateMembership = sql`${mediaItem.id} in (select track_id from track_duplicate_member)`

/** Group order first: most played group, then the track a merge keeps. */
export const trackDuplicateOrder = sql`(select g.rank from track_duplicate_member m
  join track_duplicate_group g on g.id = m.group_id
  where m.track_id = ${mediaItem.id}) asc nulls last`
export const trackDuplicatePosition = sql`(select m.position from track_duplicate_member m
  where m.track_id = ${mediaItem.id}) asc nulls last`

const CandidateRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artist: z.string().nullable(),
    version_group_id: z.string().nullable(),
    scrobbles: z.number().int().nonnegative(),
    artist_key: z.string().nullable(),
    version_key: z.string().nullable(),
    plain_key: z.string().nullable(),
  }),
)
type Candidate = {
  id: string
  title: string
  versionGroupId: string | null
  scrobbles: number
  artistKey: string
  versionKey: string
  plainKey: string
}

const LinkRowsSchema = z.array(
  z.object({ owner_id: z.string(), linked_id: z.string() }),
)
const IdRowsSchema = z.array(z.object({ id: z.string() }))
const StoredGroupsSchema = z.array(
  z.object({
    id: z.string(),
    cautions: z.array(TrackMergeCautionSchema),
    members: z.array(z.string()),
  }),
)

type Edge = { low: string; high: string; link: boolean; ownerId?: string }

const pairKey = (left: string, right: string) =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`

const idsParam = (ids: string[]) => sql`${sql.param(ids)}::text[]`

/** Library tracks the view can list, with their stored keys. */
async function readCandidates(
  tx: ChangeTransaction,
  ids?: string[],
): Promise<Candidate[]> {
  const rows = CandidateRowsSchema.parse(
    (
      await tx.execute(sql`
        select lt.media_item_id as id, mi.title,
          (select a.name from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'
            order by c.billing_order, a.id limit 1) as artist,
          lt.version_group_id, lt.scrobble_count as scrobbles,
          k.artist_key, k.version_key, k.plain_key
        from library_track lt join media_item mi on mi.id = lt.media_item_id
        left join track_match_key k on k.track_id = lt.media_item_id
        where mi.media_type = 'track'
          and mi.metadata->>'legacyHidden' is distinct from 'true'
          ${ids ? sql`and lt.media_item_id = any(${idsParam(ids)})` : sql``}`)
    ).rows,
  )
  const changed: Candidate[] = []
  const candidates = rows.map((row) => {
    const keys = trackMatchKeys(
      row.title,
      row.artist === null ? [] : [row.artist],
    )
    const candidate = {
      id: row.id,
      title: row.title,
      versionGroupId: row.version_group_id,
      scrobbles: row.scrobbles,
      ...keys,
    }
    if (
      row.artist_key !== keys.artistKey ||
      row.version_key !== keys.versionKey ||
      row.plain_key !== keys.plainKey
    )
      changed.push(candidate)
    return candidate
  })
  for (let start = 0; start < changed.length; start += WRITE_BATCH)
    await tx.execute(sql`
      insert into track_match_key (track_id, artist_key, version_key, plain_key)
      select id, "artistKey", "versionKey", "plainKey"
      from jsonb_to_recordset(${JSON.stringify(
        changed
          .slice(start, start + WRITE_BATCH)
          .map(({ id, artistKey, versionKey, plainKey }) => ({
            id,
            artistKey,
            versionKey,
            plainKey,
          })),
      )}::jsonb) as r(id text, "artistKey" text, "versionKey" text,
        "plainKey" text)
      on conflict (track_id) do update set artist_key = excluded.artist_key,
        version_key = excluded.version_key, plain_key = excluded.plain_key`)
  return candidates
}

/**
 * Names one track owns that already count towards another. An exact link
 * counts when the name is linked exactly to more than one track; with one,
 * the owner is already hidden behind the track it links to.
 */
async function readLinkEdges(tx: ChangeTransaction, ids?: string[]) {
  return LinkRowsSchema.parse(
    (
      await tx.execute(sql`
        select distinct s.track_media_item_id as owner_id,
          l.track_media_item_id as linked_id
        from lastfm_track_source s
        join lastfm_track_link l on l.username = s.username
          and l.artist_key = s.artist_key and l.track_key = s.track_key
        where l.track_media_item_id <> s.track_media_item_id
          and (l.strategy in ('normalized', 'version', 'album')
            or (l.strategy = 'exact' and (
              select count(*) from lastfm_track_link x
              where x.username = l.username and x.artist_key = l.artist_key
                and x.track_key = l.track_key and x.strategy = 'exact') > 1))
          ${
            ids
              ? sql`and (s.track_media_item_id = any(${idsParam(ids)})
                  or l.track_media_item_id = any(${idsParam(ids)}))`
              : sql``
          }`)
    ).rows,
  )
}

/** Tracks that share a first artist and title key with the given keys. */
async function readKeyNeighbours(tx: ChangeTransaction, tracks: Candidate[]) {
  const keys = tracks
    .filter((track) => track.artistKey && track.versionKey)
    .map(({ artistKey, versionKey }) => ({ artistKey, versionKey }))
  if (!keys.length) return []
  return IdRowsSchema.parse(
    (
      await tx.execute(sql`
        select k.track_id as id from track_match_key k
        join jsonb_to_recordset(${JSON.stringify(keys)}::jsonb)
          as r("artistKey" text, "versionKey" text)
          on k.artist_key = r."artistKey" and k.version_key = r."versionKey"`)
    ).rows,
  ).map((row) => row.id)
}

/** Every track in a published group with one of the given tracks. */
async function readGroupMates(tx: ChangeTransaction, ids: string[]) {
  if (!ids.length) return []
  return IdRowsSchema.parse(
    (
      await tx.execute(sql`
        select m.track_id as id from track_duplicate_member m
        where m.group_id in (select group_id from track_duplicate_member
          where track_id = any(${idsParam(ids)}))`)
    ).rows,
  ).map((row) => row.id)
}

function keyEdges(candidates: Candidate[]): Edge[] {
  const buckets = new Map<string, Candidate[]>()
  for (const track of candidates) {
    if (!track.artistKey || !track.versionKey) continue
    const key = `${track.artistKey}\u0000${track.versionKey}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(track)
    else buckets.set(key, [track])
  }
  const edges: Edge[] = []
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    const sorted = [...bucket].sort(
      (left, right) =>
        right.scrobbles - left.scrobbles || left.id.localeCompare(right.id),
    )
    sorted.forEach((track, index) => {
      const partners =
        sorted.length <= PAIRWISE_BUCKET_LIMIT
          ? sorted.slice(index + 1)
          : sorted.slice(index + 1, index + 2)
      for (const other of partners)
        edges.push({ low: track.id, high: other.id, link: false })
    })
  }
  // Exact titles join before titles that only agree without notes.
  const plain = new Map(candidates.map((track) => [track.id, track.plainKey]))
  return edges.sort(
    (left, right) =>
      Number(plain.get(left.low) !== plain.get(left.high)) -
      Number(plain.get(right.low) !== plain.get(right.high)),
  )
}

async function readExclusions(tx: ChangeTransaction, ids: string[]) {
  const pairs = new Set<string>()
  for (let start = 0; start < ids.length; start += WRITE_BATCH)
    for (const { lowId, highId } of await readKeptSeparate(
      tx,
      'track',
      ids.slice(start, start + WRITE_BATCH),
      { others: true },
    ))
      pairs.add(pairKey(lowId, highId))
  return pairs
}

/**
 * Joins tracks along the edges, strongest first. Two clusters are not joined
 * when the result would be too large, would hold a pair the owner keeps
 * separate, or two versions of one record.
 */
function joinDuplicateClusters(
  ids: string[],
  edges: Pick<Edge, 'low' | 'high'>[],
  apart: (left: string, right: string) => boolean,
  limit = TRACK_DUPLICATE_GROUP_LIMIT,
) {
  const clusters = new Map(ids.map((id) => [id, [id]]))
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (id: string): string => {
    const up = parent.get(id) ?? id
    if (up === id) return id
    const root = find(up)
    parent.set(id, root)
    return root
  }
  for (const { low, high } of edges) {
    const left = find(low)
    const right = find(high)
    if (left === right) continue
    const leftMembers = clusters.get(left) ?? []
    const rightMembers = clusters.get(right) ?? []
    if (!leftMembers.length || !rightMembers.length) continue
    if (leftMembers.length + rightMembers.length > limit) continue
    if (leftMembers.some((a) => rightMembers.some((b) => apart(a, b)))) continue
    parent.set(right, left)
    clusters.set(left, [...leftMembers, ...rightMembers])
    clusters.delete(right)
  }
  return [...clusters.values()].filter((members) => members.length > 1)
}

/** The longer title's note after the shorter title, as written. */
function droppedNote(left: string, right: string) {
  const [short, long] =
    left.length <= right.length ? [left, right] : [right, left]
  if (!long.toLowerCase().startsWith(short.trim().toLowerCase())) return null
  const note = long
    .slice(short.trim().length)
    .replace(/^[\s\-–—:([]+/, '')
    .replace(/[\s)\]]+$/, '')
    .trim()
  return note || null
}

function describeGroup(
  members: Candidate[],
  edges: Edge[],
): { rule: TrackDuplicateRule; evidence: string[] } {
  const inGroup = new Set(members.map((track) => track.id))
  const byId = new Map(members.map((track) => [track.id, track]))
  const own = edges.filter(
    (edge) => inGroup.has(edge.low) && inGroup.has(edge.high),
  )
  const evidence: string[] = []
  const linked = new Map<string, Set<string>>()
  for (const edge of own)
    if (edge.link && edge.ownerId) {
      const reached = linked.get(edge.ownerId) ?? new Set([edge.ownerId])
      reached.add(edge.low).add(edge.high)
      linked.set(edge.ownerId, reached)
    }
  for (const [ownerId, reached] of linked) {
    const owner = byId.get(ownerId)
    if (!owner) continue
    const towards =
      reached.size === members.length && members.length === 2
        ? 'both'
        : `${reached.size} of these`
    evidence.push(`Scrobbles of “${owner.title}” count towards ${towards}`)
  }
  const keyed = own.filter((edge) => !edge.link)
  const titles = keyed.flatMap((edge) => {
    const left = byId.get(edge.low)
    const right = byId.get(edge.high)
    return left && right ? [[left, right] as const] : []
  })
  if (titles.some(([left, right]) => left.plainKey === right.plainKey))
    evidence.push('Same title and artist')
  const notes = titles.flatMap(([left, right]) =>
    left.plainKey === right.plainKey
      ? []
      : [droppedNote(left.title, right.title)],
  )
  if (notes.length) {
    if (!evidence.includes('Same title and artist'))
      evidence.push('Same artist')
    for (const note of notes)
      evidence.push(
        note
          ? `Same title without “${note}”`
          : 'Same title without credits or remaster notes',
      )
  }
  return {
    rule: linked.size ? 'link' : 'key',
    evidence: [...new Set(evidence)].slice(0, EVIDENCE_LIMIT),
  }
}

type GroupDraft = {
  id: string
  rule: TrackDuplicateRule
  evidence: string[]
  cautions: TrackMergeCaution[]
  members: string[]
  scrobbles: number
}

async function readStoredGroups(tx: ChangeTransaction, ids?: string[]) {
  return StoredGroupsSchema.parse(
    (
      await tx.execute(sql`
        select g.id, g.cautions, array_agg(m.track_id order by m.position) as members
        from track_duplicate_group g
        join track_duplicate_member m on m.group_id = g.id
        ${
          ids
            ? sql`where g.id in (select group_id from track_duplicate_member
                where track_id = any(${idsParam(ids)}))`
            : sql``
        }
        group by g.id`)
    ).rows,
  )
}

/**
 * The groups to publish, and how many clusters wait for a later rebuild
 * because `planLimit` new plans were already worked out. The clusters with
 * the most scrobbles are planned first.
 */
async function buildGroups(
  tx: ChangeTransaction,
  candidates: Candidate[],
  links: { owner_id: string; linked_id: string }[],
  stored: z.infer<typeof StoredGroupsSchema>,
  planLimit = Number.POSITIVE_INFINITY,
) {
  const known = new Set(candidates.map((track) => track.id))
  const linkEdges: Edge[] = links
    .filter((row) => known.has(row.owner_id) && known.has(row.linked_id))
    .map((row) => ({
      low: row.owner_id,
      high: row.linked_id,
      link: true,
      ownerId: row.owner_id,
    }))
  const edges = [...linkEdges, ...keyEdges(candidates)]
  const touched = [...new Set(edges.flatMap((edge) => [edge.low, edge.high]))]
  const separate = await readExclusions(tx, touched)
  const versionGroup = new Map(
    candidates.map((track) => [track.id, track.versionGroupId]),
  )
  const clusters = joinDuplicateClusters(touched, edges, (left, right) => {
    const version = versionGroup.get(left)
    return (
      separate.has(pairKey(left, right)) ||
      (version !== null &&
        version !== undefined &&
        version === versionGroup.get(right))
    )
  })
  const byId = new Map(candidates.map((track) => [track.id, track]))
  const previous = new Map(stored.map((group) => [group.id, group]))
  const drafts = clusters
    .map((cluster) => {
      const members = cluster.flatMap((trackId) => {
        const track = byId.get(trackId)
        return track ? [track] : []
      })
      return {
        id: createStableId(
          'track-duplicate',
          JSON.stringify([...cluster].sort()),
        ),
        cluster,
        members,
        scrobbles: Math.max(...members.map((track) => track.scrobbles)),
      }
    })
    .sort(
      (left, right) =>
        right.scrobbles - left.scrobbles || left.id.localeCompare(right.id),
    )
  // A group whose tracks are unchanged keeps the plan worked out for it.
  const unplanned = drafts.filter((draft) => !previous.has(draft.id))
  const planning = unplanned.slice(0, planLimit)
  const outlines = await readTrackMergeOutlines(
    tx,
    planning.map((draft) => draft.cluster),
  )
  const planned = new Map(
    planning.map((draft, index) => [draft.id, outlines[index] ?? null]),
  )
  const groups: GroupDraft[] = []
  for (const { id, members, scrobbles } of drafts) {
    const kept = previous.get(id)
    const outline = planned.get(id)
    // A track the plan cannot read is not offered for a merge.
    const plan = kept ?? (outline && { ...outline, members: outline.trackIds })
    if (!plan) continue
    groups.push({
      id,
      ...describeGroup(members, edges),
      cautions: plan.cautions,
      members: plan.members,
      scrobbles,
    })
  }
  return { groups, waiting: unplanned.length - planning.length }
}

async function publishGroups(
  tx: ChangeTransaction,
  groups: GroupDraft[],
  replaced: string[] | 'all',
) {
  if (replaced === 'all')
    await tx.execute(sql`delete from track_duplicate_group`)
  else if (replaced.length)
    await tx.execute(
      sql`delete from track_duplicate_group where id = any(${idsParam(replaced)})`,
    )
  for (let start = 0; start < groups.length; start += WRITE_BATCH) {
    const batch = groups.slice(start, start + WRITE_BATCH)
    await tx.execute(sql`
      insert into track_duplicate_group
        (id, rule, evidence, cautions, member_count, scrobbles, rank)
      select id, rule, evidence, cautions, member_count, scrobbles, 0
      from jsonb_to_recordset(${JSON.stringify(
        batch.map((group) => ({
          id: group.id,
          rule: group.rule,
          evidence: group.evidence,
          cautions: group.cautions,
          member_count: group.members.length,
          scrobbles: group.scrobbles,
        })),
      )}::jsonb) as r(id text, rule text, evidence jsonb, cautions jsonb,
        member_count int, scrobbles int)`)
    await tx.execute(sql`
      insert into track_duplicate_member (group_id, track_id, position)
      select group_id, track_id, position
      from jsonb_to_recordset(${JSON.stringify(
        batch.flatMap((group) =>
          group.members.map((trackId, position) => ({
            group_id: group.id,
            track_id: trackId,
            position,
          })),
        ),
      )}::jsonb) as r(group_id text, track_id text, position int)`)
  }
  await tx.execute(sql`
    update track_duplicate_group g set rank = r.rank
    from (select id, (row_number() over (order by scrobbles desc, id))::int as rank
      from track_duplicate_group) r
    where r.id = g.id and g.rank <> r.rank`)
}

/**
 * Every group, worked out again from the whole library. Returns the number
 * published and the number that wait for the next rebuild.
 */
async function rebuildAll(tx: ChangeTransaction) {
  await tx.execute(sql`
    delete from track_match_key k using media_item mi
    where mi.id = k.track_id and (mi.media_type <> 'track'
      or mi.metadata->>'legacyHidden' is not distinct from 'true')`)
  const candidates = await readCandidates(tx)
  const { groups, waiting } = await buildGroups(
    tx,
    candidates,
    await readLinkEdges(tx),
    await readStoredGroups(tx),
    TRACK_DUPLICATE_PLAN_LIMIT,
  )
  await publishGroups(tx, groups, 'all')
  return { published: groups.length, waiting }
}

/**
 * The groups around the given tracks, worked out again: the groups they are
 * in, and the tracks their keys and scrobbled names point to.
 */
async function rebuildAround(tx: ChangeTransaction, trackIds: string[]) {
  const first = [
    ...new Set([...trackIds, ...(await readGroupMates(tx, trackIds))]),
  ]
  const near = await readCandidates(tx, first)
  const neighbours = [
    ...(await readKeyNeighbours(tx, near)),
    ...(await readLinkEdges(tx, first)).flatMap((row) => [
      row.owner_id,
      row.linked_id,
    ]),
  ]
  const scope = [
    ...new Set([
      ...first,
      ...neighbours,
      ...(await readGroupMates(tx, neighbours)),
    ]),
  ]
  const stored = await readStoredGroups(tx, scope)
  const candidates = await readCandidates(tx, scope)
  const inScope = new Set(scope)
  const links = (await readLinkEdges(tx, scope)).filter(
    (row) => inScope.has(row.owner_id) && inScope.has(row.linked_id),
  )
  const { groups } = await buildGroups(tx, candidates, links, stored)
  await publishGroups(
    tx,
    groups,
    stored.map((group) => group.id),
  )
  await tx.execute(sql`
    update track_duplicate_state
    set group_count = (select count(*) from track_duplicate_group)
    where singleton and group_count is not null`)
}

/**
 * Works out the possible duplicates again in the caller's transaction. With
 * `trackIds`, only the groups around those tracks, as an owner's change
 * needs before its request returns; without, every group. A rebuild of every
 * group that left some unplanned asks for the next one with a marker.
 */
export async function refreshTrackDuplicates(
  tx: ChangeTransaction,
  scope?: { trackIds: string[] },
) {
  await tx.execute(sql`select pg_advisory_xact_lock(${lockTrackDuplicates})`)
  if (scope) {
    if (scope.trackIds.length) await rebuildAround(tx, scope.trackIds)
    return
  }
  const { published, waiting } = await rebuildAll(tx)
  await tx.execute(sql`
    insert into track_duplicate_state (singleton, builder, group_count)
    values (true, ${trackDuplicateBuilder}, ${published})
    on conflict (singleton) do update set builder = excluded.builder,
      group_count = excluded.group_count`)
  if (waiting > 0)
    await tx.execute(sql`
      insert into track_duplicate_dirty (transaction_id)
      values (txid_current()) on conflict do nothing`)
}
