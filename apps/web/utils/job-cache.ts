import type { QueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import type { JobActivitySchema, JobPage } from '@repo/schemas/job'
import { canCancelJob } from './job-selection'

type JobActivity = z.infer<typeof JobActivitySchema>

export function jobPagesPollInterval(pages: JobPage[] | undefined) {
  return pages?.some((page) => page.items.some(canCancelJob)) ? 3000 : false
}

export function jobActivityPollInterval(activity: JobActivity | undefined) {
  return activity && activity.queued + activity.running + activity.imports > 0
    ? 4000
    : 30_000
}

/** A cached activity snapshot is a baseline, not a reason to discard library freshness. */
export function invalidateChangedJobActivity(
  client: QueryClient,
  previous: JobActivity | undefined,
  current: JobActivity,
) {
  if (!previous || JSON.stringify(previous) === JSON.stringify(current))
    return Promise.resolve()

  const keys = new Set([
    'jobs',
    'providers',
    'provider-activity',
    'imports',
    'lastfm-sync',
    'subscription-sync',
    'spotify-playlist-imports',
    'spotify-playlists',
    'lastfm-spotify-search',
  ])
  // Failed or cancelled work may have written partial results before stopping.
  if (
    current.completed !== previous.completed ||
    current.completedImports !== previous.completedImports ||
    current.failed !== previous.failed ||
    current.running < previous.running ||
    current.imports < previous.imports
  ) {
    for (const key of [
      'albums',
      'films',
      'tracks',
      'album',
      'film',
      'track',
      'history',
      'album-selection',
      'film-selection',
      'tags',
      'tag-detail',
      'tag-provenance',
      'film-collections',
      'film-collection',
      'playlists',
      'playlist',
      'album-playlists',
      'playlist-additions',
      'track-playlist-additions',
      'album-listening',
      'lastfm-links',
      'album-picker',
      'subscriptions',
    ])
      keys.add(key)
  }
  return client.invalidateQueries({
    predicate: (query) => keys.has(String(query.queryKey[0])),
  })
}
