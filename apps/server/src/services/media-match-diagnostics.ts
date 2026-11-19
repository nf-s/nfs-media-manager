import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  MatchDiagnosticsRowSchema,
  type MatchDiagnosticsPage,
  type MatchDiagnosticsQuery,
} from '@repo/schemas/match-diagnostics'
import { albumMatchIdentifierMaxLength } from '@repo/schemas/provider-identification'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { listProviderCatalog } from '@/plugins/registry'
import { readAlbumMatchRejectionsForItems } from './album-match-rejections'
import { getLastfmAccount } from './lastfm-scrobbles'
import {
  legacyAlbumGoogleMatchEvidence,
  mediaMatchEvidence,
  visibleMediaMatches,
} from './media-match-evidence'

const lastfmListeningProvider = 'lastfm-listening'

function listeningMatches(account: string) {
  return sql`
    union all
    select distinct scope.id, ${lastfmListeningProvider}::text as provider,
      scrobble.album_name, scrobble.artist_name, null::text,
      scrobble.artist_key, scrobble.album_key, null::text as source_provider,
      null::integer as match_priority, null::text as snapshot_id, null::text as reference_type
    from evidence_scope scope
    join lastfm_scrobble scrobble on scrobble.album_media_item_id = scope.id
    where scrobble.username = ${account}
      and scrobble.album_key is not null and nullif(trim(scrobble.album_name), '') is not null`
}

function libraryRows(kind: 'album' | 'film', role: 'artist' | 'director') {
  const details = kind === 'album' ? sql`album` : sql`film`
  return sql`
    select item.id, item.title as name,
      (select string_agg(person.name, ', ' order by credit.billing_order, person.name)
        from media_credit credit join artist person on person.id = credit.artist_id
        where credit.media_item_id = item.id and credit.role = ${role}) as creator
    from media_item item join ${details} details on details.media_item_id = item.id
    where item.media_type = ${kind} and item.metadata->>'legacyHidden' is distinct from 'true'`
}

function textContains(pattern: string, field: SQL) {
  return sql`strpos(lower(${field}), lower(${pattern})) > 0`
}

const ResultSchema = z.object({
  items: z.array(MatchDiagnosticsRowSchema),
  totalCount: z.number().int().nonnegative(),
  storedProviders: z.array(z.string()),
})

