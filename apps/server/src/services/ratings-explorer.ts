import { sql, type SQL } from 'drizzle-orm'
import {
  RatingsRankingPageSchema,
  type RatingsRankingPage,
  type RatingsRankingRequest,
  type RatingsSettings,
  type RatingsSource,
} from '@repo/schemas/ratings-explorer'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  listBrowseFields,
  matchesValue,
  storedBrowseNumber,
  rejectedAlbumMetacriticIds,
} from './browse'

type Source = RatingsSource & {
  votesKey?: string
  zeroIsMissing: boolean
  weight: number
  minVotes: number
}

const personal = 'ratingImdbPersonal'
const positiveAudienceFields = new Set([
  'ratingImdbValue',
  'ratingTmdbValue',
  'ratingTrakt',
  'ratingLetterboxd',
  'ratingMetacriticUser',
  'ratingRymValue',
  'ratingDiscogsValue',
])
const criticsFields = new Set([
  'ratingMetascore',
  'ratingRt',
  'ratingMetacriticValue',
])

function group(key: string): RatingsSource['group'] {
  if (key === personal) return 'personal'
  if (criticsFields.has(key)) return 'critics'
  if (positiveAudienceFields.has(key) || key === 'ratingRtAudience')
    return 'audience'
  return 'other'
}

async function rankingSources(
  request: RatingsRankingRequest,
): Promise<Source[]> {
  const fields = await listBrowseFields(request.library)
  const overrides = new Map(
    request.settings.sources.map((setting) => [setting.key, setting]),
  )
  const sources: Source[] = []
  const seen = new Set<string>()
  for (const field of fields) {
    if (field.type !== 'number' || seen.has(field.key)) continue
    const rating =
      field.rating ??
      (field.key === personal && request.library === 'film'
        ? { scale: 10, votesKey: undefined }
        : undefined)
    if (!rating) continue
    seen.add(field.key)
    const setting = overrides.get(field.key)
    const minVotes = setting?.minVotes ?? 0
    if (minVotes > 0 && !rating.votesKey)
      throw new ServerError({
        statusCode: 422,
        message: 'This rating has no vote count',
      })
    sources.push({
      key: field.key,
      label: field.label,
      scale: rating.scale,
      hasVotes: Boolean(rating.votesKey),
      votesKey: rating.votesKey,
      group: group(field.key),
      zeroIsMissing:
        field.key === personal || positiveAudienceFields.has(field.key),
      weight: setting?.weight ?? (field.key === personal ? 0 : 1),
      minVotes,
    })
    overrides.delete(field.key)
  }
  if (overrides.size)
    throw new ServerError({ statusCode: 422, message: 'Unknown rating source' })
  if (sources.length > 64)
    throw new ServerError({
      message: 'This library exceeds the supported limit of 64 rating sources',
    })
  return sources
}

function displayFilter(request: RatingsRankingRequest) {
  const conditions: SQL[] = []
  if (request.search) {
    const search = request.search.toLowerCase()
    const role = request.library === 'film' ? 'director' : 'artist'
    conditions.push(sql`(strpos(lower(media_item.title), ${search}) > 0 or media_item.id in (
      select c.media_item_id from media_credit c join artist a on a.id = c.artist_id
      where c.role = ${role} and strpos(lower(a.name), ${search}) > 0))`)
  }
  if (request.tag)
    conditions.push(matchesValue('genre', request.tag, request.library))
  if (request.watched !== undefined)
    conditions.push(
      sql`(media_item.id in (select media_item_id from film where watched)) = ${request.watched}`,
    )
  if (request.minPlays)
    conditions.push(
      sql`coalesce(${storedBrowseNumber('scrobbles', 'album', sql`b.fields`)}, 0) >= ${request.minPlays}`,
    )
  if (request.yearFrom !== undefined)
    conditions.push(
      sql`extract(year from media_item.release_date) >= ${request.yearFrom}`,
    )
  if (request.yearTo !== undefined)
    conditions.push(
      sql`extract(year from media_item.release_date) <= ${request.yearTo}`,
    )
  return conditions.length ? sql.join(conditions, sql` and `) : sql`true`
}

function numericArray(expressions: SQL[]) {
  return sql`array[${sql.join(expressions, sql`, `)}]::numeric[]`
}

