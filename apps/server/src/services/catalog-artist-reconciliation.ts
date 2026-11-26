import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  SpotifyCodeMatchSchema,
  type SpotifyCodeMatch,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { validIsrc } from '@/lib/isrc'
import { spotifyAlbumTrackPaths } from '@/lib/spotify-api'
import { createStableId } from '@/lib/media-utils'
import { spotifyCodeLookup, providerResponse } from '@/schemas/db'
import { normalizeSpotifyCatalogTrack } from './provider-search-task-replay'
import type { ChangeTransaction } from './library-change-effect'
import { scopedSpotifyRetainedBilling } from './scoped-spotify-billing'
import { similarRecordingArtistEvidence } from './similar-recording-artist-evidence'
import { readStoredSimilarPages } from './stored-tidal-similar-pages'

/** Both native artist IDs must identify just one current artist. Names never select a record. */
export async function exactOwners(
  tx: ChangeTransaction,
  provider: string,
  externalId: string,
) {
  const rows = await tx.execute(sql`
    select coalesce(a.merged_into_id, a.id) id from artist a
    where a.catalog_provider = ${provider} and a.catalog_external_id = ${externalId}
    union
    select coalesce(a.merged_into_id, a.id) from artist_provider_current_state s
    join artist a on a.id = s.artist_id
    join artist_provider_snapshot p on p.id = s.latest_snapshot_id and p.artist_id = s.artist_id and p.provider = s.provider
    where s.provider = ${provider} and p.normalized_data->>'externalId' = ${externalId}`)
  return z
    .array(z.object({ id: z.string() }))
    .parse(rows.rows)
    .map((r) => r.id)
}

export async function reconcileArtistPair(
  tx: ChangeTransaction,
  sourceId: string,
  targetId: string,
  rule: string,
  apply: boolean,
  sharedBilling?: { trackId: string; position: number },
) {
  if (sourceId === targetId) return false
  if (apply) await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
  const active = await tx.execute(
    sql`select id, catalog_provider, catalog_external_id from artist where id in (${sourceId},${targetId}) and merged_into_id is null order by id ${apply ? sql`for update` : sql``}`,
  )
  if (active.rows.length !== 2) return false
  const previous = await tx.execute(sql`
    select 1 from library_change c join library_change_effect e on e.change_id = c.id
    where c.kind = 'artist' and c.action = 'merge' and c.undone_at is not null
      and e.type = 'artist-merge'
      and e.record_ids && array(select id from artist where id = ${sourceId} or merged_into_id = ${sourceId})
      and e.record_ids && array(select id from artist where id = ${targetId} or merged_into_id = ${targetId})
    limit 1`)
  if (previous.rows.length) return false
  // The journal also handles recording merges that call the catalog writer.
  const { readArtistMerge } = await import('./artist-merge-plan')
  const reading = await readArtistMerge(
    tx,
    { artistIds: [sourceId, targetId], targetId, follow: false },
    apply,
  )
  if (reading.plan.blocked) {
    // Only the source's credits move. A confirmed native Spotify artist can
    // point to an existing performer while that performer's film roles stay put.
    const source = active.rows.find((row) => row.id === sourceId)
    const keepsFilmRoles =
      (rule === 'recording-native-artist-credit' ||
        rule === 'exact-provider-artist-id') &&
      source?.catalog_provider === 'spotify' &&
      ((typeof source.catalog_external_id === 'string' &&
        /^[A-Za-z0-9]{22}$/.test(source.catalog_external_id)) ||
        (source.catalog_external_id === null && sharedBilling !== undefined)) &&
      reading.plan.artists.find((row) => row.id === sourceId)?.blocked === null
    if (!keepsFilmRoles) return false
  }
  for (const caution of reading.plan.cautions) {
    if (caution.code === 'names' && rule === 'exact-provider-artist-id')
      continue
    if (caution.code !== 'together' || caution.items !== 1 || !sharedBilling)
      return false
    // An older playback and its native replacement may occupy the same billing slot.
    const shared =
      await tx.execute(sql`select 1 from media_credit s join media_credit t
      on t.media_item_id=s.media_item_id and t.role=s.role and t.billing_order=s.billing_order
      where s.media_item_id=${sharedBilling.trackId} and s.artist_id=${sourceId} and t.artist_id=${targetId}
        and s.role='artist' and s.billing_order=${sharedBilling.position - 1}`)
    if (!shared.rows.length) return false
  }
  if (apply) {
    const { persistArtistMerge } = await import('./artist-merges')
    await persistArtistMerge(tx, reading, rule)
  }
  return true
}

