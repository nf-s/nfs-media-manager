import {
  ArtistIdentifierSourcePageSchema,
  ArtistProfileProviderSchema,
  type ArtistIdentifier,
  type ArtistProfileProvider,
  type ArtistProviderId,
  type ArtistProviderSnapshot,
} from '@repo/schemas/artist-profiles'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { listCurrentArtistProfiles } from './artist-profiles'
import {
  artistNameKey,
  artistSearchNameMatches,
  normalizeArtistProviderId,
  type ArtistCandidate,
} from '@/plugins/builtin/artist-providers'

const creditPaths: Record<ArtistProfileProvider, string[]> = {
  spotify: ['$.artists[*]', '$.data.artists[*]'],
  musicbrainz: ['$.releaseGroup."artist-credit"[*]'],
  discogs: [
    '$.release.artists[*]',
    '$.mainRelease.artists[*]',
    '$.master.artists[*]',
  ],
  lastfm: ['$.album.artist', '$.album.tracks.track[*].artist'],
}

const EvidenceRowsSchema = z.array(
  z.object({
    external_id: z.string(),
    name: z.string(),
    credited_name: z.string().nullable(),
  }),
)
type EvidenceRow = z.infer<typeof EvidenceRowsSchema>[number]
type AcceptedEvidence = EvidenceRow & { normalizedId: string; exact: boolean }

const spotifyTrackCreditPaths = [
  '$.tracks.items[*] ? (@.id == $track_id).artists[*]',
  '$.data.tracks.items[*] ? (@.id == $track_id).artists[*]',
]

// Select a credit-bearing payload before matching the library artist name so a
// newer changed credit cannot silently resurrect an older artist identity.
function hasSpotifyTrackCredits(payload: SQL) {
  return sql`(${sql.join(
    spotifyTrackCreditPaths.map(
      (path) => sql`jsonb_path_exists(
      ${payload}, ${path + ' ? (@.id like_regex "^[A-Za-z0-9]{22}$" && @.name.type() == "string" && @.name != "")'}::jsonpath,
      jsonb_build_object('track_id', album_track.spotify_track_id)
    )`,
    ),
    sql` or `,
  )})`
}

/** Artist MBIDs identify the same entity in MusicBrainz and Last.fm. */
function evidenceProviders(
  provider: ArtistProfileProvider,
): ArtistProfileProvider[] {
  return provider === 'lastfm' || provider === 'musicbrainz'
    ? ['musicbrainz', 'lastfm']
    : [provider]
}

