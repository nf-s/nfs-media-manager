import { z } from 'zod'
import type { BrowseField, BrowseRange, TagLevels } from '@repo/schemas/browse'
import { DeviceTrackItemSchema } from '@repo/schemas/device'
import {
  defaultListeningPeriod,
  listeningHistogramEdges,
  type ListeningHistogram,
  type ListeningPeriod,
} from '@repo/schemas/listening'
import { artistTagFallbackThreshold } from '@repo/schemas/music-tags'
import { parseMusicalKey } from '@repo/schemas/musical-keys'
import {
  TrackListItemSchema,
  trackSourceLabels,
  type TrackListItem,
  type TrackListeningHistogramQuery,
  type TrackPositionsQuery,
  type TrackQuery,
} from '@repo/schemas/tracks'
import type { SqliteExecutor } from '../driver'
import {
  equalsLabelAsServer,
  foldText,
  lowerCaseAsServer,
  type TextFold,
} from '../fold'
import type {
  BrowseCount,
  TrackListPage,
  TrackPage,
  TrackPositions,
  TrackRecordingsQuery,
} from '../source'
import {
  boundsCondition,
  checkFields,
  filterConditions,
  rangeCondition,
  readBrowseFields,
  scaledBound,
  searchFields,
  textEquals,
  textMatch,
  valueExpression,
  type FieldTable,
  type RangeSpec,
  type ValueSource,
} from '../compile/fields'
import {
  listeningHistogram,
  listeningRules,
  periodCount,
  type PlaySource,
} from '../compile/listening'
import {
  capCount,
  holdsLibraryPlaylistFilter,
  isMemberScope,
  listWindow,
  orderBy,
  orderTerm,
  pageWindow,
  positionsWithin,
} from '../compile/query'
import { searchConditions, searchWords } from '../compile/search'
import {
  EMPTY,
  FALSE,
  TRUE,
  and,
  or,
  readRows,
  sql,
  values,
  type Sql,
} from '../compile/sql'
import {
  anyTrackHasSonovaultTag,
  artistTagRawKeys,
  itemsWithArtistTagKeys,
  itemsWithTags,
  matchingTagNames,
  tagFilterName,
  tagIdsWithKeys,
} from '../compile/tags'
import { unsupported } from '../compile/unsupported'
import { formatTimestamp, readItems, type DeviceRead } from './read'

/**
 * The Tracks library on the device: the field table and the six reads
 * (DEVICE-22 to 24, 26, 27). The server's `browseQueries` and
 * `groupedTrackBrowse`, browse.ts, define every rule; comments name the
 * part of the service each piece reproduces.
 */

type TrackContext = {
  tx: SqliteExecutor
  fold: TextFold
  tagLevels: TagLevels | undefined
}

const column = (expression: Sql): ValueSource => ({
  kind: 'column',
  expression,
})
const stored = (field: string): ValueSource => ({ kind: 'sort', field })
const numeric = (field: string): ValueSource => ({ kind: 'num', field })

/** The Tags sort location as `DeviceTagLocationSchema` writes it. */
function tagLocation(levels: TagLevels | undefined): string {
  return levels === undefined ? 'auto' : levels.join(',')
}

/**
 * trackIdsWithTag(name, levels), music-tags.ts. Auto: the track's own tags;
 * its album's and its artists' (the artists' only when the album has fewer
 * than two release tags) when it has no tags of its own or no track uses the
 * tag set as an in-Browse Sonovault tag. The service asks that of every
 * library track, published or not: the tag rows' `sonovault` answers it.
 */
async function tagMatch(
  value: string,
  levels: TagLevels | undefined,
  context: TrackContext,
): Promise<Sql> {
  const names = await matchingTagNames(
    context.tx,
    tagFilterName(value, context.fold),
    'album',
  )
  const ids = await tagIdsWithKeys(context.tx, names, 'album')
  const own = itemsWithTags('track', 'ownTagIds', ids)
  const albums = itemsWithTags('track', 'albumTagIds', ids)
  const artists = async () =>
    itemsWithArtistTagKeys('track', await artistTagRawKeys(context.tx, names))
  if (levels === undefined) {
    const sparseAlbum = sql`(t.album_id IS NULL
      OR coalesce(t.album_release_tag_count, 0) < ${artistTagFallbackThreshold})`
    const inherited = or([albums, and([await artists(), sparseAlbum])])
    const inherits = (await anyTrackHasSonovaultTag(context.tx, ids))
      ? sql`t.has_own_tags = 0`
      : TRUE
    return or([own, and([inherits, inherited])])
  }
  const sets: Sql[] = []
  if (levels.includes('track')) sets.push(own)
  if (levels.includes('album')) sets.push(albums)
  if (levels.includes('artist')) sets.push(await artists())
  return or(sets)
}

