import {
  getJobDismissal,
  getJobProgress,
  getJobTask,
  isRetryableJobStatus,
  isUnfinishedJobItem,
  type Job,
} from '@repo/schemas/job'
import {
  LASTFM_SCROBBLE_SYNC_TASK,
  LASTFM_SPOTIFY_SEARCH_TASK,
} from '@repo/schemas/lastfm'
import {
  SPOTIFY_PLAYLIST_ADD_ALBUM_TASK,
  SPOTIFY_PLAYLIST_IMPORT_TASK,
  SPOTIFY_PLAYLIST_LISTING_TASK,
} from '@repo/schemas/tracks'
import {
  SPOTIFY_PODCAST_SYNC_TASK,
  SUBSCRIPTION_SYNC_TASKS,
} from '@repo/schemas/subscriptions'
import { YOUTUBE_SYNC_TASK } from '@repo/schemas/youtube'
import { playlistJobProgress } from './playlist-sync'

/** Scrobble sync jobs are account-level and have no media items. */
export function isScrobbleSyncJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === LASTFM_SCROBBLE_SYNC_TASK
}

/** YouTube subscription sync jobs are account-level; retrying one resumes the sync. */
export function isYoutubeSyncJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === YOUTUBE_SYNC_TASK
}

/** Spotify podcast sync jobs are account-level; retrying one resumes the sync. */
export function isSpotifyPodcastSyncJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === SPOTIFY_PODCAST_SYNC_TASK
}

/** YouTube and Spotify podcast syncs, which fill the Subscriptions library. */
export function isSubscriptionSyncJob(job: Pick<Job, 'options'>): boolean {
  const task = getJobTask(job.options)
  return SUBSCRIPTION_SYNC_TASKS.some((name) => name === task)
}

export function isScrobbleSpotifySearchJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === LASTFM_SPOTIFY_SEARCH_TASK
}

export function isPlaylistImportJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === SPOTIFY_PLAYLIST_IMPORT_TASK
}

export function isPlaylistListingJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === SPOTIFY_PLAYLIST_LISTING_TASK
}

export function isPlaylistAdditionJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === SPOTIFY_PLAYLIST_ADD_ALBUM_TASK
}

function filledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Title for a job without media items, or null for media jobs. */
export function jobTaskTitle(job: Pick<Job, 'options'>): string | null {
  if (isScrobbleSyncJob(job)) return 'Scrobble sync'
  if (isYoutubeSyncJob(job)) return 'YouTube subscription sync'
  if (isSpotifyPodcastSyncJob(job)) return 'Spotify podcast sync'
  if (isPlaylistImportJob(job)) {
    const { source, name } = job.options
    if (source === 'spotify-liked') return 'Spotify Liked Songs import'
    return filledText(name)
      ? `Spotify playlist import · ${name}`
      : 'Spotify playlist import'
  }
  if (isPlaylistListingJob(job)) return 'Spotify playlist list'
  if (isPlaylistAdditionJob(job)) {
    const { albumTitle, playlistName } = job.options
    if (filledText(albumTitle) && filledText(playlistName))
      return `Add album to Spotify playlist · ${albumTitle} to ${playlistName}`
    return 'Add album to Spotify playlist'
  }
  if (isScrobbleSpotifySearchJob(job)) {
    const { artistName, albumName } = job.options
    const target = [artistName, albumName].filter(
      (name) => typeof name === 'string' && name.trim().length > 0,
    )
    return target.length
      ? `Spotify album search · ${target.join(' — ')}`
      : 'Spotify album search'
  }
  return null
}

export function canCancelJob(job: Pick<Job, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running'
}

export function canDismissJob(job: Job): boolean {
  return (
    (job.status === 'failed' || job.status === 'cancelled') &&
    !getJobDismissal(job.options)
  )
}

export function unfinishedJobItems(job: Job): number {
  return job.items.filter(
    (item) => item.mediaItemId && isUnfinishedJobItem(item.status, job.status),
  ).length
}

export function canRetryJob(job: Job): boolean {
  return (
    isRetryableJobStatus(job.status) &&
    typeof job.options.retryJobId !== 'string' &&
    (unfinishedJobItems(job) > 0 ||
      isScrobbleSyncJob(job) ||
      isYoutubeSyncJob(job) ||
      isSpotifyPodcastSyncJob(job) ||
      isScrobbleSpotifySearchJob(job) ||
      isPlaylistImportJob(job) ||
      isPlaylistListingJob(job) ||
      isPlaylistAdditionJob(job))
  )
}

/** Page progress of a queued or running job that reads pages. */
export function activeJobProgressLabel(
  job: Pick<Job, 'options' | 'status'>,
): string | null {
  return canCancelJob(job)
    ? playlistJobProgress(getJobProgress(job.options))
    : null
}

export function updateJobSelection(
  selectedIds: string[],
  orderedIds: string[],
  clickedId: string,
  anchorId: string | null,
  shift: boolean,
  checked: boolean,
): string[] {
  const end = orderedIds.indexOf(clickedId)
  if (end < 0) return selectedIds
  const start = shift && anchorId ? orderedIds.indexOf(anchorId) : -1
  const range =
    start < 0
      ? [clickedId]
      : orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1)
  const selected = new Set(selectedIds)
  for (const id of range) {
    if (checked) selected.add(id)
    else selected.delete(id)
  }
  return [...selected]
}
