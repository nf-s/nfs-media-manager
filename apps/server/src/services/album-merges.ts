import type {
  AlbumMergePlan,
  AlbumMergePlanRequest,
  AlbumMergeRequest,
  AlbumNameMovePlanRequest,
  AlbumNameMoveRequest,
  AlbumSeparateRequest,
} from '@repo/schemas/album-merges'
import type {
  LibraryChange,
  LibraryChangeAction,
  LibraryChangeDetails,
} from '@repo/schemas/library-changes'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { lockLibraryTrackWrites } from './album-library-tracks'
import {
  albumEditionEffect,
  readAlbumListening,
  readEditionOf,
  writeEditionOf,
} from './album-merge-effects'
import { readAlbumMerge, readAlbumMergePlan } from './album-merge-plan'
import { moveAlbumNames } from './album-names'
import { clearKeptSeparate } from './keep-separate-effects'
import { refreshAlbumListening } from './lastfm-album-links'
import type { ChangeEffectEntry } from './library-change-effect'
import {
  getLibraryChange,
  readChangeRecords,
  recordChange,
} from './library-changes'
import { getLastfmAccount } from './lastfm-scrobbles'

const unique = (ids: (string | null)[]) => [
  ...new Set(ids.flatMap((id) => (id === null ? [] : [id]))),
]

const nameMove = ({
  albumId,
  artistName,
  albumName,
  follow,
}: AlbumNameMovePlanRequest): AlbumMergePlanRequest => ({
  albumIds: [albumId],
  targetId: albumId,
  names: [{ artistName, albumName }],
  follow,
})

/** The plan the Merge button reads before it merges or opens a review. */
export async function planAlbumMerge(
  input: AlbumMergePlanRequest,
): Promise<AlbumMergePlan> {
  return readAlbumMergePlan(await getLastfmAccount(), input)
}

/** What moving one scrobbled album name to an album would do. */
export async function planAlbumNameMove(
  input: AlbumNameMovePlanRequest,
): Promise<AlbumMergePlan> {
  return readAlbumMergePlan(await getLastfmAccount(), nameMove(input))
}

async function makeAlbumMerge(
  selection: AlbumMergePlanRequest,
  reviewed: boolean,
  action: LibraryChangeAction,
): Promise<LibraryChange> {
  const account = await getLastfmAccount()
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const { plan, names, follow } = await readAlbumMerge(
      tx,
      account,
      selection,
      true,
    )
    if (plan.blocked === 'hidden')
      throw new ServerError({
        statusCode: 409,
        message: 'Albums removed from the library cannot be merged.',
      })
    if (plan.blocked === 'same-record')
      throw new ServerError({
        statusCode: 409,
        message: 'These albums are one record already.',
      })
    if (plan.cautions.length && !reviewed)
      throw new ServerError({
        statusCode: 409,
        message: 'Review this merge before it is made.',
      })

    const effects: ChangeEffectEntry[] = []
    const steps = plan.editions.map((edition) => ({
      id: edition.albumId,
      from: edition.fromId,
      to: plan.targetId,
    }))
    const regrouped = unique([
      plan.targetId,
      ...steps.flatMap((step) => [step.id, step.from]),
    ])
    if (steps.length) {
      const listening = await readAlbumListening(tx, regrouped)
      await writeEditionOf(
        tx,
        steps.map((step) => ({ id: step.id, editionOf: step.to })),
      )
      effects.push(albumEditionEffect(steps, listening))
    }
    const moved =
      account && names.length
        ? await moveAlbumNames(tx, account, names, plan.targetId, follow)
        : null
    effects.push(...(moved?.effects ?? []))
    const cleared = await clearKeptSeparate(tx, 'album', selection.albumIds)
    if (cleared) effects.push(cleared)
    if (steps.length) await refreshAlbumListening(tx, regrouped)

    const titles = new Map(plan.albums.map((album) => [album.id, album.title]))
    const counts: NonNullable<LibraryChangeDetails['counts']> = {}
    if (steps.length) counts.edition = steps.length
    if (moved?.albumNames) counts['album-name'] = moved.albumNames
    if (moved?.titles) counts.title = moved.titles
    const labels = [
      ...plan.names.map((name) => name.albumName),
      ...steps.flatMap((step) => {
        const title = titles.get(step.id)
        return title === undefined ? [] : [title]
      }),
    ].slice(0, 5)
    const [target] = await readChangeRecords(tx, 'album', [plan.targetId])
    const changeId = await recordChange(
      tx,
      {
        kind: 'album',
        action,
        target: target ?? null,
        sources: await readChangeRecords(
          tx,
          'album',
          unique([
            ...selection.albumIds,
            ...plan.names.map((name) => name.albumId),
          ]).filter((id) => id !== plan.targetId),
        ),
        details: { counts, labels },
      },
      { draft: moved?.draft, effects },
    )
    if (!changeId)
      throw new ServerError({
        statusCode: 409,
        message: 'Nothing here needs merging.',
      })
    return getLibraryChange(changeId, tx)
  })
}

/**
 * Merges the selected albums into one record and records the change: the
 * others become editions of the album to keep, and the given album names
 * move to it with the track names that follow. A plan with cautions must
 * have been reviewed.
 */
export async function mergeAlbums({
  reviewed,
  ...selection
}: AlbumMergeRequest): Promise<LibraryChange> {
  return makeAlbumMerge(selection, reviewed, 'merge')
}

/** Moves one scrobbled album name to an album and records the change. */
export async function moveAlbumName({
  reviewed,
  ...selection
}: AlbumNameMoveRequest): Promise<LibraryChange> {
  return makeAlbumMerge(nameMove(selection), reviewed, 'move')
}

/** Gives an edition its own record again and records the change. */
export async function separateAlbumEdition({
  albumId,
}: AlbumSeparateRequest): Promise<LibraryChange> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const editionOf = await readEditionOf(tx, [albumId])
    if (!editionOf.has(albumId))
      throw new ServerError({ statusCode: 404, message: 'Album not found.' })
    const first = editionOf.get(albumId) ?? null
    if (first === null)
      throw new ServerError({
        statusCode: 409,
        message: 'This album is not an edition of another album.',
      })
    const steps = [{ id: albumId, from: first, to: null }]
    const listening = await readAlbumListening(tx, [albumId, first])
    await writeEditionOf(tx, [{ id: albumId, editionOf: null }])
    await refreshAlbumListening(tx, [albumId, first])
    const [target] = await readChangeRecords(tx, 'album', [albumId])
    const changeId = await recordChange(
      tx,
      {
        kind: 'album',
        action: 'separate',
        target: target ?? null,
        sources: await readChangeRecords(tx, 'album', [first]),
        details: {
          counts: { edition: 1 },
          labels: target ? [target.title] : [],
        },
      },
      { effects: [albumEditionEffect(steps, listening)] },
    )
    if (!changeId)
      throw new ServerError({
        statusCode: 409,
        message: 'This album is not an edition of another album.',
      })
    return getLibraryChange(changeId, tx)
  })
}