const trackFields: FieldTable<TrackContext> = {
  entity: 'track',
  library: 'track',
  filters: {
    title: textMatch('track', 'title'),
    // matchesValue('source'): the label, matched with toLowerCase; another value matches nothing.
    source: (value, context) => {
      const label = Object.values(trackSourceLabels).find((candidate) =>
        equalsLabelAsServer(value, candidate, context.fold),
      )
      return label === undefined
        ? FALSE
        : textEquals('track', 'source', foldText(label, context.fold))
    },
    spotifyMatch: textMatch('track', 'spotifyMatch'),
    // trackIdsWithProvider, track-values.ts: lower(provider) = value.toLowerCase().
    provider: (value, context) =>
      textEquals(
        'track',
        'provider',
        lowerCaseAsServer(value, context.fold) ??
          unsupported('server-lower-case'),
      ),
    artist: textMatch('track', 'artist'),
    album: textMatch('track', 'album'),
    playlist: textMatch('track', 'playlist'),
    genre: (value, context) => tagMatch(value, context.tagLevels, context),
    trackTag: (value, context) => tagMatch(value, ['track'], context),
    albumTag: (value, context) => tagMatch(value, ['album'], context),
    artistTag: async (value, context) =>
      itemsWithArtistTagKeys(
        'track',
        await artistTagRawKeys(
          context.tx,
          await matchingTagNames(
            context.tx,
            tagFilterName(value, context.fold),
            'album',
          ),
        ),
      ),
    albumLink: textMatch('track', 'albumLink'),
    // hasTrackTagsMatch, browse.ts.
    hasTrackTags: (value, context) => {
      if (equalsLabelAsServer(value, 'yes', context.fold))
        return sql`t.has_own_tags = 1`
      if (equalsLabelAsServer(value, 'no', context.fold))
        return sql`t.has_own_tags = 0`
      return FALSE
    },
    // verifiedTrackKeyIds, track-facts.ts: the parsed Camelot key, compared exactly.
    musicalKey: (value, context) => {
      const key = parseMusicalKey(value)
      if (key === null) return FALSE
      return sql`t.rid IN (SELECT rid FROM item_text
        WHERE entity = 'track' AND field = 'musicalKey'
          AND folded = ${foldText(key, context.fold)} AND value = ${key})`
    },
  },
  ranges: {
    // numericExpression('releaseDate', 'track'): the track's date first.
    releaseDate: { source: numeric('releaseDate'), unit: 'date' },
    dateAdded: { source: column(sql`t.date_added`), unit: 'date' },
    durationSec: { source: numeric('durationSec'), unit: 'number' },
    bpm: { source: numeric('bpm'), unit: 'number' },
    scrobbles: { source: column(sql`t.scrobbles`), unit: 'number' },
    lastListenedAt: { source: column(sql`t.last_listened_at`), unit: 'date' },
  },
  sorts: {
    title: column(sql`t.sort_title`),
    artist: column(sql`t.sort_artist`),
    // trackAlbumSortName: the linked album's title first.
    album: column(sql`t.sort_album`),
    // directSortExpression('releaseDate'): the album's date first.
    releaseDate: column(sql`t.sort_release_date`),
    dateAdded: column(sql`t.date_added`),
    scrobbles: column(sql`t.scrobbles`),
    lastListenedAt: column(sql`t.last_listened_at`),
    durationSec: numeric('durationSec'),
    bpm: numeric('bpm'),
    musicalKey: stored('musicalKey'),
    genre: (context) => stored(`genre:${tagLocation(context.tagLevels)}`),
    artistTag: stored('artistTag'),
    trackTag: stored('trackTag'),
    albumTag: stored('albumTag'),
    playlist: stored('playlist'),
    source: stored('source'),
    provider: stored('provider'),
    spotifyMatch: stored('spotifyMatch'),
    albumLink: stored('albumLink'),
    hasTrackTags: stored('hasTrackTags'),
  },
  search: {
    fields: {
      title: { table: 'text', field: 'title' },
      source: { table: 'text', field: 'source' },
      spotifyMatch: { table: 'text', field: 'spotifyMatch' },
      artist: { table: 'text', field: 'artist' },
      album: { table: 'text', field: 'album' },
      playlist: { table: 'text', field: 'playlist' },
      albumLink: { table: 'text', field: 'albumLink' },
      trackTag: { table: 'search', field: 'trackTag' },
      albumTag: { table: 'search', field: 'albumTag' },
      artistTag: { table: 'search', field: 'artistTag' },
    },
    // browseTextSearchIds leaves these out on Tracks.
    unsearched: ['genre', 'musicalKey', 'provider', 'hasTrackTags'],
  },
}

