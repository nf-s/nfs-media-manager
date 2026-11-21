import type { QueryClient } from '@tanstack/react-query'
import {
  LibraryChangePageSchema,
  LibraryChangePartSchema,
  LibraryChangeSchema,
  TrackMergePlanSchema,
  type LibraryChange,
  type LibraryChangeActor,
  type LibraryChangeKind,
  type LibraryChangePart,
  type TrackMergeCaution,
} from '@repo/schemas/library-changes'
import {
  formatCount,
  formatItemCount,
  formatTrackLength,
} from '@repo/ui/lib/format'
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

/**
 * Merges the tracks. `follow` also merges what follows them; the server does
 * when it is omitted.
 */
export function mergeTracks(
  apiBaseUrl: string,
  request: TrackMergeSelection & { reviewed: boolean; follow?: boolean },
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
  /** The library the changes belong to. The server lists tracks when omitted. */
  kind?: LibraryChangeKind
  actor?: LibraryChangeActor
  /** Only changes that moved something into or out of this record. */
  recordId?: string
  /** Only the changes of one automatic run. */
  batchId?: string
}

export const libraryChangesKey = (query: LibraryChangeQuery = {}) => [
  'library-changes',
  query,
]

export function loadLibraryChanges(
  apiBaseUrl: string,
  { page, size, kind, actor, recordId, batchId }: LibraryChangeQuery,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams()
  if (page !== undefined) params.set('page', String(page))
  if (size !== undefined) params.set('size', String(size))
  if (kind) params.set('kind', kind)
  if (actor) params.set('actor', actor)
  if (recordId) params.set('recordId', recordId)
  if (batchId) params.set('batchId', batchId)
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

type Noun = { one: string; other: string }

const recordNouns: Record<LibraryChangeKind, Noun> = {
  track: { one: 'track', other: 'tracks' },
  album: { one: 'album', other: 'albums' },
  artist: { one: 'artist', other: 'artists' },
}

/** What a row is shown as: a version of a track, an edition of an album. */
const shownNouns: Record<LibraryChangeKind, string> = {
  track: 'version',
  album: 'edition',
  artist: 'profile',
}

const partNouns: Record<LibraryChangePart, Noun> = {
  version: { one: 'version', other: 'versions' },
  edition: { one: 'edition', other: 'editions' },
  position: { one: 'album position', other: 'album positions' },
  'playlist-entry': { one: 'playlist entry', other: 'playlist entries' },
  'album-name': { one: 'album name', other: 'album names' },
  'artist-name': { one: 'artist name', other: 'artist names' },
  title: { one: 'track name', other: 'track names' },
  credit: { one: 'credit', other: 'credits' },
}

/** The parts a change moved besides track names: `2 versions and 1 album name`. */
function movedPartCounts(change: LibraryChange) {
  const counts = change.details?.counts ?? {}
  const parts = LibraryChangePartSchema.options.flatMap((part) => {
    const count = counts[part] ?? 0
    return count
      ? [{ count, text: formatItemCount(count, partNouns[part]) }]
      : []
  })
  return {
    total: parts.reduce((sum, part) => sum + part.count, 0),
    text: parts.length ? listed.format(parts.map((part) => part.text)) : null,
  }
}

function movedNames(change: LibraryChange) {
  const [first] = change.names
  return change.nameCount === 1 && first
    ? quoted(first.trackName)
    : `${formatCount(change.nameCount)} names`
}

/**
 * What a move or separation moved: its scrobbled names or, when it moved
 * none, its other parts: one part by name, several by count. `parts` says
 * how the line used the details.
 */
function movedParts(change: LibraryChange): {
  text: string
  parts: 'unused' | 'named' | 'counted'
} {
  const parts = movedPartCounts(change)
  if (change.nameCount || !parts.text)
    return { text: movedNames(change), parts: 'unused' }
  const [label] = change.details?.labels ?? []
  return parts.total === 1 && label
    ? { text: quoted(label), parts: 'named' }
    : { text: parts.text, parts: 'counted' }
}

/** One line saying what a change did. */
export function describeLibraryChange(change: LibraryChange): string {
  const noun = recordNouns[change.kind]
  const target = change.target ? quoted(change.target.title) : null
  const [source] = change.sources
  switch (change.action) {
    case 'merge': {
      const merged =
        change.sources.length === 1 && source
          ? quoted(source.title)
          : formatItemCount(change.sources.length, noun)
      return `Merged ${merged}${target ? ` into ${target}` : ''}`
    }
    case 'move':
      return `Moved ${movedParts(change).text}${target ? ` to ${target}` : ''}`
    case 'separate':
      return `Separated ${movedParts(change).text}${source ? ` from ${quoted(source.title)}` : ''}`
    case 'keep-separate': {
      const titles = change.sources.map((record) => quoted(record.title))
      return `Kept ${formatItemCount(change.sources.length, noun)} separate${titles.length ? `: ${titles.join(', ')}` : ''}`
    }
    case 'show':
      return target
        ? `Shown as ${target}`
        : `Changed the ${shownNouns[change.kind]} shown`
    case 'rematch':
      return `Returned ${movedNames(change)} to automatic matching`
    case 'remove':
      return `Removed ${
        change.sources.length === 1 && source
          ? quoted(source.title)
          : formatItemCount(change.sources.length, noun)
      }`
  }
}

/** The automatic rules, by the code a change stores. */
export const libraryChangeRuleLabels: ReadonlyMap<string, string> = new Map([
  ['lastfm-exact-name', 'Same title and artist'],
  ['lastfm-album-alias', 'Same title on the album'],
  ['lastfm-accepted-search', 'Accepted search result'],
  ['lastfm-unmatched', 'No longer matched'],
  ['spotify-search', 'Spotify track search'],
  ['album-alias', 'Album track list'],
  ['album-history', 'Album listening history'],
  ['spotify-album-recording', 'Same Spotify track on the album'],
  ['album-track-list', 'No longer on the album’s track list'],
])

/** The automatic rule that made a change, or its code when it has no label. */
export function libraryChangeRule(rule: string): string {
  return libraryChangeRuleLabels.get(rule) ?? rule
}

const alsoVerbs: Partial<Record<LibraryChange['action'], string>> = {
  merge: 'Also merged',
  move: 'Also moved',
  separate: 'Also separated',
}

/** What a change moved besides what its line names, from its details. */
function alsoMoved(change: LibraryChange) {
  const verb = alsoVerbs[change.action]
  if (!verb) return null
  const labels = (change.details?.labels ?? []).map(quoted).join(', ')
  const used = change.action === 'merge' ? 'unused' : movedParts(change).parts
  if (used === 'named') return null
  if (used === 'counted') return labels || null
  const { text } = movedPartCounts(change)
  if (!text) return labels ? `${verb} ${labels}` : null
  return `${verb} ${text}${labels ? `: ${labels}` : ''}`
}

/**
 * The line under a change: the scrobbled names it moved, the rule that made
 * it, what else it moved, that an undone automatic change is not made again,
 * and why Undo or Redo is not offered.
 */
export function describeLibraryChangeNote(change: LibraryChange): string {
  const [first] = change.names
  const names = first
    ? `${first.artistName} · ${first.trackName}${
        change.nameCount > 1
          ? ` and ${formatCount(change.nameCount - 1)} more`
          : ''
      }`
    : null
  const remembered =
    change.actor === 'automatic' &&
    change.undoneAt !== null &&
    (change.action === 'merge' || change.action === 'move')
      ? 'Will not be merged automatically again'
      : null
  return [
    names,
    change.rule ? libraryChangeRule(change.rule) : null,
    alsoMoved(change),
    remembered,
    libraryChangeBlock(change)?.replace(/\.$/, ''),
  ]
    .filter(Boolean)
    .join('. ')
}

/** Why Undo or Redo is not offered for a change, or null when it is. */
export function libraryChangeBlock(change: LibraryChange): string | null {
  if (change.reversible && (change.undoneAt ? change.canRedo : change.canUndo))
    return null
  if (change.blocked) return change.blocked
  if (!change.reversible)
    return 'This change also moved album positions or playlist entries and cannot be undone.'
  return 'A later change moved these names. Undo that change first.'
}

/**
 * Refreshes what an undone or redone album or artist change affects. Records
 * the change removed are not fetched again. Track changes refresh through
 * `invalidateScrobbleLinks`.
 */
export async function invalidateLibraryRecords(
  client: QueryClient,
  kind: Exclude<LibraryChangeKind, 'track'>,
  removedIds: readonly string[],
) {
  for (const id of removedIds) {
    const queryKey = [kind, id]
    await client.cancelQueries({ queryKey, exact: true })
    await client.invalidateQueries({
      queryKey,
      exact: true,
      refetchType: 'none',
    })
  }
  const removed = (key: readonly unknown[]) =>
    key.length === 2 &&
    key[0] === kind &&
    removedIds.some((id) => id === key[1])
  return client.invalidateQueries({
    predicate: (query) =>
      !removed(query.queryKey) &&
      [
        'library-changes',
        'albums',
        'album',
        'album-listening',
        'album-playlists',
        'artists',
        'artist',
        'artist-overview',
        'tracks',
        'track',
        'lastfm-links',
        'playlists',
        'playlist',
      ].includes(String(query.queryKey[0])),
  })
}

const nameNoun: Noun = { one: 'name', other: 'names' }

/** Up to five quoted names of `count`, with how many more there are. */
function someNames(count: number, names: readonly string[]) {
  const more = count - names.length
  return listed.format([
    ...names,
    ...(more > 0 ? [`${formatCount(more)} more`] : []),
  ])
}

/**
 * One sentence of evidence against a merge. `tracks` are the plan's tracks,
 * to name the ones the owner kept separate.
 */
export function describeMergeCaution(
  caution: TrackMergeCaution,
  tracks: readonly { id: string; title: string }[] = [],
): string {
  switch (caution.code) {
    case 'version':
      return `${listed.format(caution.words.map(quoted))} ${caution.words.length === 1 ? 'is' : 'are'} in some titles only.`
    case 'duration':
      return `Lengths differ by ${formatTrackLength(caution.seconds * 1000)}.`
    case 'artists':
      return `The artists differ: ${caution.names.join(', ')}.`
    case 'same-album':
      return `Two tracks are different positions on ${listed.format(caution.albums.map(quoted))}.`
    case 'separate': {
      const titles = caution.trackIds.flatMap((id) => {
        const track = tracks.find((item) => item.id === id)
        return track ? [quoted(track.title)] : []
      })
      return titles.length === caution.trackIds.length
        ? `${listed.format(titles)} were kept separate.`
        : 'Some of these tracks were kept separate.'
    }
    case 'elsewhere':
      return `${formatItemCount(caution.count, nameNoun)} that would follow ${caution.count === 1 ? 'is' : 'are'} on another album: ${someNames(
        caution.count,
        caution.names.map(
          (name) => `${quoted(name.trackName)} on ${quoted(name.albumTitle)}`,
        ),
      )}.`
    case 'ambiguous':
      return `${formatItemCount(caution.count, nameNoun)} ${caution.count === 1 ? 'matches' : 'match'} more than one track of the album and ${caution.count === 1 ? 'stays' : 'stay'} where ${caution.count === 1 ? 'it is' : 'they are'}: ${someNames(
        caution.count,
        caution.names.map((name) => quoted(name.trackName)),
      )}.`
  }
}