/** Join independently identifiable credits on the same first-party recording. */
export async function reconcileSimilarArtistCredits(
  tx: ChangeTransaction,
  items: readonly TidalSuggestion[],
  apply = true,
  includesStoredItems = false,
) {
  if (
    !items.some(
      ({ code, artistCredits }) => artistCredits?.length && validIsrc(code),
    )
  )
    return 0
  await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
  const pairs = await similarRecordingArtistEvidence(
    tx,
    items,
    includesStoredItems,
  )
  return reconcileSimilarArtistPairs(tx, pairs, apply)
}

async function reconcileSimilarArtistPairs(
  tx: ChangeTransaction,
  pairs: Awaited<ReturnType<typeof similarRecordingArtistEvidence>>,
  apply: boolean,
) {
  let reconciled = 0
  for (const pair of pairs) {
    const source = await exactOwners(tx, 'tidal', pair.tidalId)
    const target = await exactOwners(tx, 'spotify', pair.spotifyId)
    if (
      source.length !== 1 ||
      !source[0] ||
      target.length !== 1 ||
      !target[0] ||
      source[0] === target[0] ||
      (pair.owner && pair.owner !== target[0])
    )
      continue
    if (
      await reconcileArtistPair(
        tx,
        source[0],
        target[0],
        'matched-recording-artist-ids',
        apply,
      )
    )
      reconciled++
  }
  return reconciled
}

/** Audit or repair a native artist whose exact profile was stored independently after discovery. */
export async function reconcileExactCatalogArtists(
  apply: boolean,
  database = db,
) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
    const rows =
      await tx.execute(sql`select distinct n.id as source, p.provider, n.catalog_external_id as external_id
      from artist n join artist_provider_current_state s on s.provider=n.catalog_provider
      join artist_provider_snapshot p on p.id=s.latest_snapshot_id and p.normalized_data->>'externalId'=n.catalog_external_id
      join artist a on a.id=s.artist_id
      where n.merged_into_id is null
      group by n.id,p.provider,n.catalog_external_id
      having count(distinct coalesce(a.merged_into_id,a.id))=1 and min(coalesce(a.merged_into_id,a.id)) <> n.id`)
    let reconciled = 0
    for (const { source, provider, external_id } of z
      .array(
        z.object({
          source: z.string(),
          provider: z.string(),
          external_id: z.string(),
        }),
      )
      .parse(rows.rows)) {
      const owners = await exactOwners(tx, provider, external_id)
      const target = owners.find((id) => id !== source)
      if (
        owners.length === 2 &&
        target &&
        (await reconcileArtistPair(
          tx,
          source,
          target,
          'exact-provider-artist-id',
          apply,
        ))
      )
        reconciled++
    }
    return reconciled
  })
}