/** Native credits connected to the target artists' library albums and tracks. */
export function artistCreditEvidenceQuery(
  targets: SQL,
  providers: readonly ArtistProfileProvider[],
) {
  const nativeCredits = providers.map((source) => {
    const id =
      source === 'musicbrainz'
        ? sql`entry.credit->'artist'->>'id'`
        : source === 'lastfm'
          ? sql`coalesce(nullif(entry.credit->>'mbid', ''), entry.credit->>'url')`
          : sql`entry.credit->>'id'`
    const artistName =
      source === 'musicbrainz'
        ? sql`entry.credit->'artist'->>'name'`
        : sql`entry.credit->>'name'`
    const creditedName =
      source === 'musicbrainz'
        ? sql`entry.credit->>'name'`
        : source === 'discogs'
          ? sql`entry.credit->>'anv'`
          : sql`null::text`
    const paths = sql.join(
      creditPaths[source].map((path) => sql`(${path})`),
      sql`, `,
    )
    return sql`
      select m.artist_id, m.artist_name, ${id} as external_id, ${artistName} as name, ${creditedName} as credited_name,
        state.provider, m.media_type::text as kind, m.id, m.title,
        state.latest_snapshot_id as snapshot_id, snapshot.scrape_job_id as job_id,
        coalesce(snapshot.created_at, state.last_successful_at, state.updated_at) as created_at
      from linked_music m join provider_current_state state on state.media_item_id = m.id
      left join provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
      cross join (values ${paths}) as pattern(path)
      cross join lateral jsonb_path_query(state.payload, pattern.path::jsonpath) as entry(credit)
      where state.provider = ${source} and state.status = 'ready'
    `
  })
  const spotifyEvidence = providers.includes('spotify')
    ? sql`
      union all
      select m.artist_id, m.artist_name, credit.artist->>'id', credit.artist->>'name', null::text,
        'spotify', 'track', m.id, m.title, null::text, job.id, job.created_at
      from linked_music m
      left join scrape_job job on job.id = m.metadata#>>'{spotifyArtistCreditsSource,jobId}'
      cross join lateral jsonb_path_query(m.metadata, '$.spotifyArtistCredits[*]'::jsonpath) as credit(artist)
      where m.media_type = 'track'
      union all
      select m.artist_id, m.artist_name, credit.artist->>'id', credit.artist->>'name', null::text,
        'spotify', 'album', album.id, album.title,
        coalesce(history.id, state.latest_snapshot_id),
        case when history.id is not null then history.scrape_job_id else snapshot.scrape_job_id end,
        coalesce(history.created_at, snapshot.created_at, state.last_successful_at, state.updated_at)
      from linked_music m
      join library_track track on track.media_item_id = m.id
      join lateral (
        select membership.album_media_item_id, coalesce(membership.external_id, track.spotify_track_id) as spotify_track_id
        from track membership where membership.track_media_item_id = m.id
        union
        select track.album_media_item_id, track.spotify_track_id
        where track.album_media_item_id is not null
      ) album_track on true
      join provider_current_state state on state.media_item_id = album_track.album_media_item_id
        and state.provider = 'spotify' and state.status = 'ready'
      join media_item album on album.id = state.media_item_id
        and album.metadata->>'legacyHidden' is distinct from 'true'
      left join provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
      left join lateral (
        select saved.id, saved.payload, saved.scrape_job_id, saved.created_at
        from provider_snapshot saved
        where saved.media_item_id = album.id and saved.provider = 'spotify'
          and not ${hasSpotifyTrackCredits(sql`state.payload`)}
          and ${hasSpotifyTrackCredits(sql`saved.payload`)}
        order by saved.created_at desc, saved.id desc
        limit 1
      ) history on true
      cross join (values ${sql.join(
        spotifyTrackCreditPaths.map((path) => sql`(${path})`),
        sql`, `,
      )}) as pattern(path)
      cross join lateral jsonb_path_query(coalesce(history.payload, state.payload), pattern.path::jsonpath,
        jsonb_build_object('track_id', album_track.spotify_track_id)) as credit(artist)
      where album_track.spotify_track_id is not null
    `
    : sql``
  const listeningEvidence = providers.includes('lastfm')
    ? sql`
        union all
        select m.artist_id, m.artist_name, scrobble.artist_mbid, scrobble.artist_name, null::text,
          'lastfm', 'album', m.id, m.title, null::text, null::text, min(scrobble.created_at)
        from linked_music m
        join lastfm_scrobble scrobble on scrobble.album_media_item_id = m.id
        where scrobble.artist_mbid is not null
        group by m.artist_id, m.artist_name, scrobble.artist_mbid, scrobble.artist_name, m.id, m.title
        union all
        select m.artist_id, m.artist_name, scrobble.artist_mbid, scrobble.artist_name, null::text,
          'lastfm', 'track', m.id, m.title, null::text, null::text, min(scrobble.created_at)
        from linked_music m
        join lastfm_track_source source on source.track_media_item_id = m.id
        join lastfm_scrobble scrobble on scrobble.username = source.username
          and scrobble.artist_key = source.artist_key and scrobble.track_key = source.track_key
        where scrobble.artist_mbid is not null
        group by m.artist_id, m.artist_name, scrobble.artist_mbid, scrobble.artist_name, m.id, m.title
      `
    : sql``
  return sql`
    with linked_music as (
      select target.id as artist_id, target.name as artist_name,
        m.id, m.title, m.media_type, m.metadata
      from (${targets}) target join media_credit c on c.artist_id = target.id
      join media_item m on m.id = c.media_item_id
      where c.role = 'artist'
        and m.media_type in ('album', 'track')
        and m.metadata->>'legacyHidden' is distinct from 'true'
    )
    ${sql.join(nativeCredits, sql` union all `)}
    ${spotifyEvidence}
    ${listeningEvidence}
  `
}