/**
 * The plays of track `t`: every play of its scrobbled names. CROSS JOIN
 * keeps SQLite's join order, so the read starts from the track's names.
 */
const trackPlays: PlaySource = {
  plays: (where) => sql`FROM track_name tn
    CROSS JOIN play_set ps ON ps.entity = 'scrobble_name' AND ps.id = tn.name_id
    CROSS JOIN name_play p ON p.pid = ps.pid
    WHERE tn.rid = t.rid AND ${where}`,
  sets: () => sql`FROM track_name tn
    CROSS JOIN play_set ps ON ps.entity = 'scrobble_name' AND ps.id = tn.name_id
    WHERE tn.rid = t.rid`,
}

/**
 * The plays of keyed group `t` (`t.gkey`): each scrobbled name of its
 * matching members once, from `group_member_names`.
 */
const keyedGroupPlays: PlaySource = {
  plays: (where) => sql`FROM group_member_names gn
    CROSS JOIN play_set ps ON ps.entity = 'scrobble_name' AND ps.id = gn.name_id
    CROSS JOIN name_play p ON p.pid = ps.pid
    WHERE gn.gkey = t.gkey AND ${where}`,
  sets: () => sql`FROM group_member_names gn
    CROSS JOIN play_set ps ON ps.entity = 'scrobble_name' AND ps.id = gn.name_id
    WHERE gn.gkey = t.gkey`,
}

/** A group's plays in the period: a track without a key is its own group. */
function groupPeriodCount(period: ListeningPeriod, now: Date): Sql {
  return sql`CASE WHEN t.recording_key IS NULL
    THEN ${periodCount(trackPlays, period, now)}
    ELSE ${periodCount(keyedGroupPlays, period, now)} END`
}

/**
 * trackNaturalOrder, browse.ts: a prefix chosen by the primary sort, then
 * the album, the unlinked Spotify album, the position and the title, all
 * ascending with nulls last; the ID follows.
 */
function naturalOrder(sortBy: string): Sql[] {
  const prefix =
    sortBy === 'artist'
      ? [sql`t.natural_year`, sql`t.sort_album`]
      : sortBy === 'album'
        ? [sql`t.natural_album_date`]
        : sortBy === 'releaseDate'
          ? [sql`t.natural_artist`, sql`t.sort_album`]
          : [sql`t.natural_artist`, sql`t.natural_year`, sql`t.sort_album`]
  return [
    ...prefix,
    sql`t.album_id`,
    sql`t.natural_spotify_album_id`,
    sql`t.natural_position`,
    sql`t.sort_title`,
  ]
    .map((value) => orderTerm(value, 'asc'))
    .concat(sql`t.id ASC`)
}

/** Group values the grouped service ranges and sorts on: recordingGroupValue, recording-groups.ts. */
const groupValues: Record<string, RangeSpec> = {
  dateAdded: { source: column(sql`t.group_date_added`), unit: 'date' },
  scrobbles: { source: column(sql`t.group_scrobbles`), unit: 'number' },
  lastListenedAt: {
    source: column(sql`t.group_last_listened_at`),
    unit: 'date',
  },
}

type PlanOptions = {
  /** The read returns list items, which carry links for a non-exclude Provider filter. */
  returnsItems: boolean
  /** queryBrowseCounts: an unfiltered count also counts redundant placeholders. */
  includeLastfmSourceRows?: boolean
  /** The recordings of one track, as queryTrackRecordingVersions. */
  versions?: boolean
}

type TrackPlan = {
  /** Every condition on the track rows. Grouped: without the group ranges. */
  where: Sql
  /** The sort period count of row `t`, when a period applies. */
  listening: Sql | undefined
  /** Rules on the track rows (ungrouped only). */
  rules: Sql | undefined
  /** The primary value of row `t`. */
  primary: Sql
  grouped: GroupPlan | undefined
  sortBy: string
  direction: TrackQuery['direction']
}