async function scopedSpotifyEvidence(
  tx: Pick<ChangeTransaction, 'execute' | 'select' | 'selectDistinct'>,
  onlyId?: string,
) {
  const rows =
    await tx.execute(sql`select a.id, a.name, m.id as track_id, t.spotify_track_id as spotify_id, o.position,
      coalesce(array_agg(distinct b.external_id) filter (where b.external_id ~ '^[a-zA-Z0-9]{22}$'), '{}'::text[]) as external_ids
      from artist a join catalog_observation o on o.target_kind='artist' and o.target_id=a.id
      join media_item m on m.id=o.subject_id join library_track t on t.media_item_id=m.id
      left join lateral (
        select credit->>'id' as external_id from jsonb_array_elements(case
          when jsonb_typeof(m.metadata->'spotifyArtistBilling')='array' then m.metadata->'spotifyArtistBilling'
          when jsonb_typeof(m.metadata->'spotifyArtistCredits')='array' then m.metadata->'spotifyArtistCredits'
          else '[]'::jsonb end) with ordinality as bill(credit,ordinal)
          where o.position=ordinal and lower(trim(credit->>'name'))=lower(trim(a.name))
        union all
        select n.catalog_external_id from catalog_observation x join artist n on n.id=x.target_id
          where x.subject_kind='track' and x.subject_id=m.id and x.position=o.position and x.provider='spotify'
            and x.target_kind='artist' and x.relationship_role='artist' and n.catalog_provider='spotify' and lower(trim(n.name))=lower(trim(a.name))
        union all
        select bill.credit->>'id' from (
          select p.payload from provider_current_state p
            where p.provider='spotify' and p.media_item_id=t.album_media_item_id
          union all
          select p.payload from provider_snapshot p
            where p.provider='spotify' and p.media_item_id=t.album_media_item_id
        ) p
          cross join lateral (values ${sql.join(
            spotifyAlbumTrackPaths.map((path) => sql`(${path}::text)`),
            sql`, `,
          )}) path(value)
          cross join lateral jsonb_path_query(p.payload,path.value::jsonpath,jsonb_build_object('track_id',t.spotify_track_id)) song
          cross join lateral jsonb_array_elements(case when jsonb_typeof(song->'artists')='array' then song->'artists' else '[]'::jsonb end) with ordinality bill(credit,ordinal)
          where bill.ordinal=o.position and lower(trim(bill.credit->>'name'))=lower(trim(a.name))
      ) b on true
      where a.catalog_provider='spotify' and a.catalog_external_id is null and a.merged_into_id is null
        ${onlyId ? sql`and a.id=${onlyId}` : sql``}
        and o.provider='spotify' and o.subject_kind='track' and o.relationship_role='artist'
        and o.position > 0 and t.spotify_track_id is not null
        and not exists(select 1 from media_credit c where c.artist_id=a.id and c.media_item_id<>m.id)
      group by a.id,a.name,m.id,t.spotify_track_id,o.position`)
  const candidates = z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        track_id: z.string(),
        spotify_id: z.string(),
        position: z.number(),
        external_ids: z.array(z.string()),
      }),
    )
    .parse(rows.rows)
    .filter(
      (row) =>
        row.id ===
        createStableId(
          'catalog-artist',
          JSON.stringify([
            'spotify',
            row.track_id,
            'artist',
            row.position - 1,
            row.name,
          ]),
        ),
    )
  const retained = await scopedSpotifyRetainedBilling(tx, candidates)
  return candidates.flatMap(({ external_ids, ...candidate }) => {
    const [external_id, conflict] = new Set([
      ...external_ids,
      ...retained(candidate),
    ])
    return external_id && !conflict ? [{ ...candidate, external_id }] : []
  })
}

/** Keep the shared track-write lock for just one independently reversible artist merge. */
export async function repairScopedSpotifyCredits(
  apply: boolean,
  database = db,
) {
  let reconciled = 0
  for (const candidate of await scopedSpotifyEvidence(database)) {
    const merged = await database.transaction(async (tx) => {
      if (apply) await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
      const row = apply
        ? (await scopedSpotifyEvidence(tx, candidate.id)).find(
            (r) =>
              r.track_id === candidate.track_id &&
              r.external_id === candidate.external_id &&
              r.position === candidate.position,
          )
        : candidate
      if (!row) return false
      if (
        row.id !==
        createStableId(
          'catalog-artist',
          JSON.stringify([
            'spotify',
            row.track_id,
            'artist',
            row.position - 1,
            row.name,
          ]),
        )
      )
        return false
      const owners = await exactOwners(tx, 'spotify', row.external_id)
      const slot = { trackId: row.track_id, position: row.position }
      if (!owners.length) {
        // The retained billing may be the first record of this artist's Spotify ID.
        const rollback = new Error('Roll back provisional artist repair')
        let eligible = false
        try {
          await tx.transaction(async (savepoint) => {
            const { observeNamedArtistIdentities } =
              await import('./catalog-artist-identities')
            const identities = await observeNamedArtistIdentities(
              savepoint,
              'spotify',
              new Map([[row.external_id, row.name]]),
            )
            const target = identities.get(row.external_id)
            if (target)
              eligible = await reconcileArtistPair(
                savepoint,
                row.id,
                target,
                'recording-native-artist-credit',
                apply,
                slot,
              )
            if (!apply || !eligible) throw rollback
          })
        } catch (error) {
          if (error !== rollback) throw error
        }
        return eligible
      }
      return Boolean(
        owners.length === 1 &&
        owners[0] &&
        (await reconcileArtistPair(
          tx,
          row.id,
          owners[0],
          'recording-native-artist-credit',
          apply,
          slot,
        )),
      )
    })
    if (merged) reconciled++
  }
  return reconciled
}

