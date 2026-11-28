import type { AlbumListItem, FilmListItem } from '@repo/schemas/media'
import type { BrowseFilter } from '@repo/schemas/browse'
import type { LibraryPlaylistView } from '@repo/schemas/library-playlists'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'

export type FilterSuggestion = BrowseFilter & {
  label: string
  count: number
  /** Visible tags beneath a tag value; `count` covers them too. */
  subtags?: number
  /** Ranked in place of `value` when the value is an ID: a playlist's name. */
  name?: string
}
export type TitleSuggestion = { id: string; title: string; label: string }
/** A smart playlist: choosing it opens its saved view (PL-44). */
export type SmartPlaylistSuggestion = {
  id: string
  name: string
  label: string
  view: LibraryPlaylistView
  href: string
}
export type BrowseSuggestion =
  | { kind: 'item'; item: TitleSuggestion }
  | { kind: 'filter'; filter: FilterSuggestion }
  | { kind: 'smart'; playlist: SmartPlaylistSuggestion }

export function matchingTitleFilters(
  options: FilterSuggestion[],
  query: string,
  field = 'title',
) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return options
    .filter(
      (option) =>
        option.field === field &&
        words.every((word) => option.value.toLowerCase().includes(word)),
    )
    .sort(
      (a, b) =>
        Number(b.value.toLowerCase() === query.trim().toLowerCase()) -
          Number(a.value.toLowerCase() === query.trim().toLowerCase()) ||
        a.value.localeCompare(b.value),
    )
    .slice(0, 100)
    .map(({ value }) => ({ field, value }))
}

export function titleSuggestions(
  items: Pick<
    AlbumListItem | FilmListItem,
    'id' | 'title' | 'mediaType' | 'credits' | 'releaseDate'
  >[],
): TitleSuggestion[] {
  return items
    .map((item) => {
      const role = item.mediaType === 'album' ? 'artist' : 'director'
      const creators = item.credits
        .filter((credit) => credit.role === role)
        .map((credit) => credit.name)
        .join(', ')
      const context = [item.releaseDate?.slice(0, 4), creators]
        .filter(Boolean)
        .join(' · ')
      return {
        id: item.id,
        title: item.title,
        label: `${item.title}${context ? ` · ${context}` : ''}`,
      }
    })
    .map((item, _, all) => ({
      ...item,
      label: all.some(
        (other) => other.id !== item.id && other.label === item.label,
      )
        ? `${item.label} · ${item.id}`
        : item.label,
    }))
}

/** Match quality of a suggestion's text, best first. */
export const matchTiers = { exact: 3, prefix: 2, wordPrefix: 1, substring: 0 }

function startsWord(text: string, word: string) {
  for (
    let index = text.indexOf(word);
    index >= 0;
    index = text.indexOf(word, index + 1)
  ) {
    const before = text[index - 1]
    if (before === undefined || !/[\p{L}\p{N}]/u.test(before)) return true
  }
  return false
}

/**
 * Exact, then the text starts with the query, then every query word starts a
 * word of the text, then substring only. Query words absent from the text,
 * such as a filter's field name ("tags rock"), do not count.
 */
export function matchTier(text: string, query: string) {
  const value = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word && value.includes(word))
  if (!words.length) return matchTiers.substring
  const phrase = words.join(' ')
  if (value === phrase) return matchTiers.exact
  if (value.startsWith(phrase)) return matchTiers.prefix
  return words.every((word) => startsWord(value, word))
    ? matchTiers.wordPrefix
    : matchTiers.substring
}

/** Suggestions of one kind in a row before a good match of the other kind. */
const kindRunLimit = 3

type RankedSuggestion = { suggestion: BrowseSuggestion; tier: number }

/** Titles are one kind; filters and smart playlists, which change the view, the other. */
const rankKind = (suggestion: BrowseSuggestion) =>
  suggestion.kind === 'item' ? 'item' : 'filter'

