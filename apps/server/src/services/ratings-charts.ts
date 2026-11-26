import { sql, type SQL } from 'drizzle-orm'
import {
  RatingsAgreementPageSchema,
  RatingsComparePageSchema,
  ratingsPointLimit,
  type RatingsCompareRequest,
} from '@repo/schemas/ratings-charts'
import type { RatingsSourcesRequest } from '@repo/schemas/ratings-explorer'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  attachRatingsCoverage,
  histogramDimensions,
  ratingsLibraryStats,
  rankingSources,
  scoringCtes,
  selectedRanges,
  type Source,
} from './ratings-explorer'

function chartFilter(request: RatingsSourcesRequest, sources: Source[]) {
  if (!request.ranges.length) return sql``
  const predicates = selectedRanges(request, histogramDimensions(sources)).map(
    ({ bucket, first, last }) => sql`${bucket} between ${first} and ${last}`,
  )
  return sql`where ${sql.join(predicates, sql` and `)}`
}

// Use the same eligibility rule in pair cells, bias measures, and source
// axes. A zero scoring weight omits a source from the combined score only.
function available(status: SQL) {
  return sql`${status} not in ('missing', 'votes')`
}

function pearson(x: SQL, y: SQL) {
  const r = sql`corr(${x}, ${y})`
  // corr is undefined for a constant axis. Preserve NULL before clamping
  // floating-point roundoff at the endpoints of the correlation scale.
  return sql`case when count(*) >= 20 and ${r} is not null
    then greatest(-1, least(1, ${r})) end`
}

function leaderList(value: SQL, order: SQL, filter = sql`true`) {
  return sql`(select coalesce(jsonb_agg(to_jsonb(l) order by l.value ${order}, l.id), '[]'::jsonb)
    from (select id, title, score, ${value} as value from items
      where ${value} is not null and ${filter} order by value ${order}, id limit 8) l)`
}

export async function ratingsAgreement(request: RatingsSourcesRequest) {
  const sources = await rankingSources(request)
  const keys = sql`${sql.param(sources.map((s) => s.key))}::text[]`
  const scale = sql`${sql.param(sources.map((s) => s.scale))}::numeric[]`
  const publicSources = sql`${sql.param(sources.map((s) => s.group !== 'personal'))}::boolean[]`
  const result =
    await db.execute(sql`with ${scoringCtes(request, sources)}, items as materialized (
    select id, title, score, spread, critic_gap, mine - score as personal_gap,
      counted, raw, adjusted, statuses from matching ${chartFilter(request, sources)}
  ), pairs as (
    select left_rating.pos as a, right_rating.pos as b, count(*)::int as count,
      ${pearson(sql`left_rating.value`, sql`right_rating.value`)} as correlation
    from items
    cross join lateral unnest(adjusted, statuses) with ordinality as left_rating(value, status, pos)
    cross join lateral unnest(adjusted, statuses) with ordinality as right_rating(value, status, pos)
    where left_rating.pos < right_rating.pos and ${available(sql`left_rating.status`)}
      and ${available(sql`right_rating.status`)}
    group by left_rating.pos, right_rating.pos
  ), bias as (
    select pos, count(*) filter (where others > 0)::int as items,
      avg(scaled - other_scaled / nullif(others, 0)) as runs,
      avg(abs(value - other_adjusted / nullif(others, 0))) as strays,
      avg((pos = winner)::int) filter (where counted_here and others > 0) as furthest
    from items cross join lateral (
      select stats.*, first_value(case when counted >= 3 and counted_here and deviation > 0 then pos end)
        over (order by deviation desc nulls last, pos) as winner
      from (
        select v.*, count(*) filter (where public) over () - public::int as others,
          sum(scaled) filter (where public) over () - case when public then scaled else 0 end as other_scaled,
          sum(value) filter (where public) over () - case when public then value else 0 end as other_adjusted,
          case when counted_here then abs(counted * value - sum(value) filter (where counted_here) over ()) end as deviation
        from (
          select pos, value, raw_value * 100 / scale as scaled, public, status in ('counted','trimmed') as counted_here
          from unnest(adjusted, raw, statuses, ${scale}, ${publicSources})
            with ordinality as observation(value, raw_value, status, scale, public, pos)
          where ${available(sql`status`)}
        ) v
      ) stats
    ) deviations group by pos
  )
  select library.*, (select count(*)::int from items) as total,
    (select coalesce(jsonb_agg(jsonb_build_object('x', (${keys})[a], 'y', (${keys})[b],
      'count', count, 'correlation', correlation) order by a,b), '[]'::jsonb) from pairs) as pairs,
    (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'items', coalesce(bias.items, 0),
      'runs', runs, 'strays', strays, 'furthest', furthest) order by registry.pos), '[]'::jsonb)
      from unnest(${keys}) with ordinality as registry(key,pos) left join bias using(pos)) as bias,
    jsonb_build_object('divided', ${leaderList(sql`spread`, sql`desc`, sql`counted >= 3`)},
      'criticsHigher', ${leaderList(sql`critic_gap`, sql`desc`)},
      'audiencesHigher', ${leaderList(sql`critic_gap`, sql`asc`)},
      'personalHigher', ${leaderList(sql`personal_gap`, sql`desc`)},
      'personalLower', ${leaderList(sql`personal_gap`, sql`asc`)}) as lists from (${ratingsLibraryStats(sources)}) library`)
  const row = result.rows[0]
  return RatingsAgreementPageSchema.parse({
    ...row,
    libraryTotal: row?.library_total,
    sources: attachRatingsCoverage(sources, row?.recorded),
  })
}

