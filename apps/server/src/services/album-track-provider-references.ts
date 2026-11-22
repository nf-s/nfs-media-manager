import { and, asc, eq, sql } from 'drizzle-orm'
import type { JsonValue, PluginTrack } from '@repo/media-plugin-sdk'
import { albumNameKey } from '@/lib/album-import-candidates'
import { parseTrackNumberPrefix } from '@/lib/album-track-aliases'
import type { db } from '@/lib/db'
import { validIsrc } from '@/lib/isrc'
import { createStableId } from '@/lib/media-utils'
import { providerReference, track } from '@/schemas/db'
import { recordTrackIsrcs } from './track-isrcs'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const WRITE_BATCH = 500
/** Durations within this many seconds count as the same recording. */
const DURATION_TOLERANCE_SEC = 3

export type AlbumTrackAlignment =
  | 'position-duration'
  | 'position-title'
  | 'title-duration'

export type LibraryAlbumTrack = {
  trackMediaItemId: string
  position: number
  title: string
  durationSec: number | null
}

export type AlignedAlbumTrack = {
  library: LibraryAlbumTrack
  provider: PluginTrack
  alignment: AlbumTrackAlignment
}

const titleKey = (title: string) => albumNameKey(title.normalize('NFC'))

function libraryKeys(title: string) {
  const keys = new Set([titleKey(title)])
  const numbered = parseTrackNumberPrefix(title.trim())
  if (numbered) keys.add(titleKey(numbered.title))
  return keys
}

/** The provider title with and without its ` (version)` suffix. */
function providerKeys(entry: PluginTrack) {
  const keys = new Set([titleKey(entry.title)])
  const suffix = entry.version ? ` (${entry.version})` : undefined
  if (suffix && entry.title.endsWith(suffix))
    keys.add(titleKey(entry.title.slice(0, -suffix.length)))
  return keys
}

const sharesKey = (left: Set<string>, right: Set<string>) =>
  [...left].some((key) => right.has(key))

const closeDurations = (left: number | null, right: number | undefined) =>
  left !== null &&
  right !== undefined &&
  Math.abs(left - right) <= DURATION_TOLERANCE_SEC

/**
 * Pairs a provider's album track list with the library album's tracks.
 * Equal lists pair by position when the durations or titles agree; any track
 * left over pairs only with the one provider track of the same title and
 * duration. No track on either side is paired twice.
 */
export function alignProviderAlbumTracks(
  library: readonly LibraryAlbumTrack[],
  provider: readonly PluginTrack[],
): AlignedAlbumTrack[] {
  const libraryTracks = [...library].sort((a, b) => a.position - b.position)
  const providerTracks = [...provider].sort((a, b) => a.position - b.position)
  const keys = new Map(
    providerTracks.map((entry) => [entry, providerKeys(entry)]),
  )
  const aligned = new Map<LibraryAlbumTrack, AlignedAlbumTrack>()
  const pairedProvider = new Set<PluginTrack>()

  if (libraryTracks.length === providerTracks.length)
    libraryTracks.forEach((entry, index) => {
      const candidate = providerTracks[index]
      if (!candidate) return
      const alignment: AlbumTrackAlignment | undefined = closeDurations(
        entry.durationSec,
        candidate.durationSec,
      )
        ? 'position-duration'
        : sharesKey(libraryKeys(entry.title), keys.get(candidate) ?? new Set())
          ? 'position-title'
          : undefined
      if (!alignment) return
      aligned.set(entry, { library: entry, provider: candidate, alignment })
      pairedProvider.add(candidate)
    })

  const claims = new Map<PluginTrack, LibraryAlbumTrack[]>()
  for (const entry of libraryTracks) {
    if (aligned.has(entry)) continue
    const own = libraryKeys(entry.title)
    const matches = providerTracks.filter(
      (candidate) =>
        sharesKey(own, keys.get(candidate) ?? new Set()) &&
        closeDurations(entry.durationSec, candidate.durationSec),
    )
    const [match] = matches
    if (matches.length !== 1 || !match || pairedProvider.has(match)) continue
    claims.set(match, [...(claims.get(match) ?? []), entry])
  }
  for (const [candidate, entries] of claims) {
    const [entry] = entries
    if (entries.length !== 1 || !entry) continue
    aligned.set(entry, {
      library: entry,
      provider: candidate,
      alignment: 'title-duration',
    })
  }
  return libraryTracks.flatMap((entry) => aligned.get(entry) ?? [])
}