type GroupPlan = {
  /** Group ranges and the listening rules that decide group membership. */
  predicates: Sql[]
  /** The group primary value of group `t`, when the sort uses a group value. */
  primary: Sql | undefined
  /** The sort period count of group `t`. */
  listening: Sql | undefined
}

function requestsLastfmSource(query: TrackQuery, fold: TextFold): boolean {
  return query.filters.some(
    (filter) =>
      filter.field === 'source' &&
      filter.mode !== 'exclude' &&
      equalsLabelAsServer(filter.value, trackSourceLabels.lastfm, fold),
  )
}

/**
 * Decides whether the device serves the query and builds its SQL pieces.
 * Every reason to fall through is found before a row of the result is read.
 */
async function planTracks(
  read: DeviceRead,
  query: TrackQuery,
  options: PlanOptions,
): Promise<TrackPlan> {
  if (!isMemberScope(query, 'track')) unsupported('catalog-scope')
  if (holdsLibraryPlaylistFilter(query.filters)) unsupported('library-playlist')
  const grouped = options.versions === true || query.groupRecordings === true
  if (grouped && query.creatorId !== undefined)
    unsupported('grouped-creator-scope')
  const fields: BrowseField[] = await readBrowseFields(read.tx, 'track')
  const sortPeriod: ListeningPeriod | undefined =
    query.listeningSort ??
    (query.sortBy === 'listeningScrobbles' ? defaultListeningPeriod : undefined)
  checkFields(
    trackFields,
    fields,
    query,
    sortPeriod === undefined ? [] : ['listeningScrobbles'],
  )
  if (
    options.returnsItems &&
    query.filters.some(
      (filter) => filter.field === 'provider' && filter.mode !== 'exclude',
    )
  )
    unsupported('provider-filter')
  // With a creator scope, and for one track's recordings, the service sorts
  // Tags at Auto by firstMusicTag, which drops an artist tag whose key
  // repeats a release tag; the row holds the other expression's value.
  if (
    query.sortBy === 'genre' &&
    query.tagLevels === undefined &&
    (query.creatorId !== undefined || options.versions === true)
  )
    unsupported('creator-tag-sort')
  const words = searchWords(query.q)
  const searched =
    words.length > 0 ? searchFields(trackFields, fields) : undefined

  const context: TrackContext = {
    tx: read.tx,
    fold: read.fold,
    tagLevels: query.tagLevels,
  }
  const conditions: Sql[] = [sql`t.archived = 0`]
  const hideRedundant =
    options.includeLastfmSourceRows !== true &&
    !requestsLastfmSource(query, read.fold) &&
    !query.filters.some(
      (filter) => filter.field === 'playlist' && filter.mode === 'required',
    )
  if (hideRedundant) conditions.push(sql`t.redundant_placeholder = 0`)
  if (query.creatorId !== undefined)
    conditions.push(sql`t.rid IN (SELECT rid FROM item_credit
      WHERE artist_id = ${query.creatorId} AND entity = 'track' AND role = 'artist')`)
  conditions.push(
    ...(await filterConditions(trackFields, query.filters, context)),
  )
  const groupRanges: BrowseRange[] = []
  for (const range of query.ranges) {
    if (grouped && Object.hasOwn(groupValues, range.field)) {
      groupRanges.push(range)
      continue
    }
    const spec = trackFields.ranges[range.field]
    if (spec === undefined) return unsupported('unknown-field')
    conditions.push(rangeCondition('track', range, spec))
  }
  if (searched !== undefined)
    conditions.push(...searchConditions('track', words, searched, read.fold))

  const sortSpec = trackFields.sorts[query.sortBy]
  const sortSource =
    sortSpec === undefined
      ? undefined
      : typeof sortSpec === 'function'
        ? sortSpec(context)
        : sortSpec
  const trackCount = (period: ListeningPeriod) =>
    periodCount(trackPlays, period, read.now)
  const trackListening =
    sortPeriod === undefined ? undefined : trackCount(sortPeriod)
  const primary =
    query.sortBy === 'listeningScrobbles'
      ? sql`t.listening`
      : sortSource === undefined
        ? unsupported('unknown-field')
        : valueExpression('track', sortSource)

  let groupPlan: GroupPlan | undefined
  if (grouped) {
    const groupCount = (period: ListeningPeriod) =>
      groupPeriodCount(period, read.now)
    const predicates: Sql[] = groupRanges.map((range) => {
      const spec = groupValues[range.field]
      if (spec === undefined) return unsupported('unknown-field')
      return boundsCondition(valueExpression('track', spec.source), {
        min:
          range.min === undefined
            ? undefined
            : scaledBound(range.min, spec, 'min'),
        max:
          range.max === undefined
            ? undefined
            : scaledBound(range.max, spec, 'max'),
        includeMissing: range.includeMissing,
      })
    })
    const rules = listeningRules(query.listening, groupCount)
    if (rules !== undefined) predicates.push(rules)
    const groupSort = groupValues[query.sortBy]
    groupPlan = {
      predicates,
      primary:
        query.sortBy === 'listeningScrobbles'
          ? sql`t.listening`
          : groupSort === undefined
            ? undefined
            : valueExpression('track', groupSort.source),
      listening: sortPeriod === undefined ? undefined : groupCount(sortPeriod),
    }
  }

  return {
    where: and(conditions),
    listening: trackListening,
    rules: grouped ? undefined : listeningRules(query.listening, trackCount),
    primary,
    grouped: groupPlan,
    sortBy: query.sortBy,
    direction: query.direction,
  }
}

