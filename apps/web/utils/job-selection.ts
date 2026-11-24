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
  MIX_STATION_SYNC_TASKS,
  MIX_SYNC_TASKS,
  MixStationSchema,
  SPOTIFY_PODCAST_SYNC_TASK,
  SUBSCRIPTION_SYNC_TASKS,
  subscriptionTypeLabels,
} from '@repo/schemas/subscriptions'
import { SPOTIFY_PLAYLIST_ADD_TRACK_TASK } from '@repo/schemas/track-playlist-additions'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import { YOUTUBE_SYNC_TASK } from '@repo/schemas/youtube'
import {
  SONOVAULT_SIMILAR_LOOKUP_TASK,
  SONOVAULT_TRACK_LOOKUP_TASK,
  type SonovaultLookupInputType,
} from '@repo/schemas/sonovault'
import { SONOVAULT_ALBUM_LOOKUP_TASK } from '@repo/schemas/sonovault-album'
import {
  SPOTIFY_SIMILAR_LOOKUP_TASK,
  TIDAL_SIMILAR_TASK,
  TIDAL_TRACK_MATCH_TASK,
} from '@repo/schemas/tidal'
import { formatItemCount } from '@repo/ui/lib/format'
import { playlistJobProgress } from './playlist-sync'
import { ARTIST_ENRICHMENT_TASK } from '@repo/schemas/artist-profiles'
import { SPOTIFY_ARTIST_ALBUMS_TASK } from '@repo/schemas/spotify-artist-albums'

export function isArtistEnrichmentJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === ARTIST_ENRICHMENT_TASK
}

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

/** Station syncs, which fill the Mixes library; retrying one resumes the sync. */
export function isMixSyncJob(job: Pick<Job, 'options'>): boolean {
  const task = getJobTask(job.options)
  return MIX_SYNC_TASKS.some((name) => name === task)
}

/** The station a mix sync job reads, or null for any other job. */
function mixSyncStation(job: Pick<Job, 'options'>) {
  const task = getJobTask(job.options)
  return (
    MixStationSchema.options.find(
      (station) => MIX_STATION_SYNC_TASKS[station] === task,
    ) ?? null
  )
}

export function isScrobbleSpotifySearchJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === LASTFM_SPOTIFY_SEARCH_TASK
}

export function isSpotifyTrackSearchJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === SPOTIFY_TRACK_SEARCH_TASK
}

export function isPlaylistImportJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === SPOTIFY_PLAYLIST_IMPORT_TASK
}

export function isPlaylistListingJob(job: Pick<Job, 'options'>): boolean {
  return getJobTask(job.options) === SPOTIFY_PLAYLIST_LISTING_TASK
}

export function isPlaylistAdditionJob(job: Pick<Job, 'options'>): boolean {
  const task = getJobTask(job.options)
  return (
    task === SPOTIFY_PLAYLIST_ADD_ALBUM_TASK ||
    task === SPOTIFY_PLAYLIST_ADD_TRACK_TASK
  )
}

function filledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** `Title — Artist` of a job's subject, else the title its options saved. */
function subjectName(
  job: Pick<Job, 'options' | 'subject'>,
  savedTitle: unknown,
): string | null {
  if (job.subject)
    return job.subject.artists
      ? `${job.subject.title} — ${job.subject.artists}`
      : job.subject.title
  return filledText(savedTitle) ? savedTitle : null
}

function named(action: string, subject: string | null) {
  return subject ? `${action} · ${subject}` : action
}

function listLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0
}

const lookupInputs: Record<SonovaultLookupInputType, string> = {
  spotify_id: 'Spotify ID',
  isrc: 'ISRC',
  track_name: 'artist and title',
}

const similarNouns = {
  album: { one: 'album', other: 'albums' },
  track: { one: 'track', other: 'tracks' },
}

function similarNoun(kind: unknown) {
  return kind === 'album' ? similarNouns.album : similarNouns.track
}

/**
 * A bulk Sonovault lookup: whether it refreshes, how many tracks it sends
 * and how, and the first of them.
 */
