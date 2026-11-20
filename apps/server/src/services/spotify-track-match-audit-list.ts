import { sql } from 'drizzle-orm'
import {
  SpotifyTrackAuditPageSchema,
  type SpotifyTrackAuditQuery,
} from '@repo/schemas/spotify-track-search'
import { db } from '@/lib/db'
import { libraryTrack, mediaItem, spotifyTrackMatchAudit } from '@/schemas/db'
import { playableSpotifyId } from './recording-groups'

const AuditRowsSchema = SpotifyTrackAuditPageSchema.omit({ pageCount: true })
const sorts = {
  assessment: sql`case p.assessment when 'likely' then 0 when 'review' then 1 else 2 end`,
  title: sql`p.title_key`,
  candidates: sql`p.candidate_count`,
}

/** Read the owner's saved report and current direct match availability together. */
export async function listSpotifyTrackMatchAudit(
  ownerId: string,
  query: SpotifyTrackAuditQuery,
) {
  const direction = query.direction === 'desc' ? sql`desc` : sql`asc`
  const secondary = query.sort === 'title' ? sql`` : sql`p.title_key asc,`
  const order = sql`${sorts[query.sort]} ${direction}, ${secondary} p.track_id asc`
  const assessment = query.assessment
    ? sql`p.assessment = ${query.assessment}`
    : sql`true`
  const search = query.q
    ? sql`strpos(p.search_text, lower(${query.q})) > 0`
    : sql`true`
  const matching = sql`${assessment} and ${search}`
  const offset = (query.page - 1) * query.size
  const result = await db.execute(sql`
    with eligible as materialized (
      select audit.track_id, audit.assessment, audit.candidate_count,
        audit.search_text, lower(item.title) as title_key
      from ${spotifyTrackMatchAudit} audit
      join ${libraryTrack} track on track.media_item_id = audit.track_id
      join ${mediaItem} item on item.id = audit.track_id
      where audit.owner_id = ${ownerId} and item.media_type = 'track'
        and item.metadata->>'legacyHidden' is distinct from 'true'
        and not ${playableSpotifyId(sql`track.spotify_track_id`)}
    ), selected as (
      select p.track_id, p.assessment, p.candidate_count, p.title_key
      from eligible p where ${matching}
      order by ${order} limit ${query.size} offset ${offset}
    )
    select
      (select to_char(max(assessed_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        from ${spotifyTrackMatchAudit} where owner_id = ${ownerId}) as "generatedAt",
      count(*)::int as "totalTracks",
      coalesce(sum(p.candidate_count), 0)::int as "totalCandidates",
      jsonb_build_object(
        'likely', count(*) filter (where p.assessment = 'likely'),
        'review', count(*) filter (where p.assessment = 'review'),
        'unlikely', count(*) filter (where p.assessment = 'unlikely')
      ) as counts,
      count(*) filter (where ${matching})::int as "totalCount",
      coalesce((
        select jsonb_agg(audit.report order by ${order})
        from selected p join ${spotifyTrackMatchAudit} audit
          on audit.track_id = p.track_id and audit.owner_id = ${ownerId}
      ), '[]'::jsonb) as items
    from eligible p`)
  const page = AuditRowsSchema.parse(result.rows[0])
  return { ...page, pageCount: Math.ceil(page.totalCount / query.size) }
}