/** Older lookup results omitted artist IDs. Recover only the selected Spotify recording from its own successful retained responses. */
async function restoreLookupCredits(tx: ChangeTransaction, codes: string[]) {
  if (!codes.length) return
  const rows = await tx
    .select()
    .from(spotifyCodeLookup)
    .where(
      and(
        eq(spotifyCodeLookup.source, 'spotify'),
        eq(spotifyCodeLookup.codeType, 'isrc'),
        inArray(spotifyCodeLookup.code, codes),
      ),
    )
  for (const row of rows) {
    const match = SpotifyCodeMatchSchema.safeParse(row.result).data
    if (
      !match ||
      match.artistCredits ||
      match.spotifyId !== row.spotifyId ||
      !row.scrapeJobId
    )
      continue
    const captures = await tx
      .select({ body: providerResponse.body })
      .from(providerResponse)
      .where(
        and(
          eq(providerResponse.provider, 'spotify'),
          eq(providerResponse.jobId, row.scrapeJobId),
          eq(providerResponse.phase, 'task'),
          eq(providerResponse.status, 200),
          eq(providerResponse.bodyState, 'captured'),
        ),
      )
    const billings = new Map<
      string,
      NonNullable<SpotifyCodeMatch['artistCredits']>
    >()
    for (const { body } of captures) {
      if (body.state !== 'captured') continue
      let payload: unknown
      try {
        payload = JSON.parse(body.text)
      } catch {
        continue
      }
      const page = z
        .object({ tracks: z.object({ items: z.array(z.unknown()) }) })
        .safeParse(payload)
      for (const raw of page.data?.tracks.items ?? []) {
        const track = normalizeSpotifyCatalogTrack(raw)
        if (
          track?.spotifyTrackId === match.spotifyId &&
          validIsrc(track.isrc) === row.code
        )
          billings.set(JSON.stringify(track.artistCredits), track.artistCredits)
      }
    }
    const [artistCredits] = billings.values()
    if (billings.size === 1 && artistCredits?.length)
      await tx
        .update(spotifyCodeLookup)
        .set({ result: { ...match, artistCredits } })
        .where(
          and(
            eq(spotifyCodeLookup.codeType, 'isrc'),
            eq(spotifyCodeLookup.code, row.code),
            eq(spotifyCodeLookup.scrapeJobId, row.scrapeJobId),
            eq(spotifyCodeLookup.source, 'spotify'),
            eq(spotifyCodeLookup.spotifyId, match.spotifyId),
          ),
        )
  }
}

export async function repairStoredSimilarArtists(
  apply: boolean,
  database = db,
) {
  let merged = 0
  const dryRun = Symbol('artist repair dry run')
  try {
    await database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
      const { pages } = await readStoredSimilarPages(tx, 'artist-credits')
      const items = pages.flatMap((page) => page.items)
      const codes = [
        ...new Set(items.flatMap((item) => validIsrc(item.code) ?? [])),
      ]
      for (let i = 0; i < codes.length; i += 100)
        await restoreLookupCredits(tx, codes.slice(i, i + 100))
      const pairs = await similarRecordingArtistEvidence(tx, items, true)
      const { repairProvisionalTidalSimilarArtists } =
        await import('./tidal-provisional-artist-repair')
      merged = await repairProvisionalTidalSimilarArtists(
        tx,
        pages.filter((page) => page.source === 'receipt'),
        pairs,
      )
      merged += await reconcileSimilarArtistPairs(tx, pairs, true)
      if (!apply) throw dryRun
    })
  } catch (error) {
    if (error !== dryRun) throw error
  }
  return merged
}