/** Lists canonical items alongside what each source actually recorded for them. */
export async function listMediaMatchDiagnostics(
  kind: 'album' | 'film',
  query: MatchDiagnosticsQuery & { longRym?: '1' },
): Promise<MatchDiagnosticsPage> {
  const [catalog, lastfmAccount] = await Promise.all([
    listProviderCatalog(),
    kind === 'album' ? getLastfmAccount() : null,
  ])
  const providers = new Map(
    catalog
      .filter((provider) => provider.mediaTypes.includes(kind))
      .map((provider) => [provider.id, provider.displayName]),
  )
  if (lastfmAccount) providers.set(lastfmListeningProvider, 'Last.fm listening')

  const role = kind === 'album' ? 'artist' : 'director'
  const sortByProvider = !['name', 'creator'].includes(query.sortBy)
  const filter = query.q?.trim()
  // Reading the default catalogue page only projects source fields for its rows.
  // Provider sorts and search need evidence for the full result before paging.
  const earlyPage = !filter && !sortByProvider
  const direction = query.direction === 'desc' ? sql`desc` : sql`asc`
  const sort = sortByProvider
    ? sql`provider_sort.value`
    : query.sortBy === 'creator'
      ? sql`lower(item.creator)`
      : sql`lower(item.name)`
  const order = sql`sort_value ${direction} nulls last, lower(name), id`
  const providerSortValue = sql`lower(coalesce(name, creator, identifier))`
  const limit = sql`limit ${query.size} offset ${(query.page - 1) * query.size}`
  const result = await db.execute(sql`
    with library as not materialized (${libraryRows(kind, role)}),
    evidence_scope as (
      ${
        earlyPage
          ? sql`select item.*, ${sort} as sort_value from library item order by ${order} ${limit}`
          : sql`select * from library`
      }
    ), evidence as (
      ${mediaMatchEvidence(role)}
      ${kind === 'album' ? legacyAlbumGoogleMatchEvidence() : sql.empty()}
      ${lastfmAccount ? listeningMatches(lastfmAccount) : sql.empty()}
    ), matches as (${visibleMediaMatches(kind)})${
      sortByProvider
        ? sql`, provider_sort as (
      select id, (array_agg(${providerSortValue} order by match_priority nulls last, ${providerSortValue}))[1] as value
      from matches where provider = ${query.sortBy} group by id
    )`
        : sql.empty()
    }, filtered as (
      ${earlyPage ? sql`select * from evidence_scope` : sql`select item.*, ${sort} as sort_value from evidence_scope item`}
      ${sortByProvider ? sql`left join provider_sort using (id)` : sql.empty()}
      ${
        filter
          ? sql`where ${textContains(filter, sql`item.name`)} or ${textContains(filter, sql`item.creator`)}
        or exists (select 1 from matches m where m.id = item.id and (
          ${textContains(filter, sql`m.name`)} or ${textContains(filter, sql`m.creator`)} or ${textContains(filter, sql`m.identifier`)}))`
          : sql.empty()
      }
    ), page as (
      select * from filtered order by ${order} ${earlyPage ? sql.empty() : limit}
    ), page_rows as (
      select page.*, coalesce((
        select jsonb_agg(jsonb_build_object('provider', provider, 'name', name, 'creator', creator,
          'identifier', identifier) || case when artist_key is null then '{}'::jsonb else
            jsonb_build_object('artistKey', artist_key, 'albumKey', album_key) end
          || case when source_provider is null or source_provider = provider then '{}'::jsonb else
            jsonb_build_object('sourceProvider', source_provider) end
          ${
            kind === 'album'
              ? sql`|| case when identifier is not null and length(snapshot_id) between 1 and 500
                and length(reference_type) between 1 and 200 and length(provider) between 1 and 200
                and length(coalesce(source_provider, provider)) between 1 and 200 then
                jsonb_build_object('rejectionTarget', jsonb_build_object('provider', provider,
                  'sourceProvider', coalesce(source_provider, provider), 'snapshotId', snapshot_id,
                  'referenceType', reference_type, 'identifier', identifier)) else '{}'::jsonb end`
              : sql.empty()
          }
          order by provider, match_priority nulls last, lower(name), name, lower(creator), creator, identifier, artist_key, album_key)
        from matches where matches.id = page.id
      ), '[]'::jsonb) as matches
      from page
    )
    select (select count(*)::int from ${earlyPage ? sql`library` : sql`filtered`}) as "totalCount",
      coalesce((select jsonb_agg(to_jsonb(page_rows) - 'sort_value' order by ${order}) from page_rows), '[]'::jsonb) as items,
      coalesce((select array_agg(distinct state.provider order by state.provider)
        from provider_current_state state join library item on item.id = state.media_item_id
        where state.status = 'ready'
          and state.provider not in ('legacy-record', 'legacy-browser', 'legacy-library', 'legacy-smart-playlists')), '{}') as "storedProviders"
  `)
  const { items, totalCount, storedProviders } = ResultSchema.parse(
    result.rows[0],
  )
  for (const provider of storedProviders)
    if (!providers.has(provider)) providers.set(provider, provider)
  if (sortByProvider && !providers.has(query.sortBy))
    throw new ServerError({ statusCode: 422, message: 'Unknown match column.' })
  if (kind === 'album') {
    const rejections = await readAlbumMatchRejectionsForItems(
      db,
      items
        .filter((item) => item.matches.some((match) => match.rejectionTarget))
        .map((item) => item.id),
    )
    for (const item of items) {
      const albumRejections = rejections.get(item.id)
      for (const match of item.matches) {
        const target = match.rejectionTarget
        if (!target) continue
        if (
          !query.longRym &&
          target.identifier.length > albumMatchIdentifierMaxLength
        )
          delete match.rejectionTarget
        const rejection = albumRejections?.find((row) =>
          createAlbumMatchRejectionPredicate(target.provider, [row])({
            referenceType: target.referenceType,
            externalId: target.identifier,
          }),
        )
        if (rejection) match.rejectedAt = rejection.rejectedAt
      }
    }
  }

  return {
    items,
    providers: [...providers].map(([key, label]) => ({ key, label })),
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
  }
}