function evidenceQuery(
  artistId: string,
  name: string,
  provider: ArtistProfileProvider,
) {
  const providers = evidenceProviders(provider)
  return sql`
    with evidence as (
      (${artistCreditEvidenceQuery(sql`select ${artistId}::text as id, ${name}::text as name`, providers)})
      union all
      select ${artistId}, ${name}, snapshot.normalized_data->>'externalId', ${name}, null::text,
        snapshot.provider, 'artist', ${artistId}, ${name}, snapshot.id,
        snapshot.scrape_job_id, snapshot.created_at
      from artist_provider_current_state state
      join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
      where state.artist_id = ${artistId} and state.provider in (${sql.join(
        providers.map((value) => sql`${value}`),
        sql`, `,
      )})
    )
  `
}

async function acceptedEvidence(
  artistId: string,
  name: string,
  provider: ArtistProfileProvider,
) {
  const evidence = EvidenceRowsSchema.parse(
    (
      await db.execute(sql`
    ${evidenceQuery(artistId, name, provider)}
    select distinct external_id, name, credited_name from evidence
    where external_id is not null and name is not null
    order by name, external_id, credited_name
  `)
    ).rows,
  )
  const expected = artistNameKey(name)
  return evidence.flatMap((row): AcceptedEvidence[] => {
    const exact =
      artistNameKey(row.name) === expected ||
      (row.credited_name !== null &&
        artistNameKey(row.credited_name) === expected)
    if (!exact && !artistSearchNameMatches(provider, row.name, name)) return []
    const normalizedId = normalizeArtistProviderId(provider, row.external_id)
    return normalizedId ? [{ ...row, normalizedId, exact }] : []
  })
}

/** Read native artist credits from linked library records without provider calls. */
export async function listStoredArtistProviderCandidates(
  artistId: string,
  name: string,
  provider: ArtistProfileProvider,
) {
  const candidates = new Map<string, ArtistCandidate & { exact: boolean }>()
  for (const row of await acceptedEvidence(artistId, name, provider)) {
    if (candidates.get(row.normalizedId)?.exact) continue
    candidates.set(row.normalizedId, {
      id: row.normalizedId,
      name: row.name,
      exact: row.exact,
    })
  }
  const values = [...candidates.values()]
  if (provider === 'lastfm' && values.length === 2) {
    const mbid = values.find((candidate) =>
      normalizeArtistProviderId('musicbrainz', candidate.id),
    )
    const url = values.find((candidate) => candidate.id.startsWith('https://'))
    if (mbid && url) {
      const slug = new URL(url.id).pathname.split('/')[2]
      // A native Last.fm URL naming this artist is an alternate lookup form,
      // not a conflicting identity beside its single corroborated MBID.
      if (
        slug &&
        artistNameKey(decodeURIComponent(slug.replaceAll('+', ' '))) ===
          artistNameKey(name)
      )
        return [mbid]
    }
  }
  return values
}

export function identifierUrl(provider: ArtistProfileProvider, id: string) {
  switch (provider) {
    case 'spotify':
      return 'https://open.spotify.com/artist/' + id
    case 'discogs':
      return 'https://www.discogs.com/artist/' + id
    case 'musicbrainz':
      return 'https://musicbrainz.org/artist/' + id
    case 'lastfm':
      return id.startsWith('https://') ? id : null
  }
}