// Statements

/** The matching track rows with the period count as `listening`. */
function matchingTracks(plan: TrackPlan): Sql {
  const listening = plan.listening ?? sql`NULL`
  return sql`(SELECT t.*, ${listening} AS listening FROM track t
    WHERE ${and([plan.where, plan.rules ?? TRUE])}) t`
}

/** The full order of ungrouped rows: primary (`title desc` puts nulls first), natural order, ID. */
function trackOrder(plan: TrackPlan): Sql[] {
  const nulls =
    plan.sortBy === 'title' && plan.direction === 'desc' ? 'first' : 'last'
  return [
    orderTerm(plan.primary, plan.direction, nulls),
    ...naturalOrder(plan.sortBy),
  ]
}

/** Grouped rows are always ordered nulls last, by the group value or the representative's. */
function groupOrder(plan: TrackPlan, group: GroupPlan): Sql[] {
  return [
    orderTerm(group.primary ?? plan.primary, plan.direction),
    ...naturalOrder(plan.sortBy),
  ]
}

/** A track's group: its recording key, or the track alone; the prefixes keep the two apart. */
const groupKey = sql`coalesce('recording:' || t.recording_key, 'track:' || t.id)`

/**
 * groupedTrackBrowse and recordingMemberships, browse.ts and
 * recording-groups.ts, over the matching tracks: a track's group is its
 * library-wide recording key, or the track alone. Each group has its
 * representative row (shown, playable, linked, earliest release, ID), its
 * matching version count, earliest addition, and scrobbles as
 * recordingListening counts them. Only tracks with a key are ranked; the
 * others are their own groups.
 *
 * `scope` narrows `members` further (one track's group).
 */
