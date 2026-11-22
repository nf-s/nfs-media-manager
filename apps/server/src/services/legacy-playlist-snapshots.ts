import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/media-plugin-sdk'
import { removeSpotifyAudioFeatures } from '@repo/schemas/audio-features'
import type { db } from '@/lib/db'
import { validIsrc } from '@/lib/isrc'
import { checksumJson, createStableId } from '@/lib/media-utils'
import { providerSnapshot } from '@/schemas/db'

type Database = Pick<typeof db, 'insert' | 'select'>

/** Raw Spotify playlist track pages saved by the legacy app. */
export const legacyRawPlaylistFile = /-raw\.json$/

/** The snapshot source of a raw playlist file; recovery reads these. */
export const legacyRawPlaylistSource = (filename: string) =>
  `legacy-import:${filename}`

const RawPlaylistItemsSchema = z.array(
  z.object({
    track: z
      .object({
        id: z.string().nullable(),
        external_ids: z
          .object({ isrc: z.string().nullable().optional() })
          .nullable()
          .optional(),
      })
      .nullable(),
  }),
)

/**
 * Stores each raw Spotify playlist file in the legacy data directory as one
 * media-less `spotify` snapshot attributed to the legacy import, without audio
 * features. A file whose content is already stored is not stored again.
 */
export async function preserveLegacyRawPlaylists(
  database: Database,
  directory: string,
  { apply = true }: { apply?: boolean } = {},
) {
  const filenames = (await readdir(directory))
    .filter((name) => legacyRawPlaylistFile.test(name))
    .sort()
  const counts = {
    apply,
    files: filenames.length,
    items: 0,
    tracksWithIsrc: 0,
    stored: 0,
    created: 0,
  }
  for (const filename of filenames) {
    const raw = JsonValueSchema.parse(
      JSON.parse(await readFile(resolve(directory, filename), 'utf8')),
    )
    const items = RawPlaylistItemsSchema.parse(raw)
    const payload = removeSpotifyAudioFeatures(raw).value
    const checksum = checksumJson(payload)
    const id = createStableId('playlist', `${filename}:${checksum}`)
    counts.items += items.length
    counts.tracksWithIsrc += new Set(
      items.flatMap(({ track }) =>
        track?.id && validIsrc(track.external_ids?.isrc) ? [track.id] : [],
      ),
    ).size
    const existing = await database
      .select({ id: providerSnapshot.id })
      .from(providerSnapshot)
      .where(eq(providerSnapshot.id, id))
    if (existing.length) {
      counts.stored += 1
      continue
    }
    if (!apply) continue
    const inserted = await database
      .insert(providerSnapshot)
      .values({
        id,
        provider: 'spotify',
        checksum,
        payload,
        source: legacyRawPlaylistSource(filename),
      })
      .onConflictDoNothing()
      .returning({ id: providerSnapshot.id })
    counts.created += inserted.length
  }
  return counts
}