export async function listArtistIdentifiers(
  artistId: string,
  name: string,
  profiles: ArtistProviderSnapshot[],
): Promise<ArtistIdentifier[]> {
  const builtin = await Promise.all(
    ArtistProfileProviderSchema.options.map(
      async (provider): Promise<ArtistIdentifier> => {
        const profile = profiles.find(
          (snapshot) => snapshot.provider === provider,
        )?.profile
        const saved = profile?.externalId
          ? normalizeArtistProviderId(provider, profile.externalId)
          : null
        if (saved)
          return {
            provider,
            externalId: saved,
            status: 'confirmed',
            url: profile?.url ?? identifierUrl(provider, saved),
          }
        const candidates = await listStoredArtistProviderCandidates(
          artistId,
          name,
          provider,
        )
        const [candidate] = candidates
        if (candidates.length > 1)
          return { provider, externalId: null, status: 'conflict', url: null }
        if (candidate?.exact)
          return {
            provider,
            externalId: candidate.id,
            status: 'inferred',
            url: identifierUrl(provider, candidate.id),
          }
        return { provider, externalId: null, status: 'missing', url: null }
      },
    ),
  )
  return [
    ...builtin,
    ...profiles.flatMap(({ provider, profile }): ArtistIdentifier[] =>
      ArtistProfileProviderSchema.safeParse(provider).success ||
      !profile.externalId
        ? []
        : [
            {
              provider,
              externalId: profile.externalId,
              status: 'confirmed',
              url: profile.url ?? null,
            },
          ],
    ),
  ]
}

export async function listArtistIdentifierSources(
  artistId: string,
  provider: ArtistProviderId,
  { page, size }: { page: number; size: number },
) {
  const target = await db.query.artist.findFirst({
    where: (table, operators) => operators.eq(table.id, artistId),
  })
  if (!target)
    throw new ServerError({ statusCode: 404, message: 'Artist not found.' })
  const builtin = ArtistProfileProviderSchema.safeParse(provider)
  if (!builtin.success) {
    const row = (await listCurrentArtistProfiles(artistId)).find(
      (snapshot) => snapshot.provider === provider,
    )
    const externalId = row?.profile.externalId
    const items =
      row && externalId && page === 1
        ? [
            {
              externalId,
              provider,
              kind: 'artist',
              id: artistId,
              title: target.name,
              snapshotId: row.id,
              jobId: row.scrapeJobId,
              createdAt: row.createdAt,
            },
          ]
        : []
    const totalCount = externalId ? 1 : 0
    return ArtistIdentifierSourcePageSchema.parse({
      page,
      size,
      totalCount,
      pageCount: totalCount,
      items,
    })
  }
  const accepted = await acceptedEvidence(artistId, target.name, builtin.data)
  if (!accepted.length)
    return { page, size, totalCount: 0, pageCount: 0, items: [] }
  const values = sql.join(
    accepted.map(
      (row) =>
        sql`(${row.external_id}, ${row.name}, ${row.credited_name}, ${row.normalizedId})`,
    ),
    sql`, `,
  )
  const sourceQuery = sql`
    ${evidenceQuery(artistId, target.name, builtin.data)},
    accepted(raw_id, name, credited_name, normalized_id) as (values ${values}),
    sources as (
      select distinct a.normalized_id as "externalId", e.provider, e.kind, e.id, e.title,
        e.snapshot_id as "snapshotId", e.job_id as "jobId", e.created_at
      from evidence e join accepted a on a.raw_id = e.external_id and a.name = e.name
        and a.credited_name is not distinct from e.credited_name
    )
  `
  const [counts, rows] = await Promise.all([
    db.execute(sql`${sourceQuery} select count(*)::int as total from sources`),
    db.execute(sql`${sourceQuery}
      select "externalId", provider, kind, id, title, "snapshotId", "jobId",
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
      from sources order by (kind = 'artist') desc, created_at desc nulls last, kind, title, id, "externalId", provider, "snapshotId"
      limit ${size} offset ${(page - 1) * size}
    `),
  ])
  const total =
    z
      .array(z.object({ total: z.number().int().nonnegative() }))
      .parse(counts.rows)[0]?.total ?? 0
  return ArtistIdentifierSourcePageSchema.parse({
    page,
    size,
    totalCount: total,
    pageCount: Math.ceil(total / size),
    items: rows.rows,
  })
}