function axis(key: string, sources: Source[]) {
  const raw = sql`null::numeric`
  switch (key) {
    case 'score':
      return { value: sql`score`, raw, rated: true }
    case 'critics':
      return { value: sql`critics`, raw, rated: true }
    case 'audience':
      return { value: sql`audience`, raw, rated: true }
    case 'year':
      return { value: sql`year`, raw, rated: false }
    case 'spread':
      return { value: sql`spread`, raw, rated: false }
  }
  const index = sources.findIndex((source) => source.key === key)
  if (index < 0)
    throw new ServerError({
      statusCode: 422,
      message: 'Unknown comparison axis',
    })
  return {
    value: sql`case when ${available(sql`statuses[${index + 1}]`)} then adjusted[${index + 1}] end`,
    raw: sql`raw[${index + 1}]`,
    rated: true,
  }
}

function pointList(order: SQL, limit: number) {
  return sql`(select coalesce(jsonb_agg(to_jsonb(p) - 'ordinal' order by ordinal, id), '[]'::jsonb)
    from (select points.*, ${order} as ordinal from points order by ordinal, id limit ${limit}) p)`
}

export async function ratingsCompare(request: RatingsCompareRequest) {
  const sources = await rankingSources(request)
  const x =
    request.x ??
    sources.find((s) => s.group === 'audience')?.key ??
    sources[0]?.key ??
    'score'
  const y =
    request.y ??
    sources.find((s) => s.group === 'critics')?.key ??
    sources[1]?.key ??
    'score'
  const across = axis(x, sources)
  const up = axis(y, sources)
  const bothRated = across.rated && up.rated
  const result =
    await db.execute(sql`with ${scoringCtes(request, sources)}, axes as materialized (
    select id, title, year, ${across.value} as x, ${up.value} as y,
      ${across.raw} as "xRaw", ${up.raw} as "yRaw" from matching ${chartFilter(request, sources)}
  ), points as materialized (select * from axes where x is not null and y is not null),
  stats as (select (select count(*)::int from axes) as total, count(*)::int as count,
    ${pearson(sql`x`, sql`y`)} as correlation,
    ${bothRated ? sql`avg(y - x)::float8` : sql`null::float8`} as "meanGap",
    min(x)::float8 as "xMin", max(x)::float8 as "xMax", min(y)::float8 as "yMin", max(y)::float8 as "yMax",
    ${pointList(sql`md5(id)`, ratingsPointLimit)} as points,
    ${bothRated ? pointList(sql`x - y`, 8) : sql`'[]'::jsonb`} as "yHigher",
    ${bothRated ? pointList(sql`y - x`, 8) : sql`'[]'::jsonb`} as "xHigher" from points)
    select stats.*, library.* from stats cross join (${ratingsLibraryStats(sources)}) library`)
  const row = result.rows[0]
  return RatingsComparePageSchema.parse({
    ...row,
    libraryTotal: row?.library_total,
    sources: attachRatingsCoverage(sources, row?.recorded),
    x,
    y,
  })
}