// Source keys only enter bound JSON field expressions. Array positions come
// from the registry and preserve its order, including on exact scoring ties.
function cohort(request: RatingsRankingRequest, sources: Source[]) {
  const metacriticAccepted =
    request.library === 'album'
      ? sql`media_item.id not in (${rejectedAlbumMetacriticIds()})`
      : undefined
  const storedNumber = (key: string) =>
    storedBrowseNumber(key, request.library, sql`b.fields`, metacriticAccepted)
  const raw = sources.map((source) => storedNumber(source.key))
  const votes = sources.map((source) =>
    source.votesKey ? storedNumber(source.votesKey) : sql`null`,
  )
  const clean = sources.map((source, i) => {
    const value = sql`stored.vals[${i + 1}]`
    // A zero without votes is an unrated placeholder. Positive-only sources
    // also use positive placeholder values when no votes are recorded.
    const requiresVotes = source.zeroIsMissing ? sql`true` : sql`${value} = 0`
    const placeholder = source.hasVotes
      ? sql`when ${requiresVotes} and coalesce(verified.votes[${i + 1}], 0) = 0 then null`
      : sql``
    return sql`case ${placeholder} when ${value} ${source.zeroIsMissing ? sql`>` : sql`>=`} 0
      and ${value} <= ${source.scale} then ${value} end`
  })
  const validVotes = sources.map((source, i) => {
    if (!source.hasVotes) return sql`null`
    const value = sql`stored.votes[${i + 1}]`
    return sql`case when ${value} between 0 and 9007199254740991 and trunc(${value}) = ${value}
      then ${value} end`
  })
  return sql`select media_item.id, media_item.title, extract(year from media_item.release_date)::int as year,
    ${displayFilter(request)} as matches, ${numericArray(clean)} as raw, verified.votes
    from media_item cross join lateral (
      select media_item.metadata->'browse' as fields offset 0
    ) b cross join lateral (
      select ${numericArray(raw)} as vals, ${numericArray(votes)} as votes offset 0
    ) stored cross join lateral (select ${numericArray(validVotes)} as votes offset 0) verified
    where media_item.media_type = ${request.library} and media_item.in_library
      and media_item.metadata->>'legacyHidden' is distinct from 'true'
      ${
        request.library === 'album'
          ? sql`and not exists (
        select 1 from album where album.media_item_id = media_item.id and edition_of_id is not null)`
          : sql``
      }`
}

function normalized(settings: RatingsSettings, sources: Source[]) {
  const adjusted: SQL[] = []
  const centers: SQL[] = []
  for (const [i, source] of sources.entries()) {
    const value = sql`raw[${i + 1}]`
    const n = sql`count(${value}) over ()`
    const average = sql`avg(${value}) over ()`
    if (settings.normalization === 'scale') {
      adjusted.push(sql`${value} * 100 / ${source.scale}::numeric`)
      centers.push(sql`${average} * 100 / ${source.scale}::numeric`)
    } else {
      centers.push(sql`case when ${n} > 0 then 50 end`)
      if (settings.normalization === 'standardized') {
        adjusted.push(sql`case when ${value} is not null then greatest(0, least(100,
          50 + coalesce(20 * (${value} - ${average}) / nullif(stddev_pop(${value}) over (), 0), 0))) end`)
      } else {
        // The two ends of the peer group are zero-based exclusive boundaries.
        const order = sql`(order by ${value} nulls last)`
        adjusted.push(sql`case when ${value} is not null then
          50.0 * (rank() over ${order} - 1 + count(*) over ${order}) / ${n} end`)
      }
    }
  }
  return sql`select cohort.*, ${numericArray(adjusted)} as adjusted, ${numericArray(centers)} as centers from cohort`
}