/** Alignments trusted enough to fill a library track's own ISRC. */
const fillsPrimaryIsrc = new Set<AlbumTrackAlignment>([
  'position-duration',
  'title-duration',
])

/**
 * Records a provider's track references and ISRCs on the library tracks its
 * album track list aligns to. References an earlier run wrote for this album
 * are replaced; those from track jobs and other albums are kept.
 */
export async function recordAlbumTrackProviderReferences(
  database: Transaction,
  input: {
    albumId: string
    provider: string
    tracks: readonly PluginTrack[]
    jobId: string | null
  },
  recordedAt = new Date(),
) {
  const source = `${input.provider}-album`
  const library = await database
    .select({
      trackMediaItemId: track.trackMediaItemId,
      position: track.position,
      title: track.title,
      durationSec: track.durationSec,
    })
    .from(track)
    .where(eq(track.albumMediaItemId, input.albumId))
    .orderBy(asc(track.position))
  const aligned = alignProviderAlbumTracks(library, input.tracks)

  await database
    .delete(providerReference)
    .where(
      and(
        eq(providerReference.provider, input.provider),
        eq(providerReference.referenceType, 'track'),
        sql`${providerReference.metadata}->>'source' = ${source}`,
        sql`${providerReference.metadata}->>'albumMediaItemId' = ${input.albumId}`,
      ),
    )

  const rows = new Map<string, typeof providerReference.$inferInsert>()
  for (const { library: entry, provider, alignment } of aligned)
    for (const reference of provider.references ?? []) {
      if (reference.referenceType !== 'track') continue
      const id = createStableId(
        'pref',
        `${entry.trackMediaItemId}:${input.provider}:track:${reference.externalId}`,
      )
      if (rows.has(id)) continue
      const metadata: Record<string, JsonValue> = {
        ...reference.metadata,
        source,
        ...(input.jobId ? { jobId: input.jobId } : {}),
        albumMediaItemId: input.albumId,
        alignment,
        recordedAt: recordedAt.toISOString(),
      }
      rows.set(id, {
        id,
        mediaItemId: entry.trackMediaItemId,
        provider: input.provider,
        referenceType: 'track',
        externalId: reference.externalId,
        isPrimary: reference.isPrimary,
        metadata,
      })
    }
  const values = [...rows.values()]
  for (let start = 0; start < values.length; start += WRITE_BATCH)
    // A reference a track job already wrote for the same track is kept.
    await database
      .insert(providerReference)
      .values(values.slice(start, start + WRITE_BATCH))
      .onConflictDoNothing()

  // ISRC sources are typed per provider; only TIDAL albums report them today.
  const jobId = input.jobId
  const isrcs =
    input.provider === 'tidal' && jobId
      ? await recordTrackIsrcs(
          database,
          aligned.map(({ library: entry, provider }) => ({
            mediaItemId: entry.trackMediaItemId,
            isrc: provider.isrc ?? null,
            provider: 'tidal',
            source: { kind: 'tidal-album', jobId },
          })),
          recordedAt,
        )
      : 0

  const primary = new Map<string, string>()
  for (const { library: entry, provider, alignment } of aligned) {
    const isrc = validIsrc(provider.isrc)
    if (!isrc || !fillsPrimaryIsrc.has(alignment)) continue
    if (!primary.has(entry.trackMediaItemId))
      primary.set(entry.trackMediaItemId, isrc)
  }
  const fills = [...primary].map(([id, isrc]) => ({ id, isrc }))
  for (let start = 0; start < fills.length; start += WRITE_BATCH)
    await database.execute(sql`
      update library_track lt
      set isrc = r.isrc, updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(
        fills.slice(start, start + WRITE_BATCH),
      )}::jsonb) as r(id text, isrc text)
      where lt.media_item_id = r.id and lt.isrc is null`)

  return {
    aligned: aligned.length,
    unaligned: library.length - aligned.length,
    isrcs,
  }
}
