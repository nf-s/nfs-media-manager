import {
  ArtistProfileProviderSchema,
  type ArtistProfileProvider,
} from '@repo/schemas/artist-profiles'
import {
  MatchDiagnosticsPageSchema,
  type MatchDiagnosticsQuery,
} from '@repo/schemas/match-diagnostics'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { normalizeArtistProviderId } from '@/plugins/builtin/artist-providers'
import { artistCreditEvidenceQuery } from './artist-provider-evidence'

const providerLabels: Record<ArtistProfileProvider, string> = {
  spotify: 'Spotify',
  lastfm: 'Last.fm',
  discogs: 'Discogs',
  musicbrainz: 'MusicBrainz',
}
const providers = ArtistProfileProviderSchema.options.map((key) => ({
  key,
  label: providerLabels[key],
}))

const ResultRowsSchema = z.array(
  z.object({
    total: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        matches: z.array(
          z.object({
            provider: ArtistProfileProviderSchema,
            name: z.string().nullable(),
            identifier: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
)

const visibleArtists = sql`
  select a.id, a.name
  from artist a
  where exists (
    select 1 from media_credit c
    join media_item m on m.id = c.media_item_id
    left join album release
      on m.media_type = 'album' and release.media_item_id = m.id
    left join library_track recording
      on m.media_type = 'track' and recording.media_item_id = m.id
    where c.artist_id = a.id and c.role = 'artist'
      and m.metadata->>'legacyHidden' is distinct from 'true'
      and (release.media_item_id is not null or recording.media_item_id is not null)
  )
`

function matchEvidence(target: 'visible_artists' | 'page_artists') {
  const targets =
    target === 'visible_artists'
      ? sql`select id, name from visible_artists`
      : sql`select id, name from page_artists`
  return sql`
    select artist_id, provider, name, identifier, bool_or(confirmed) as confirmed
    from (
      select credit.artist_id, credit.provider, credit.name, credit.external_id as identifier, false as confirmed
      from (${artistCreditEvidenceQuery(targets, ArtistProfileProviderSchema.options)}) credit
      cross join lateral (
        select lower(trim(regexp_replace(normalize(credit.name, NFKC), '[[:space:]]+', ' ', 'g'))) as name,
          lower(trim(regexp_replace(normalize(credit.credited_name, NFKC), '[[:space:]]+', ' ', 'g'))) as credited_name,
          lower(trim(regexp_replace(normalize(credit.artist_name, NFKC), '[[:space:]]+', ' ', 'g'))) as artist_name
      ) keys
      where credit.external_id is not null and (
        keys.name = keys.artist_name or keys.credited_name = keys.artist_name
        or (credit.provider = 'discogs' and regexp_replace(keys.name, ' [(][0-9]+[)]$', '') = keys.artist_name)
      )
      union all
      select target.id, state.provider, nullif(trim(snapshot.normalized_data->>'name'), ''),
        nullif(trim(snapshot.normalized_data->>'externalId'), ''), true
      from (${targets}) target
      join artist_provider_current_state state on state.artist_id = target.id
      join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
      where state.provider in (${sql.join(
        ArtistProfileProviderSchema.options.map((key) => sql`${key}`),
        sql`, `,
      )})
    ) stored
    where name is not null or identifier is not null
    group by artist_id, provider, name, identifier
  `
}

/** Compare library names with saved provider names and source credit evidence. */
export async function listArtistMatchDiagnostics(query: MatchDiagnosticsQuery) {
  const sortProvider = ArtistProfileProviderSchema.safeParse(query.sortBy)
  if (
    !sortProvider.success &&
    query.sortBy !== 'name' &&
    query.sortBy !== 'creator'
  )
    throw new ServerError({
      statusCode: 422,
      message: 'Unknown artist diagnostics sort.',
    })

  const words = (query.q ?? '').split(/\s+/).filter(Boolean)
  const needsEvidence = sortProvider.success || words.length > 0
  const conditions = words.map((word) => {
    const pattern = `%${word.replace(/[\\%_]/g, '\\$&')}%`
    return sql`(a.name ilike ${pattern} or exists (
      select 1 from evidence e where e.artist_id = a.id
        and (e.name ilike ${pattern} or e.identifier ilike ${pattern})
    ))`
  })
  const sortValue = sortProvider.success
    ? sql`provider_order.value`
    : sql`lower(a.name)`
  const sortJoin = sortProvider.success
    ? sql`left join (
        select distinct on (artist_id) artist_id, lower(coalesce(name, identifier)) as value
        from evidence where provider = ${sortProvider.data}
        order by artist_id, confirmed desc, lower(name) nulls last, name, identifier
      ) provider_order on provider_order.artist_id = a.id`
    : sql``
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const ordering = sql`sort_value ${direction} nulls last, lower(name), id`
  const rows = await db.execute(sql`
    with visible_artists as (
      ${visibleArtists}
    ),
    ${needsEvidence ? sql`evidence as materialized (${matchEvidence('visible_artists')}),` : sql``}
    matching_artists as materialized (
      select a.id, a.name from visible_artists a
      ${conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``}
    ),
    page_artists as materialized (
      select a.id, a.name, ${sortValue} as sort_value from matching_artists a
      ${sortJoin}
      order by ${ordering}
      limit ${query.size} offset ${(query.page - 1) * query.size}
    )
    ${needsEvidence ? sql`` : sql`, evidence as (${matchEvidence('page_artists')})`},
    page_matches as (
      select e.artist_id,
        jsonb_agg(jsonb_build_object('provider', e.provider, 'name', e.name, 'identifier', e.identifier)
          order by e.provider, e.confirmed desc, lower(e.name) nulls last, e.name, e.identifier) as items
      from evidence e join page_artists on page_artists.id = e.artist_id
      group by e.artist_id
    )
    select (select count(*)::int from matching_artists) as total,
      coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'matches', coalesce(page_matches.items, '[]'::jsonb)
      ) order by ${ordering}), '[]'::jsonb) as items
    from page_artists left join page_matches on page_matches.artist_id = page_artists.id
  `)
  const [page] = ResultRowsSchema.parse(rows.rows)
  const totalCount = page?.total ?? 0
  return MatchDiagnosticsPageSchema.parse({
    providers,
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
    items: (page?.items ?? []).map((artist) => {
      const seen = new Set<string>()
      const matches = artist.matches.flatMap((match) => {
        const identifier = match.identifier
          ? normalizeArtistProviderId(match.provider, match.identifier)
          : null
        if (!identifier && !match.name) return []
        const key = JSON.stringify([match.provider, match.name, identifier])
        if (seen.has(key)) return []
        seen.add(key)
        return [{ ...match, identifier, creator: null }]
      })
      return { ...artist, creator: null, matches }
    }),
  })
}