function scoreItem(settings: RatingsSettings, sources: Source[]) {
  const distance = settings.outlierDistance
  const exclude =
    distance === null
      ? sql`select * from eligibility`
      : sql`
    select e.*, case when e.reason = 'counted' and cluster.n >= 3 and cluster.near * 2 > cluster.n
      and abs(e.adjusted - cluster.median) > ${distance} then 'outlier' else e.reason end as retained
    from eligibility e cross join (
      select m.median, count(a.position) as n, count(*) filter (where abs(a.adjusted - m.median) <= ${distance}) as near
      from (select percentile_cont(0.5) within group (order by adjusted) as median
        from eligibility where reason = 'counted') m
      left join eligibility a on a.reason = 'counted' group by m.median
    ) cluster`
  // An item with no qualifying observations must still retain its missing or
  // excluded sources, including the weights and centers used for its evidence.
  const retained = distance === null ? sql`reason` : sql`retained`
  const order = sql`order by (${retained} = 'counted') desc, adjusted, position`
  const combine = settings.combine
  const ordered =
    combine === 'mean'
      ? sql`select *, ${retained} as status from retained`
      : sql`select *, ${retained} as status,
      row_number() over (${order}) as ordinal,
      count(*) filter (where ${retained} = 'counted') over () as qualified,
      sum(weight) filter (where ${retained} = 'counted') over () as total_weight,
      sum(weight) filter (where ${retained} = 'counted') over (${order} rows unbounded preceding) as cumulative
      from retained`
  const status =
    combine === 'trimmed'
      ? sql`case when status = 'counted' and qualified >= 4 and ordinal in (1, qualified)
      then 'trimmed' else status end`
      : sql`status`
  const core =
    combine === 'median'
      ? sql`(min(adjusted) filter (where used = 'counted' and cumulative * 2 >= total_weight)
          + min(adjusted) filter (where used = 'counted' and cumulative * 2 > total_weight)) / 2`
      : sql`sum(adjusted * weight) filter (where used = 'counted') /
        nullif(sum(weight) filter (where used = 'counted'), 0)`
  return sql`with eligibility as (
    select v.*, case when adjusted is null then 'missing'
      when min_votes > coalesce(votes, 0) then 'votes'
      when weight = 0 then 'disabled' else 'counted' end as reason
    from unnest(n.adjusted, n.votes, n.centers,
      ${sql.param(sources.map((s) => s.group))}::text[], ${sql.param(sources.map((s) => s.weight))}::numeric[],
      ${sql.param(sources.map((s) => s.minVotes))}::numeric[])
      with ordinality as v(adjusted, votes, center, source_group, weight, min_votes, position)
    ), retained as (${exclude}), ordered as (${ordered}), classified as (
      select *, ${status} as used from ordered
    )
    select array_agg(used order by position) as statuses,
      count(*) filter (where status = 'counted')::int as counted,
      ${core} as core,
      case when count(*) filter (where status = 'counted') >= 2 then
        stddev_pop(adjusted) filter (where status = 'counted') end as spread,
      avg(adjusted) filter (where reason not in ('missing','votes') and source_group = 'critics')
        - avg(adjusted) filter (where reason not in ('missing','votes') and source_group = 'audience') as critic_gap,
      max(adjusted) filter (where source_group = 'personal') as mine,
      coalesce(sum(weight) filter (where status = 'counted'), 0) as observed_weight,
      ${settings.missingWeight}::numeric * coalesce(sum(weight) filter (where status <> 'counted' and center is not null), 0) as missing_weight,
      ${settings.missingWeight}::numeric * coalesce(sum(weight * center) filter (where status <> 'counted'), 0) as missing_sum
    from classified`
}

function sortExpression(request: RatingsRankingRequest, sources: Source[]) {
  switch (request.sort) {
    case 'score':
      return sql`score`
    case 'spread':
      return sql`spread`
    case 'counted':
      return sql`counted`
    case 'year':
      return sql`year`
    case 'title':
      return sql`lower(title)`
    case 'criticGap':
      return sql`critic_gap`
    case 'personalGap':
      if (request.library === 'film') return sql`mine - score`
      break
    default: {
      const index = sources.findIndex((source) => source.key === request.sort)
      if (index >= 0) return sql`raw[${index + 1}]`
    }
  }
  throw new ServerError({
    statusCode: 422,
    message: 'Unknown rating sort field',
  })
}

export async function rankRatings(
  request: RatingsRankingRequest,
): Promise<RatingsRankingPage> {
  const sources = await rankingSources(request)
  const order = sql`${sortExpression(request, sources)} ${request.direction === 'asc' ? sql`asc` : sql`desc`} nulls last, id asc`
  const keys = sql`${sql.param(sources.map((s) => s.key))}::text[]`
  const result =
    await db.execute(sql`with cohort as materialized (${cohort(request, sources)}),
    normalized as (${normalized(request.settings, sources)}),
    combined as (
      select n.*, s.*, case when s.counted >= ${request.settings.minSources} then
        (s.core * s.observed_weight + s.missing_sum) / nullif(s.observed_weight + s.missing_weight, 0)
        end as score
      from normalized n cross join lateral (${scoreItem(request.settings, sources)}) s where n.matches
    ), eligible as materialized (
      select * from combined ${request.scoredOnly ? sql`where score is not null` : sql``}
    ), page as (select * from eligible order by ${order} limit ${request.limit} offset ${request.offset})
    select (select count(*)::int from eligible) as total, coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'year', year, 'score', score, 'core', core, 'spread', spread,
      'counted', counted, 'criticGap', critic_gap, 'personalGap', mine - score,
      'observedWeight', observed_weight, 'missingWeight', missing_weight, 'missingSum', missing_sum,
      'ratings', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'raw', val,
        'adjusted', adj, 'votes', v, 'center', c, 'status', status) order by pos), '[]'::jsonb)
        from unnest(${keys}, raw, adjusted, votes, centers, statuses)
          with ordinality as observation(key, val, adj, v, c, status, pos))
    ) order by ${order}), '[]'::jsonb) as rows from page`)
  return RatingsRankingPageSchema.parse({ ...result.rows[0], sources })
}
