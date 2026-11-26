import type { ImportRun } from '@repo/schemas/imports'
import type { QueryClient } from '@tanstack/react-query'
import type { ButtonFeedback } from '@repo/ui/components/ui/button'
import { formatCount } from '@repo/ui/lib/format'

export const importIdlePollMs = 30_000

export function importRunFeedback(run: ImportRun): ButtonFeedback {
  switch (run.status) {
    case 'queued':
      return run.stage === 'Awaiting queue delivery'
        ? { phase: 'waiting', label: 'Waiting for import worker' }
        : { phase: 'queued', label: 'Import queued' }
    case 'running':
      return {
        phase: 'running',
        label:
          run.stage === 'Queueing selected metadata'
            ? 'Queueing metadata…'
            : run.total
              ? `${formatCount(run.processed)}/${formatCount(run.total)} rows processed`
              : 'Importing…',
      }
    case 'succeeded':
      return run.result?.warnings?.length
        ? { phase: 'partial', label: 'Imported with warnings' }
        : { phase: 'done', label: 'Imported' }
    case 'failed':
      return run.result?.created || run.result?.updated
        ? { phase: 'partial', label: 'Partly imported' }
        : { phase: 'failed', label: 'Import failed' }
    case 'cancelled':
      return { phase: 'cancelled', label: 'Import cancelled' }
  }
}

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
        'artists',
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
        'album-collections',
        'album-collection',
        'album-selection',
        'film-selection',
        'album-picker',
        'lastfm-links',
      ].includes(String(query.queryKey[0])),
  })
}
