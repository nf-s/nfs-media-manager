import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { validIsrc, validIsrcSql } from '@/lib/isrc'
import type { ChangeReader } from './library-change-effect'
import { spotifyRecordingSources } from './track-isrcs'

const billing = (id: SQL) => sql`(
  select array_agg(c.artist_id order by c.billing_order,c.artist_id)
  from media_credit c where c.media_item_id=${id} and c.role='artist'
)`

// Either track may have additional historical references. A conflicting or
// rejected Spotify code prevents treating these editions as interchangeable.
const undisputed = (id: SQL, code: SQL) => sql`not exists (
  select 1 from provider_reference other where other.media_item_id=${id}
    and other.provider='spotify' and other.reference_type='isrc'
    and (other.external_id<>${code} or other.metadata->>'rejected'='true'
      or other.metadata->>'verified'='false')
)`

/** Resolve playback navigation without promoting or merging market editions. */
export async function playbackRecordingMembers(
  database: ChangeReader,
  tracks: { id: string; spotifyId: string; isrc?: string }[],
) {
  const members = new Map<string, string>()
  if (!tracks.length) return members
  const requests = tracks.map(({ id, spotifyId, isrc }) => ({
    id,
    native: spotifyId,
    code: validIsrc(isrc),
  }))
  const sources = sql`(select jsonb_array_elements_text(${JSON.stringify(spotifyRecordingSources)}::jsonb))`
  const { rows } = await database.execute(sql`
    with requested as (
      select * from jsonb_to_recordset(${JSON.stringify(requests)}::jsonb) as input(id text,native text,code text)
    ), playing as (
      select t.*, m.title, coalesce(q.code,r.external_id) as code
      from requested q join library_track t on t.media_item_id=q.id and t.spotify_track_id=q.native
      join media_item m on m.id=t.media_item_id and not m.in_library
      left join provider_reference r on r.media_item_id=q.id and r.provider='spotify'
        and r.reference_type='isrc' and r.metadata->>'source' in ${sources}
      where m.metadata->>'legacyHidden' is distinct from 'true'
    )
    select p.media_item_id as id, min(m.id) as member from playing p
    join provider_reference r on r.provider='spotify' and r.reference_type='isrc'
      and r.external_id=p.code and r.metadata->>'source' in ${sources}
    join media_item m on m.id=r.media_item_id and m.in_library and lower(trim(m.title))=lower(trim(p.title))
    join library_track t on t.media_item_id=m.id and t.spotify_track_id ~ '^[A-Za-z0-9]{22}$'
    where p.code=${validIsrcSql(sql`p.code`)}
      and m.metadata->>'legacyHidden' is distinct from 'true'
      and p.duration_sec>0 and abs(t.duration_sec-p.duration_sec)<=2
      and nullif(lower(trim(p.album_name)),'')=lower(trim(t.album_name))
      and t.version_group_id is not distinct from p.version_group_id
      and ${billing(sql`p.media_item_id`)}=${billing(sql`m.id`)}
      and ${undisputed(sql`p.media_item_id`, sql`p.code`)}
      and ${undisputed(sql`m.id`, sql`p.code`)}
      and not exists (select 1 from library_keep_separate k where k.kind='track'
        and k.low_id=least(p.media_item_id,m.id) and k.high_id=greatest(p.media_item_id,m.id))
    group by p.media_item_id having count(distinct m.id)=1
  `)
  for (const { id, member } of z
    .array(z.object({ id: z.string(), member: z.string() }))
    .parse(rows))
    members.set(id, member)
  return members
}
