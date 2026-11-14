import type { ImportRun } from '@repo/schemas/imports'
import type { QueryClient } from '@tanstack/react-query'

export const importIdlePollMs = 30_000

export function importPollInterval(
  runs: ReadonlyArray<Pick<ImportRun, 'status'>> | undefined,
) {
  return runs?.some(
    (run) => run.status === 'running' || run.status === 'queued',
  )
    ? 2000
    : importIdlePollMs
}

export function hasNewlyCompletedImports(
  previous: ReadonlyArray<Pick<ImportRun, 'id' | 'status' | 'finishedAt'>>,
  current: ReadonlyArray<Pick<ImportRun, 'id' | 'status' | 'finishedAt'>>,
) {
  const earlier = new Map(previous.map((run) => [run.id, run]))
  return current.some((run) => {
    if (!run.finishedAt) return false
    const before = earlier.get(run.id)
    return (
      !before ||
      before.finishedAt !== run.finishedAt ||
      before.status !== run.status
    )
  })
}

export function invalidateImportedLibrary(client: QueryClient) {
  return client.invalidateQueries({
    predicate: (query) =>
      [
        'albums',
        'films',
        'album',
        'film',
        'tracks',
        'track',
        'history',
        'jobs',
        'job-activity',
        'tags',
        'tag-detail',
        'tag-provenance',
        'playlists',
        'playlist',
        'album-playlists',
        'film-collections',
        'film-collection',
        'album-selection',
        'film-selection',
        'album-picker',
        'lastfm-links',
      ].includes(String(query.queryKey[0])),
  })
}