function sonovaultTrackLookupTitle(job: Pick<Job, 'options' | 'subject'>) {
  const { options } = job
  const refresh = options.refresh === true
  const count = listLength(options.trackIds)
  const input =
    options.inputType === 'spotify_id' ||
    options.inputType === 'isrc' ||
    options.inputType === 'track_name'
      ? lookupInputs[options.inputType]
      : null
  const tracks = count
    ? formatItemCount(
        count,
        refresh
          ? { one: 'track', other: 'tracks' }
          : { one: 'selected track', other: 'selected tracks' },
      )
    : null
  const first = subjectName(job, options.trackTitle)
  return [
    `Sonovault track ${refresh ? 'refresh' : 'lookup'}`,
    tracks && input ? `${tracks} by ${input}` : tracks,
    first && count > 1 ? `${first}, …` : first,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Title for a job without media items, or null for media jobs. */
export function jobTaskTitle(
  job: Pick<Job, 'options'> & Partial<Pick<Job, 'subject'>>,
): string | null {
  const task = getJobTask(job.options)
  if (task === SONOVAULT_TRACK_LOOKUP_TASK)
    return sonovaultTrackLookupTitle(job)
  if (task === SONOVAULT_ALBUM_LOOKUP_TASK)
    return named(
      'Sonovault album lookup',
      subjectName(job, job.options.albumTitle),
    )
  if (task === TIDAL_TRACK_MATCH_TASK)
    return named('TIDAL track match', subjectName(job, job.options.trackTitle))
  if (task === TIDAL_SIMILAR_TASK)
    return named(
      `TIDAL similar ${similarNoun(job.options.kind).other}`,
      subjectName(job, job.options.itemTitle),
    )
  if (
    task === SPOTIFY_SIMILAR_LOOKUP_TASK ||
    task === SONOVAULT_SIMILAR_LOOKUP_TASK
  ) {
    const spotify = task === SPOTIFY_SIMILAR_LOOKUP_TASK
    const count = listLength(spotify ? job.options.codes : job.options.tracks)
    const noun = similarNoun(spotify ? job.options.kind : 'track')
    const subject = subjectName(job, null)
    const items = count
      ? formatItemCount(count, {
          one: `similar ${noun.one}`,
          other: `similar ${noun.other}`,
        })
      : `similar ${noun.other}`
    return named(
      spotify ? 'Spotify search' : 'Sonovault lookup',
      subject ? `${items} of ${subject}` : items,
    )
  }
  if (isArtistEnrichmentJob(job))
    return filledText(job.options.artistName)
      ? `Artist enrichment · ${job.options.artistName}`
      : 'Artist enrichment'
  if (task === SPOTIFY_ARTIST_ALBUMS_TASK)
    return named(
      'Spotify artist albums',
      subjectName(job, job.options.artistName),
    )
  if (isScrobbleSyncJob(job)) return 'Scrobble sync'
  if (isYoutubeSyncJob(job)) return 'YouTube subscription sync'
  if (isSpotifyPodcastSyncJob(job)) return 'Spotify podcast sync'
  const station = mixSyncStation(job)
  if (station) return `${subscriptionTypeLabels[station]} mix sync`
  if (isPlaylistImportJob(job)) {
    const { source, name } = job.options
    if (source === 'spotify-liked') return 'Spotify Liked Songs import'
    return filledText(name)
      ? `Spotify playlist import · ${name}`
      : 'Spotify playlist import'
  }
  if (isPlaylistListingJob(job)) return 'Spotify playlist list'
  if (isPlaylistAdditionJob(job)) {
    const track = getJobTask(job.options) === SPOTIFY_PLAYLIST_ADD_TRACK_TASK
    const title = track ? job.options.trackTitle : job.options.albumTitle
    const { playlistName } = job.options
    const label = `Add ${track ? 'track' : 'album'} to Spotify playlist`
    if (filledText(title) && filledText(playlistName))
      return `${label} · ${title} to ${playlistName}`
    return label
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
  if (isSpotifyTrackSearchJob(job)) {
    const title = job.options.trackTitle
    return filledText(title)
      ? `Spotify track search · ${title}`
      : 'Spotify track search'
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
      isMixSyncJob(job) ||
      isScrobbleSpotifySearchJob(job) ||
      isSpotifyTrackSearchJob(job) ||
      isArtistEnrichmentJob(job) ||
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