function groupStatements(plan: TrackPlan, scope?: Sql): Sql {
  const members =
    scope === undefined
      ? sql`members AS NOT MATERIALIZED (SELECT * FROM matches)`
      : sql`members AS MATERIALIZED (${scope})`
  return sql`matches AS MATERIALIZED (
      SELECT t.*, ${groupKey} AS gkey FROM track t WHERE ${plan.where}
    ),
    ${members},
    ranked AS MATERIALIZED (
      SELECT t.rid AS rid, t.gkey AS gkey,
        row_number() OVER (PARTITION BY t.gkey ORDER BY t.recording_shown DESC,
          t.recording_playable DESC, t.recording_linked DESC,
          t.recording_release_date ASC NULLS LAST, t.id) AS member_position,
        count(*) OVER (PARTITION BY t.gkey) AS version_count,
        min(t.date_added) OVER (PARTITION BY t.gkey) AS group_date_added
      FROM members t WHERE t.recording_key IS NOT NULL
    ),
    group_names AS (
      SELECT member.gkey AS gkey, tn.name_id AS name_id, min(member.id) AS member_id
      FROM members member JOIN track_name tn ON tn.rid = member.rid
      WHERE member.gkey IN (SELECT gkey FROM ranked WHERE member_position = 1 AND version_count > 1)
      GROUP BY member.gkey, tn.name_id
    ),
    group_member_names AS MATERIALIZED (
      SELECT DISTINCT member.gkey AS gkey, tn.name_id AS name_id
      FROM members member JOIN track_name tn ON tn.rid = member.rid
      WHERE member.recording_key IS NOT NULL
    ),
    name_counts AS (
      SELECT gkey, count(*) AS name_count, min(member_id) AS member_id
      FROM group_names GROUP BY gkey
    ),
    recordings AS MATERIALIZED (
      SELECT t.*,
        coalesce(r.version_count, 1) AS version_count,
        coalesce(r.group_date_added, t.date_added) AS group_date_added,
        CASE
          WHEN r.rid IS NULL THEN t.scrobbles
          WHEN r.version_count = 1 THEN coalesce(t.scrobbles, 0)
          WHEN nc.name_count = 1 THEN
            coalesce((SELECT scrobbles FROM track WHERE id = nc.member_id), 0)
          WHEN nc.name_count > 1 THEN (SELECT coalesce(sum(ps.play_count), 0)
            FROM group_names n
            JOIN play_set ps ON ps.entity = 'scrobble_name' AND ps.id = n.name_id
            WHERE n.gkey = t.gkey)
          ELSE 0
        END AS group_scrobbles,
        CASE
          WHEN r.rid IS NULL OR r.version_count = 1 THEN t.last_listened_at
          WHEN nc.name_count = 1 THEN
            (SELECT last_listened_at FROM track WHERE id = nc.member_id)
          WHEN nc.name_count > 1 THEN (SELECT max(p.played_at) * 1000000
            FROM group_names n
            JOIN play_set ps ON ps.entity = 'scrobble_name' AND ps.id = n.name_id
            JOIN name_play p ON p.pid = ps.pid
            WHERE n.gkey = t.gkey)
        END AS group_last_listened_at
      FROM members t
      LEFT JOIN ranked r ON r.rid = t.rid
      LEFT JOIN name_counts nc ON nc.gkey = t.gkey
      WHERE t.recording_key IS NULL OR r.member_position = 1
    )`
}

/** The groups that pass the group ranges and rules, with the period count as `listening`. */
function matchingGroups(group: GroupPlan): Sql {
  const listening = group.listening ?? sql`NULL`
  return sql`(SELECT t.*, ${listening} AS listening FROM recordings t
    WHERE ${and(group.predicates)}) t`
}

const PageRowSchema = z.object({
  rid: z.number().int(),
  listening: z.number().int().nonnegative().nullable(),
})
const GroupRowSchema = PageRowSchema.extend({
  version_count: z.number().int().positive(),
  group_scrobbles: z.number().nullable(),
  group_last_listened_at: z.number().nullable(),
  group_date_added: z.number().nullable(),
})
type GroupRow = z.infer<typeof GroupRowSchema>
const RankedRowSchema = GroupRowSchema.partial({
  version_count: true,
  group_scrobbles: true,
  group_last_listened_at: true,
  group_date_added: true,
}).extend({ position: z.number().int().nonnegative() })
const CountRowSchema = z.object({ total: z.number().int().nonnegative() })

const groupColumns = sql`t.rid AS rid, t.listening AS listening,
  t.version_count AS version_count, t.group_scrobbles AS group_scrobbles,
  t.group_last_listened_at AS group_last_listened_at,
  t.group_date_added AS group_date_added`

type Row = z.infer<typeof PageRowSchema> & Partial<GroupRow>

/** Rows of the query's order from `offset`, at most `limit`. */
async function readOrderedRows(
  read: DeviceRead,
  plan: TrackPlan,
  window: { offset: number; limit: number },
): Promise<Row[]> {
  if (window.limit === 0) return []
  const group = plan.grouped
  const statement =
    group === undefined
      ? sql`SELECT t.rid AS rid, t.listening AS listening FROM ${matchingTracks(plan)}
          ${orderBy(trackOrder(plan))} LIMIT ${window.limit} OFFSET ${window.offset}`
      : sql`WITH ${groupStatements(plan)}
          SELECT ${groupColumns} FROM ${matchingGroups(group)}
          ${orderBy(groupOrder(plan, group))} LIMIT ${window.limit} OFFSET ${window.offset}`
  const rows = await readRows(read.tx, statement)
  return rows.map((row) =>
    group === undefined ? PageRowSchema.parse(row) : GroupRowSchema.parse(row),
  )
}

