import {
  LibraryChangePageSchema,
  LibraryChangeSchema,
  TrackMergePlanSchema,
  type LibraryChange,
  type LibraryChangeActor,
  type TrackMergeBlock,
  type TrackMergeCaution,
} from '@repo/schemas/library-changes'
import { formatCount, formatTrackLength } from '@repo/ui/lib/format'
import { fetchApiData } from './api'

const base = '/api/v1/library-changes'

function post(body?: unknown): RequestInit {
  return body === undefined
    ? { method: 'POST' }
    : { method: 'POST', body: JSON.stringify(body) }
}

export type TrackMergeSelection = { trackIds: string[]; targetId?: string }

/** What merging the selected tracks would do, and any reason to review it. */
export function planTrackMerge(
  apiBaseUrl: string,
  selection: TrackMergeSelection,
) {
  return fetchApiData(
    apiBaseUrl,
    `${base}/track-merges/plan`,
    TrackMergePlanSchema,
    post(selection),
  )
}

export function mergeTracks(
  apiBaseUrl: string,
  request: TrackMergeSelection & { reviewed: boolean },
) {
  return fetchApiData(
    apiBaseUrl,
    `${base}/track-merges`,
    LibraryChangeSchema,
    post(request),
  )
}

/** Undoes a change, or makes an undone change again. */
export function toggleLibraryChange(apiBaseUrl: string, change: LibraryChange) {
  return fetchApiData(
    apiBaseUrl,
    `${base}/${encodeURIComponent(change.id)}/${change.undoneAt ? 'redo' : 'undo'}`,
    LibraryChangeSchema,
    post(),
  )
}

export type LibraryChangeQuery = {
  page?: number
  size?: number
  actor?: LibraryChangeActor
  /** Only changes that moved a name into or out of this track. */
  recordId?: string
}

export const libraryChangesKey = (query: LibraryChangeQuery = {}) => [
  'library-changes',
  query,
]

export function loadLibraryChanges(
  apiBaseUrl: string,
  { page, size, actor, recordId }: LibraryChangeQuery,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams()
  if (page !== undefined) params.set('page', String(page))
  if (size !== undefined) params.set('size', String(size))
  if (actor) params.set('actor', actor)
  if (recordId) params.set('recordId', recordId)
  return fetchApiData(
    apiBaseUrl,
    `${base}${params.size ? `?${params}` : ''}`,
    LibraryChangePageSchema,
    { signal },
  )
}

const quoted = (title: string) => `“${title}”`
const listed = new Intl.ListFormat('en', {
  style: 'long',
  type: 'conjunction',
})

function movedNames(change: LibraryChange) {
  const [first] = change.names
  return change.nameCount === 1 && first
    ? quoted(first.trackName)
    : `${formatCount(change.nameCount)} names`
}

/** One line saying what a change did. */
export function describeLibraryChange(change: LibraryChange): string {
  const target = change.target ? quoted(change.target.title) : null
  const [source] = change.sources
  if (change.action === 'merge') {
    const merged =
      change.sources.length === 1 && source
        ? quoted(source.title)
        : `${formatCount(change.sources.length)} tracks`
    return `Merged ${merged}${target ? ` into ${target}` : ''}`
  }
  if (change.action === 'move')
    return `Moved ${movedNames(change)}${target ? ` to ${target}` : ''}`
  if (change.action === 'separate')
    return `Separated ${movedNames(change)}${source ? ` from ${quoted(source.title)}` : ''}`
  return `Returned ${movedNames(change)} to automatic matching`
}

/** Why Undo or Redo is not offered for a change, or null when it is. */
export function libraryChangeBlock(change: LibraryChange): string | null {
  if (!change.reversible)
    return 'This change also moved album positions or playlist entries and cannot be undone.'
  if (change.undoneAt ? change.canRedo : change.canUndo) return null
  return 'A later change moved these names. Undo that change first.'
}

/** One sentence of evidence against a merge. */
export function describeMergeCaution(caution: TrackMergeCaution): string {
  if (caution.code === 'version')
    return `${listed.format(caution.words.map(quoted))} ${caution.words.length === 1 ? 'is' : 'are'} in some titles only.`
  if (caution.code === 'duration')
    return `Lengths differ by ${formatTrackLength(caution.seconds * 1000)}.`
  return `The artists differ: ${caution.names.join(', ')}.`
}

/** Why a selected track stays a track of its own. */
export const mergeBlockLabels: Record<TrackMergeBlock, string> = {
  spotify: 'Has its own Spotify track',
  album: 'Is on an album track list',
  playlist: 'Is in a playlist',
}
