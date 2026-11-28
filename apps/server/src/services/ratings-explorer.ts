import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  RatingsRankingPageSchema,
  RatingsSourcesPageSchema,
  type RatingsRankingPage,
  type RatingsRankingRequest,
  type RatingsSettings,
  type RatingsSource,
  type RatingsSourcesPage,
  type RatingsSourcesRequest,
} from '@repo/schemas/ratings-explorer'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { artistTagsForItems } from './music-tags'
import { listBrowseFields, matchesValue } from './browse'
import {
  rejectedAlbumMetacriticIds,
  storedBrowseNumber,
} from './browse-expressions'

export type Source = RatingsSource & {
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

export async function rankingSources(
  request: RatingsSourcesRequest,
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
      shortLabel: field.rating?.shortLabel,
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

function displayFilter(request: RatingsSourcesRequest) {
  const conditions: SQL[] = []
  if (request.search) {
    const search = request.search.toLowerCase()
    const role = request.library === 'film' ? 'director' : 'artist'
    conditions.push(sql`(strpos(lower(media_item.title), ${search}) > 0 or media_item.id in (
      select c.media_item_id from media_credit c join artist a on a.id = c.artist_id
      where c.role = ${role} and strpos(lower(a.name), ${search}) > 0))`)
  }
  if (request.tag)
    conditions.push(
      matchesValue(request.tagField ?? 'genre', request.tag, request.library),
    )
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
function cohort(request: RatingsSourcesRequest, sources: Source[]) {
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
          ? sql`and media_item.id not in (
        select media_item_id from album where edition_of_id is not null)`
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
      avg(adjusted) filter (where reason not in ('missing','votes') and source_group = 'critics') as critics,
      avg(adjusted) filter (where reason not in ('missing','votes') and source_group = 'audience') as audience,
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
      if (index >= 0)
        return request.adjustedSort
          ? sql`adjusted[${index + 1}]`
          : sql`raw[${index + 1}]`
    }
  }
  throw new ServerError({
    statusCode: 422,
    message: 'Unknown rating sort field',
  })
}

export function scoringCtes(
  request: RatingsSourcesRequest,
  sources: Source[],
  itemId?: string,
) {
  return sql`cohort as materialized (${cohort(request, sources)}),
    normalized as (${normalized(request.settings, sources)}),
    combined as (
      select n.*, s.*, s.critics - s.audience as critic_gap, case when s.counted >= ${request.settings.minSources} then
        (s.core * s.observed_weight + s.missing_sum) / nullif(s.observed_weight + s.missing_weight, 0)
        end as score
      from normalized n cross join lateral (${scoreItem(request.settings, sources)}) s where n.matches
      ${itemId === undefined ? sql`` : sql`and n.id = ${itemId}`}
    ), matching as (
      select * from combined ${request.scoredOnly ? sql`where score is not null` : sql``}
    )`
}

export function ratingsLibraryStats(sources: Source[]) {
  return sql`select count(*)::int as library_total, array[${sql.join(
    sources.map((_, i) => sql`count(raw[${i + 1}])::int`),
    sql`, `,
  )}]::int[] as recorded from cohort`
}

export function attachRatingsCoverage(sources: Source[], recorded: unknown) {
  const counts = z
    .array(z.number().int().nonnegative())
    .length(sources.length)
    .parse(recorded)
  return sources.map((source, index) => ({
    ...source,
    recorded: counts[index],
  }))
}

function continuousDimension(dimension: string, value: SQL, scale: number) {
  const edge = (i: number) => sql`${scale}::numeric * ${i}::int / 10`
  const bins = Array.from({ length: 10 }, (_, i) => ({
    lower: edge(i),
    upper: dimension === 'spread' && i === 9 ? sql`50` : edge(i + 1),
    upperInclusive: i === 9,
  }))
  // width_bucket is strict on NULL and otherwise uses half-open intervals.
  // Include the scale maximum in the final bin, including a perfect score.
  const bucket = sql`case when ${value} >= ${scale}::numeric then 9
    else width_bucket(${value}, 0::numeric, ${scale}::numeric, 10) - 1 end`
  return { dimension, bucket, bins }
}

export function histogramDimensions(sources: Source[]) {
  const weighted = sources.filter(({ weight }) => weight > 0).length
  const countBins = Array.from({ length: weighted + 1 }, (_, i) => ({
    lower: sql`${i}::int`,
    upper: sql`${i}::int`,
    upperInclusive: true,
  }))
  return [
    ...sources.map((source, i) =>
      source.key === personal
        ? {
            dimension: 'native.' + source.key,
            bucket: sql`round(raw[${i + 1}])::int - 1`,
            bins: Array.from({ length: 10 }, (_, j) => ({
              lower: sql`${j + 1}::int`,
              upper: sql`${j + 1}::int`,
              upperInclusive: true,
            })),
          }
        : continuousDimension(
            'native.' + source.key,
            sql`raw[${i + 1}]`,
            source.scale,
          ),
    ),
    continuousDimension('score', sql`score`, 100),
    continuousDimension('spread', sql`spread`, 40),
    {
      dimension: 'counted',
      bucket: sql`counted`,
      bins: countBins,
    },
  ]
}

export function selectedRanges(
  request: RatingsSourcesRequest,
  dimensions: ReturnType<typeof histogramDimensions>,
) {
  return request.ranges.map(({ dimension, first, last }) => {
    const index = dimensions.findIndex((entry) => entry.dimension === dimension)
    const entry = dimensions[index]
    if (!entry || (dimension !== 'counted' && last >= entry.bins.length))
      throw new ServerError({
        statusCode: 422,
        message: 'Unknown rating histogram or bin',
      })
    return { position: index + 1, bucket: entry.bucket, first, last }
  })
}

export async function rankRatings(
  request: RatingsRankingRequest,
  itemId?: string,
): Promise<RatingsRankingPage> {
  const sources = await rankingSources(request)
  const ranges = request.ranges.length
    ? selectedRanges(request, histogramDimensions(sources))
    : []
  const predicates = ranges.map(
    (r) => sql`${r.bucket} between ${r.first} and ${r.last}`,
  )
  const order = sql`${sortExpression(request, sources)} ${request.direction === 'asc' ? sql`asc` : sql`desc`} nulls last, id asc`
  const keys = sql`${sql.param(sources.map((s) => s.key))}::text[]`
  const isAlbum = request.library === 'album'
  const album = isAlbum
    ? sql`(select jsonb_build_object(
    'trackCount', a.track_count, 'spotifyUrl', a.spotify_url,
    'links', (select coalesce(jsonb_agg(jsonb_build_object('url', l.url) order by l.provider, l.id), '[]')
      from external_link l where l.media_item_id = p.id and l.url ilike '%open.spotify.com%'),
    'providerReferences', (select coalesce(jsonb_agg(jsonb_build_object('referenceType', r.reference_type,
        'externalId', r.external_id) order by r.provider, r.id), '[]')
      from provider_reference r where r.media_item_id = p.id and r.reference_type = 'spotify')
    ) from album a where a.media_item_id = p.id)`
    : sql`null::jsonb`
  const artistTags = isAlbum
    ? sql`left join (${artistTagsForItems(sql`any(array(select id from page))`)})
    artist_tags on artist_tags.media_item_id = p.id`
    : sql``
  const result =
    await db.execute(sql`with ${scoringCtes(request, sources, itemId)}, library_stats as (${ratingsLibraryStats(sources)}),
    eligible as materialized (
      select * from combined ${predicates.length ? sql`where ${sql.join(predicates, sql` and `)}` : sql``}
    ), counts as (
      select count(*)::int as matches, count(*) filter (where score is null)::int as unscored from eligible
    ), page as materialized (select * from eligible
      ${request.scoredOnly ? sql`where score is not null` : sql``}
      order by ${order} limit ${request.limit} offset ${request.offset}),
    enriched as (
      select p.*, m.artwork_url, ${album} as album_data,
        ${isAlbum ? sql`null::boolean` : sql`(select f.watched from film f where f.media_item_id = p.id)`} as watched,
        ${isAlbum ? storedBrowseNumber('scrobbles', 'album', sql`m.metadata->'browse'`) : sql`null::numeric`} as plays,
        (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'role', c.role,
          'billingOrder', c.billing_order) order by c.billing_order, a.name, a.id), '[]')
        from media_credit c join artist a on a.id = c.artist_id
        where c.media_item_id = p.id and c.role = ${isAlbum ? 'artist' : 'director'}) as credits,
        (select coalesce(jsonb_agg(t.name order by
          case when exists (select 1 from tag_occurrence o where o.tag_id = t.id
            and o.media_item_id = p.id and ${isAlbum ? sql`o.source = 'rym'` : sql`o.kind = 'genre'`})
            ${isAlbum ? sql`` : sql`or t.kind = 'genre'`} then 0
            when trim(t.name) ~ '^(?:[0-9]{4}|[0-9]{2})s?$' then 2 else 1 end, t.name), '[]')
        from media_item_tag mt join tag t on t.id = mt.tag_id where mt.media_item_id = p.id and not t.hidden) as tags,
        ${isAlbum ? sql`coalesce(artist_tags.tags, '[]'::jsonb)` : sql`'[]'::jsonb`} as artist_tags
      from page p join media_item m on m.id = p.id ${artistTags}
    )
    select (select library_total from library_stats) as "libraryTotal", (select recorded from library_stats) as recorded,
      (select matches from counts) as "matchingTotal", (select unscored from counts) as unscored,
      (select ${request.scoredOnly ? sql`matches - unscored` : sql`matches`} from counts) as total,
      coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'year', year, 'score', score, 'core', core, 'spread', spread,
      'artworkUrl', artwork_url, 'credits', credits, 'tags', tags, 'artistTags', artist_tags, 'album', album_data,
      'watched', watched, 'plays', plays,
      'counted', counted, 'criticGap', critic_gap, 'personalGap', mine - score,
      'observedWeight', observed_weight, 'missingWeight', missing_weight, 'missingSum', missing_sum,
      'ratings', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'raw', val,
        'adjusted', adj, 'votes', v, 'center', c, 'status', status) order by pos), '[]'::jsonb)
        from unnest(${keys}, raw, adjusted, votes, centers, statuses)
          with ordinality as observation(key, val, adj, v, c, status, pos))
    ) order by ${order}), '[]'::jsonb) as rows from enriched`)
  const row = result.rows[0]
  return RatingsRankingPageSchema.parse({
    ...row,
    sources: attachRatingsCoverage(sources, row?.recorded),
  })
}

export async function summarizeRatingsSources(
  request: RatingsSourcesRequest,
): Promise<RatingsSourcesPage> {
  const sources = await rankingSources(request)
  // Native dimensions lead the array in registry order, aligned with statuses.
  const dimensions = histogramDimensions(sources)
  const ranges = selectedRanges(request, dimensions)
  const failures = ranges.map(
    (r) => sql`case when bins[${r.position}] between
    ${r.first} and ${r.last} then null else ${r.position}::int end`,
  )
  const matches = sql`cardinality(failed) = 0`
  const coverage = sources.map(
    (source, i) => sql`jsonb_build_object(
    'key', ${source.key}::text,
    'recorded', count(*) filter (where ${matches} and bins[${i + 1}] is not null),
    'eligible', count(*) filter (where ${matches} and scored and statuses[${i + 1}] = 'counted'))`,
  )
  // A histogram includes a row when it passes every range, or when only
  // that histogram's range failed. Keep one row per item during aggregation:
  // expanding and sorting (items × dimensions) spills even for a modest library.
  const histograms = dimensions.map(({ dimension, bins }, i) => {
    const accepts = ranges.some((r) => r.position === i + 1)
      ? sql`(${matches} or failed = array[${i + 1}::int])`
      : matches
    const counts = bins.map(
      (bin, j) => sql`jsonb_build_object(
      'lower', ${bin.lower}, 'upper', ${bin.upper}, 'upperInclusive', ${bin.upperInclusive}::boolean,
      'count', count(*) filter (where ${accepts} and bins[${i + 1}] = ${j}))`,
    )
    const source = sources[i]
    const quartiles = source
      ? sql`, 'quartiles',
      percentile_disc(array[0.75,0.5,0.25]) within group (order by raw[${i + 1}] desc)
        filter (where ${accepts} and raw[${i + 1}] is not null),
      'typicalVotes', (select medians[${i + 1}] from vote_medians)`
      : sql``
    return sql`jsonb_build_object('dimension', ${dimension}::text,
      'population', count(*) filter (where ${accepts}),
      'bins', jsonb_build_array(${sql.join(counts, sql`, `)}) ${quartiles})`
  })
  const result =
    await db.execute(sql`with ${scoringCtes(request, sources)}, vote_medians as materialized (
      select ${numericArray(
        sources.map((s, i) =>
          s.hasVotes
            ? sql`percentile_disc(0.5)
        within group (order by votes[${i + 1}] desc)`
            : sql`null`,
        ),
      )} as medians from cohort limit 1
    ), binned as (
      select array[${sql.join(
        dimensions.map((d) => d.bucket),
        sql`, `,
      )}] as bins,
        score is not null as scored, statuses, counted, spread, raw from matching offset 0
    ), ranged as (
      select binned.*, array_remove(array[${sql.join(failures, sql`, `)}]::int[], null) as failed
      from binned offset 0
    )
    select count(*) filter (where ${matches})::int as total,
      (select count(*)::int from cohort) as "libraryTotal",
      (select recorded from (${ratingsLibraryStats(sources)}) lib) as recorded,
      count(*) filter (where ${matches} and scored)::int as scored,
      percentile_disc(0.5) within group (order by counted desc) filter (where ${matches}) as "medianCounted",
      (percentile_disc(0.5) within group (order by spread desc) filter (where ${matches}))::float8 as "medianSpread",
      jsonb_build_array(${sql.join(coverage, sql`, `)}) as coverage,
      jsonb_build_array(${sql.join(histograms, sql`, `)}) as histograms from ranged`)
  const summary = result.rows[0]
  return RatingsSourcesPageSchema.parse({
    ...summary,
    sources: attachRatingsCoverage(sources, summary?.recorded),
  })
}