async function readTotal(read: DeviceRead, plan: TrackPlan): Promise<number> {
  const group = plan.grouped
  const statement =
    group === undefined
      ? sql`SELECT count(*) AS total FROM track t
          WHERE ${and([plan.where, plan.rules ?? TRUE])}`
      : group.predicates.length === 0
        ? sql`WITH matches AS (SELECT ${groupKey} AS gkey
              FROM track t WHERE ${plan.where})
            SELECT count(DISTINCT gkey) AS total FROM matches`
        : sql`WITH ${groupStatements(plan)}
            SELECT count(*) AS total FROM recordings t WHERE ${and(group.predicates)}`
  const [row] = await readRows(read.tx, statement)
  return CountRowSchema.parse(row).total
}

/** The rows at zero-based positions of the order. */
async function readPositionRows(
  read: DeviceRead,
  plan: TrackPlan,
  positions: readonly number[],
): Promise<(Row & { position: number })[]> {
  if (positions.length === 0) return []
  const group = plan.grouped
  const ranked =
    group === undefined
      ? sql`SELECT t.rid AS rid, t.listening AS listening,
            row_number() OVER (${orderBy(trackOrder(plan))}) - 1 AS position
          FROM ${matchingTracks(plan)}`
      : sql`SELECT ${groupColumns},
            row_number() OVER (${orderBy(groupOrder(plan, group))}) - 1 AS position
          FROM ${matchingGroups(group)}`
  const statement = sql`${group === undefined ? EMPTY : sql`WITH ${groupStatements(plan)}`}
    SELECT * FROM (${ranked}) ranked
    WHERE position IN ${values(positions)} ORDER BY position`
  const rows = await readRows(read.tx, statement)
  return rows.map((row) => RankedRowSchema.parse(row))
}

/**
 * The list items of the rows, in order: the stored item, with the period
 * count when a sort period applies, and for a group of two or more versions
 * its totals as trackWithRecordingGroup, tracks.ts, sets them.
 */
async function trackItems(
  read: DeviceRead,
  plan: TrackPlan,
  rows: readonly Row[],
): Promise<TrackListItem[]> {
  const items = await readItems(
    read.tx,
    'track',
    rows.map((row) => row.rid),
  )
  return rows.map((row) => {
    const item = DeviceTrackItemSchema.parse(items.get(row.rid))
    const listening =
      plan.listening === undefined
        ? {}
        : { listeningScrobbles: row.listening ?? 0 }
    if (row.version_count === undefined || row.version_count < 2)
      return TrackListItemSchema.parse({ ...item, ...listening })
    return TrackListItemSchema.parse({
      ...item,
      ...listening,
      scrobbles: row.group_scrobbles ?? 0,
      lastListenedAt:
        row.group_last_listened_at === null ||
        row.group_last_listened_at === undefined
          ? null
          : formatTimestamp(row.group_last_listened_at),
      dateAdded:
        row.group_date_added === null || row.group_date_added === undefined
          ? null
          : formatTimestamp(row.group_date_added),
      recordingGroup: { versionCount: row.version_count },
    })
  })
}

/**
 * unfilteredBrowseQuery, browse.ts: the query Clear filters leaves, or null
 * when nothing is filtered.
 */
function unfilteredQuery(query: TrackQuery): TrackQuery | null {
  const filtered =
    Boolean(query.q) ||
    query.filters.length > 0 ||
    query.ranges.length > 0 ||
    query.creatorId !== undefined ||
    query.listening !== undefined
  if (!filtered) return null
  return {
    ...query,
    q: undefined,
    filters: [],
    ranges: [],
    limitResults: undefined,
    creatorId: undefined,
    listening: undefined,
  }
}

// Reads

