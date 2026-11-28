import { inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  LibraryPlaylistNameSchema,
  parseLibraryBrowseView,
  savedViewParams,
} from '@repo/schemas/library-playlists'
import { db } from '@/lib/db'
import { libraryPlaylist } from '@/schemas/db'
import { listConvertibleSavedViews } from './imports'
import {
  lockLibraryPlaylistNames,
  readTakenLibraryPlaylistNames,
} from './library-playlist-names'

/** The first free name: the name itself, then "Name 2", "Name 3" and so on. */
function freeName(name: string, taken: ReadonlySet<string>) {
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? '' : ` ${number}`
    const candidate = `${name.slice(0, 200 - suffix.length).trimEnd()}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * PL-05: inserts each view of the newest legacy saved-view import as an Albums
 * smart playlist, keyed by its name. A view already inserted, including one
 * the owner deleted, is left alone; a taken name gets a numbered suffix.
 * Returns how many were inserted.
 */
export async function insertLegacySavedViews() {
  const keys = new Set<string>()
  const views = (await listConvertibleSavedViews()).flatMap((saved) => {
    const name = LibraryPlaylistNameSchema.safeParse(saved.name)
    const view = savedViewParams(saved)
    if (
      !name.success ||
      keys.has(saved.name) ||
      !parseLibraryBrowseView('albums', view).success
    )
      return []
    keys.add(saved.name)
    return [{ legacyKey: saved.name, name: name.data, view }]
  })
  if (!views.length) return 0
  return db.transaction(async (tx) => {
    await lockLibraryPlaylistNames(tx, 'albums')
    const existing = new Set(
      (
        await tx
          .select({ legacyKey: libraryPlaylist.legacyKey })
          .from(libraryPlaylist)
          .where(inArray(libraryPlaylist.legacyKey, [...keys]))
      ).map((row) => row.legacyKey),
    )
    const missing = views.filter((view) => !existing.has(view.legacyKey))
    if (!missing.length) return 0
    const taken = await readTakenLibraryPlaylistNames(tx, 'albums')
    const rows = missing.map((view): typeof libraryPlaylist.$inferInsert => {
      const name = freeName(view.name, taken)
      taken.add(name.toLowerCase())
      return {
        id: nanoid(),
        library: 'albums',
        type: 'smart',
        name,
        view: view.view,
        legacyKey: view.legacyKey,
      }
    })
    const inserted = await tx
      .insert(libraryPlaylist)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: libraryPlaylist.id })
    return inserted.length
  })
}

let legacyViewsInserted: Promise<number> | undefined

/** Runs the legacy insert once per process, again after a failure. */
export function ensureLegacySavedViews() {
  legacyViewsInserted ??= insertLegacySavedViews().catch((error: unknown) => {
    legacyViewsInserted = undefined
    throw error
  })
  return legacyViewsInserted
}
