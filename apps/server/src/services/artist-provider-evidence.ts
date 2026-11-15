import type { ArtistProfileProvider } from '@repo/schemas/artist-profiles'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  artistNameKey,
  artistSearchNameMatches,
  normalizeArtistProviderId,
  type ArtistCandidate,
} from '@/plugins/builtin/artist-providers'

const creditPaths: Record<ArtistProfileProvider, string[]> = {
  spotify: ['$.artists[*]'],
  musicbrainz: ['$.releaseGroup."artist-credit"[*]'],
  discogs: [
    '$.release.artists[*]',
    '$.mainRelease.artists[*]',
    '$.master.artists[*]',
  ],
  lastfm: ['$.album.artist'],
}

const EvidenceRowsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    credited_name: z.string().nullable(),
  }),
)

/** Read native artist credits from linked library records without provider calls. */
export async function listStoredArtistProviderCandidates(
  artistId: string,
  name: string,
  provider: ArtistProfileProvider,
) {
  const id =
    provider === 'musicbrainz'
      ? sql`entry.credit->'artist'->>'id'`
      : provider === 'lastfm'
        ? sql`entry.credit->>'mbid'`
        : sql`entry.credit->>'id'`
  const artistName =
    provider === 'musicbrainz'
      ? sql`entry.credit->'artist'->>'name'`
      : sql`entry.credit->>'name'`
  const creditedName =
    provider === 'musicbrainz'
      ? sql`entry.credit->>'name'`
      : provider === 'discogs'
        ? sql`entry.credit->>'anv'`
        : sql`null::text`
  const paths = sql.join(
    creditPaths[provider].map((path) => sql`(${path})`),
    sql`, `,
  )

  const trackEvidence =
    provider === 'spotify'
      ? sql`
        union all
        select credit.artist->>'id', credit.artist->>'name', null::text
        from linked_music m
        join library_track track on track.media_item_id = m.id
        join provider_current_state state on state.media_item_id = track.album_media_item_id
          and state.provider = 'spotify' and state.status = 'ready'
        cross join lateral jsonb_path_query(
          state.payload, '$.tracks.items[*] ? (@.id == $track_id).artists[*]'::jsonpath,
          jsonb_build_object('track_id', track.spotify_track_id)
        ) as credit(artist)
        where track.spotify_track_id is not null
      `
      : provider === 'lastfm'
        ? sql`
          union all
          select scrobble.artist_mbid, scrobble.artist_name, null::text
          from linked_music m
          join lastfm_scrobble scrobble on scrobble.album_media_item_id = m.id
          where scrobble.artist_mbid is not null
          union all
          select scrobble.artist_mbid, scrobble.artist_name, null::text
          from linked_music m
          join lastfm_track_source source on source.track_media_item_id = m.id
          join lastfm_scrobble scrobble on scrobble.username = source.username
            and scrobble.artist_key = source.artist_key and scrobble.track_key = source.track_key
          where scrobble.artist_mbid is not null
        `
        : sql``

  const evidence = EvidenceRowsSchema.parse(
    (
      await db.execute(sql`
    with linked_music as (
      select m.id
      from media_credit c join media_item m on m.id = c.media_item_id
      where c.artist_id = ${artistId} and c.role = 'artist'
        and m.media_type in ('album', 'track')
        and m.metadata->>'legacyHidden' is distinct from 'true'
    ), evidence as (
      select ${id} as id, ${artistName} as name, ${creditedName} as credited_name
      from linked_music m join provider_current_state state on state.media_item_id = m.id
      cross join (values ${paths}) as pattern(path)
      cross join lateral jsonb_path_query(state.payload, pattern.path::jsonpath) as entry(credit)
      where state.provider = ${provider} and state.status = 'ready'
      ${trackEvidence}
    )
    select distinct id, name, credited_name from evidence where id is not null and name is not null
    order by name, id, credited_name
  `)
    ).rows,
  )
  const candidates = new Map<string, ArtistCandidate & { exact: boolean }>()
  const expected = artistNameKey(name)
  for (const row of evidence) {
    const relatedName = row.credited_name
      ? artistNameKey(row.credited_name)
      : ''
    const exact =
      artistNameKey(row.name) === expected || relatedName === expected
    if (!exact && !artistSearchNameMatches(provider, row.name, name)) continue
    const providerId = normalizeArtistProviderId(provider, row.id)
    if (!providerId || candidates.get(providerId)?.exact) continue
    candidates.set(providerId, { id: providerId, name: row.name, exact })
  }
  return [...candidates.values()]
}