/** `GET /tracks/browse-page`: queryBrowsePageIds and listTrackBrowsePage. */
export async function trackPage(
  read: DeviceRead,
  query: TrackQuery,
): Promise<TrackPage> {
  const plan = await planTracks(read, query, { returnsItems: true })
  const window = pageWindow(query)
  const rows = window === null ? [] : await readOrderedRows(read, plan, window)
  return {
    items: await trackItems(read, plan, rows.slice(0, query.size)),
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
}

/** `GET /tracks/browse-count`: queryBrowseCounts. */
export async function trackCount(
  read: DeviceRead,
  query: TrackQuery,
): Promise<BrowseCount> {
  const plan = await planTracks(read, query, { returnsItems: false })
  const total = await readTotal(read, plan)
  const unfiltered = unfilteredQuery(query)
  const unfilteredCount =
    unfiltered === null
      ? total
      : await readTotal(
          read,
          await planTracks(read, unfiltered, {
            returnsItems: false,
            includeLastfmSourceRows: requestsLastfmSource(query, read.fold),
          }),
        )
  return { totalCount: capCount(total, query.limitResults), unfilteredCount }
}

/** `GET /tracks/`: queryBrowseIds and listTracks. */
export async function trackList(
  read: DeviceRead,
  query: TrackQuery,
): Promise<TrackListPage> {
  const plan = await planTracks(read, query, { returnsItems: true })
  const totalCount = capCount(await readTotal(read, plan), query.limitResults)
  const rows = await readOrderedRows(read, plan, listWindow(query, totalCount))
  return {
    page: query.page,
    size: query.size,
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
    items: await trackItems(read, plan, rows),
  }
}

/** `GET /tracks/positions`: queryBrowsePositions and listTracksAtPositions; items carry no links. */
export async function trackPositions(
  read: DeviceRead,
  query: TrackPositionsQuery,
): Promise<TrackPositions> {
  const plan = await planTracks(read, query, { returnsItems: false })
  const rows = await readPositionRows(
    read,
    plan,
    positionsWithin(query.positions, query.limitResults),
  )
  const items = await trackItems(read, plan, rows)
  return {
    items: rows.flatMap((row, index) => {
      const item = items[index]
      return item === undefined ? [] : [{ position: row.position, item }]
    }),
  }
}

const HistogramRowSchema = z.object({
  listening: z.number().int().nonnegative(),
  count: z.number().int().positive(),
})

/**
 * `GET /tracks/listening-histogram`: queryListeningHistogram('track'),
 * browse.ts. The query without its listening rules and result cap, with
 * the period as its sort period; how many tracks (grouped: recording
 * groups) fall in each bar of the period's count. A bar holds the counts
 * from its edge up to the next edge; bars without items count zero.
 */
export async function trackHistogram(
  read: DeviceRead,
  { period, ...query }: TrackListeningHistogramQuery,
): Promise<ListeningHistogram> {
  const plan = await planTracks(
    read,
    {
      ...query,
      listening: undefined,
      listeningSort: period,
      sortBy: 'listeningScrobbles',
      limitResults: undefined,
      page: 1,
    },
    { returnsItems: false },
  )
  const group = plan.grouped
  const statement =
    group === undefined
      ? sql`SELECT t.listening AS listening, count(*) AS count
          FROM ${matchingTracks(plan)} GROUP BY t.listening`
      : sql`WITH ${groupStatements(plan)}
          SELECT t.listening AS listening, count(*) AS count
          FROM ${matchingGroups(group)} GROUP BY t.listening`
  const rows = (await readRows(read.tx, statement)).map((row) =>
    HistogramRowSchema.parse(row),
  )
  return listeningHistogram(listeningHistogramEdges.track, rows)
}

/**
 * `GET /tracks/:id/recordings`: readVersions in groupedTrackBrowse. The
 * matching versions of the track's group, when the group passes the group
 * ranges and rules, each sorted by its own values, nulls last.
 */
export async function trackRecordings(
  read: DeviceRead,
  { id, query }: TrackRecordingsQuery,
): Promise<TrackPage> {
  const plan = await planTracks(read, query, {
    returnsItems: true,
    versions: true,
  })
  const group = plan.grouped
  if (group === undefined) return unsupported('store-error')
  const scope = sql`SELECT * FROM matches
    WHERE gkey = (SELECT gkey FROM matches WHERE id = ${id})`
  const eligible =
    group.predicates.length === 0
      ? TRUE
      : sql`t.gkey IN (SELECT gkey FROM recordings t WHERE ${and(group.predicates)})`
  const offset = (query.page - 1) * query.size
  const listening = plan.listening ?? sql`NULL`
  const statement = sql`WITH ${groupStatements(plan, scope)}
    SELECT t.rid AS rid, t.listening AS listening
    FROM (SELECT t.*, ${listening} AS listening FROM members t WHERE ${eligible}) t
    ${orderBy([orderTerm(plan.primary, plan.direction), ...naturalOrder(plan.sortBy)])}
    LIMIT ${query.size + 1} OFFSET ${offset}`
  const rows = (await readRows(read.tx, statement)).map((row) =>
    PageRowSchema.parse(row),
  )
  return {
    items: await trackItems(read, plan, rows.slice(0, query.size)),
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
}
