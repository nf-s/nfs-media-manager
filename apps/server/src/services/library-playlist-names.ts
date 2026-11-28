import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { LibraryPlaylistLibrary } from '@repo/schemas/library-playlists'
import type { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { listedImportedPlaylist } from './playlist-directory'

export type LibraryPlaylistTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0]

export const playlistNameTaken = () =>
  new ServerError({
    statusCode: 409,
    message: 'A playlist with this name exists.',
  })

/** Albums and Tracks list imported playlists beside their own. */
export const listsImportedPlaylists = (library: LibraryPlaylistLibrary) =>
  library === 'albums' || library === 'tracks'

/** Serializes name checks and writes of one library until the transaction ends. */
export async function lockLibraryPlaylistNames(
  tx: LibraryPlaylistTransaction,
  library: LibraryPlaylistLibrary,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`library-playlist-names:${library}`}))`,
  )
}

const TakenRowsSchema = z.array(z.object({ taken: z.boolean() }))

/**
 * PL-01: a name is unique within its library, ignoring case, among playlists
 * that are not deleted. In Albums and Tracks it must also differ from every
 * imported playlist the directory lists.
 */
export async function isLibraryPlaylistNameTaken(
  tx: LibraryPlaylistTransaction,
  library: LibraryPlaylistLibrary,
  name: string,
  exceptId?: string,
) {
  const imported = listsImportedPlaylists(library)
    ? sql`or exists (select 1 from playlist p
        where ${listedImportedPlaylist} and lower(p.name) = lower(${name}::text))`
    : sql``
  const result = await tx.execute(sql`select (exists (
      select 1 from library_playlist lp
      where lp.library = ${library} and lp.deleted_at is null
        and lower(lp.name) = lower(${name}::text)
        ${exceptId === undefined ? sql`` : sql`and lp.id <> ${exceptId}`}
    ) ${imported}) as taken`)
  return TakenRowsSchema.parse(result.rows)[0]?.taken ?? false
}

const NameRowsSchema = z.array(z.object({ name: z.string() }))

/** Every name a new playlist of the library cannot take, in lower case. */
export async function readTakenLibraryPlaylistNames(
  tx: LibraryPlaylistTransaction,
  library: LibraryPlaylistLibrary,
) {
  const imported = listsImportedPlaylists(library)
    ? sql`union select lower(p.name) from playlist p where ${listedImportedPlaylist}`
    : sql``
  const result = await tx.execute(sql`select lower(lp.name) as name
    from library_playlist lp
    where lp.library = ${library} and lp.deleted_at is null ${imported}`)
  return new Set(NameRowsSchema.parse(result.rows).map((row) => row.name))
}
