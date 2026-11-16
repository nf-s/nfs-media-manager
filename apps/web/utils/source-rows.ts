import type { StatusState } from '@repo/ui/components/ds/status'
import type { Job } from '@repo/schemas/job'

export type SourceMatch = { state: StatusState; label: string }

/** The reason a provider cannot refresh when an identifier is missing. */
export const IDENTIFIER_REQUIRED = 'Identifier required'

/**
 * Two letters standing in for a provider's glyph: the first two capitals
 * (MusicBrainz → MB), the initials of a multi-word name (Last.fm → LF), or
 * the first two letters.
 */
export function providerMarkText(label: string) {
  const capitals = label.match(/[A-Z]/g) ?? []
  if (capitals.length >= 2) return capitals.slice(0, 2).join('')
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const initials =
    words.length >= 2 ? words.map((word) => word.charAt(0)).join('') : ''
  return (initials || label.replace(/[^A-Za-z0-9]/g, ''))
    .slice(0, 2)
    .toUpperCase()
}

/** How an item is matched to a provider, from what is stored. */
export function sourceMatch(row: {
  identifier?: string
  updatedAt?: string
  unavailable?: string
  refreshable: boolean
}): SourceMatch {
  if (row.identifier) return { state: 'done', label: 'Matched by ID' }
  if (row.updatedAt) return { state: 'done', label: 'Matched by name' }
  if (row.unavailable === IDENTIFIER_REQUIRED)
    return { state: 'attention', label: 'Needs ID' }
  return { state: 'never', label: row.refreshable ? 'Not fetched' : 'Never' }
}

/** The queue state shown for a provider that cannot refresh now. */
export function unavailableState(reason: string): StatusState | null {
  if (reason === IDENTIFIER_REQUIRED) return null
  if (/cooling down/i.test(reason)) return 'waiting'
  if (/halted/i.test(reason)) return 'paused'
  if (/^checking/i.test(reason)) return null
  return 'attention'
}

export function jobState(job: Pick<Job, 'status' | 'waiting'>): StatusState {
  if (job.status === 'succeeded') return 'done'
  if (job.status === 'queued' && job.waiting) return 'waiting'
  return job.status
}

/** `5 sources · 4 matched · 1 needs an ID` */
export function sourcesSummary(matches: readonly SourceMatch[]) {
  const matched = matches.filter((match) => match.state === 'done').length
  const needs = matches.filter((match) => match.label === 'Needs ID').length
  return [
    `${matches.length} ${matches.length === 1 ? 'source' : 'sources'}`,
    ...(matched ? [`${matched} matched`] : []),
    ...(needs ? [`${needs} ${needs === 1 ? 'needs' : 'need'} an ID`] : []),
  ].join(' · ')
}

type Dated = { at: string }

/**
 * Merge two newest-first lists that are each loaded a page at a time. Items
 * older than the oldest loaded item of a list with more pages are held back,
 * since the next page of that list may hold newer ones.
 */
export function mergeHistory<T extends Dated>(
  lists: readonly { items: readonly T[]; more: boolean }[],
): T[] {
  const cutoff = Math.max(
    -Infinity,
    ...lists
      .filter((list) => list.more && list.items.length)
      .map((list) => Date.parse(list.items[list.items.length - 1]?.at ?? '')),
  )
  return lists
    .flatMap((list) => list.items)
    .filter((item) => Date.parse(item.at) >= cutoff)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
}