/**
 * One list of filters, smart playlists and titles ranked by match tier.
 * Within a tier, smart playlists come first, then filters, broader ones
 * (higher count) before narrower ones, then titles. After three of one kind
 * in a row, the best of the other kind follows if it matches at word-prefix
 * level or better, so neither kind fills the first screen alone. Ties fall
 * back to label and key, so the order is stable.
 */
export function browseSuggestions(
  options: FilterSuggestion[],
  items: TitleSuggestion[],
  query: string,
  smartPlaylists: SmartPlaylistSuggestion[] = [],
): BrowseSuggestion[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const labelMatches = (label: string) =>
    words.every((word) => label.toLowerCase().includes(word))
  const titles: RankedSuggestion[] = items
    .map((item) => ({ item, tier: matchTier(item.title, query) }))
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        a.item.label.localeCompare(b.item.label) ||
        a.item.id.localeCompare(b.item.id),
    )
    .map(
      ({ item, tier }): RankedSuggestion => ({
        suggestion: { kind: 'item', item },
        tier,
      }),
    )
  const views = smartPlaylists
    .filter((playlist) => labelMatches(playlist.label))
    .map((playlist) => ({ playlist, tier: matchTier(playlist.name, query) }))
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        a.playlist.name.localeCompare(b.playlist.name) ||
        a.playlist.id.localeCompare(b.playlist.id),
    )
  const filters: RankedSuggestion[] = options
    .filter((option) => option.field !== 'title' && labelMatches(option.label))
    .map((filter) => ({
      filter,
      tier: matchTier(filter.name ?? filter.value, query),
    }))
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        b.filter.count - a.filter.count ||
        a.filter.label.localeCompare(b.filter.label) ||
        a.filter.field.localeCompare(b.filter.field) ||
        a.filter.value.localeCompare(b.filter.value),
    )
    .map(
      ({ filter, tier }): RankedSuggestion => ({
        suggestion: { kind: 'filter', filter },
        tier,
      }),
    )
  const changes: RankedSuggestion[] = [
    ...views.map(
      ({ playlist, tier }): RankedSuggestion => ({
        suggestion: { kind: 'smart', playlist },
        tier,
      }),
    ),
    ...filters,
  ].sort(
    (a, b) =>
      b.tier - a.tier ||
      Number(b.suggestion.kind === 'smart') -
        Number(a.suggestion.kind === 'smart'),
  )
  const ranked: BrowseSuggestion[] = []
  const next = { item: 0, filter: 0 }
  let run = 0
  let previous: 'item' | 'filter' | undefined
  while (ranked.length < 100) {
    const title = titles[next.item]
    const change = changes[next.filter]
    let pick: RankedSuggestion | undefined =
      title && (!change || title.tier > change.tier) ? title : change
    const other = pick === title ? change : title
    if (
      pick &&
      other &&
      rankKind(pick.suggestion) === previous &&
      run >= kindRunLimit &&
      other.tier >= matchTiers.wordPrefix
    )
      pick = other
    if (!pick) break
    const kind = rankKind(pick.suggestion)
    next[kind] += 1
    run = kind === previous ? run + 1 : 1
    previous = kind
    ranked.push(pick.suggestion)
  }
  return ranked
}

/** The muted text after a filter suggestion: `1,204 · 38 subtags`. */
export function filterSuggestionNote(
  filter: Pick<FilterSuggestion, 'count' | 'subtags'>,
) {
  return filter.subtags
    ? `${formatCount(filter.count)} · ${formatItemCount(filter.subtags, { one: 'subtag', other: 'subtags' })}`
    : formatCount(filter.count)
}

export function suggestionKey(option: BrowseSuggestion) {
  switch (option.kind) {
    case 'item':
      return `item:${option.item.id}`
    case 'filter':
      return `filter:${option.filter.field}:${option.filter.value}`
    case 'smart':
      return `smart:${option.playlist.id}`
  }
}
