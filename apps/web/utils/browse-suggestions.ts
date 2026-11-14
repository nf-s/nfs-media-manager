import type { AlbumListItem, FilmListItem } from '@repo/schemas/media'
import type { BrowseFilter } from '@repo/schemas/browse'

export type FilterSuggestion = BrowseFilter & { label: string; count: number }
export type TitleSuggestion = { id: string; title: string; label: string }
export type BrowseSuggestion =
  | { kind: 'item'; item: TitleSuggestion }
  | { kind: 'filter'; filter: FilterSuggestion }

export function matchingTitleFilters(
  options: FilterSuggestion[],
  query: string,
) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return options
    .filter(
      (option) =>
        option.field === 'title' &&
        words.every((word) => option.value.toLowerCase().includes(word)),
    )
    .sort(
      (a, b) =>
        Number(b.value.toLowerCase() === query.trim().toLowerCase()) -
          Number(a.value.toLowerCase() === query.trim().toLowerCase()) ||
        a.value.localeCompare(b.value),
    )
    .slice(0, 100)
    .map(({ value }) => ({ field: 'title', value }))
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

/**
 * One list of filters and titles ranked by match tier. Within a tier, filters
 * come before titles and broader filters (higher count) before narrower ones.
 * After three of one kind in a row, the best of the other kind follows if it
 * matches at word-prefix level or better, so neither kind fills the first
 * screen alone. Ties fall back to label and key, so the order is stable.
 */
export function browseSuggestions(
  options: FilterSuggestion[],
  items: TitleSuggestion[],
  query: string,
): BrowseSuggestion[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
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
  const filters: RankedSuggestion[] = options
    .filter(
      (option) =>
        option.field !== 'title' &&
        words.every((word) => option.label.toLowerCase().includes(word)),
    )
    .map((filter) => ({ filter, tier: matchTier(filter.value, query) }))
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
  const ranked: BrowseSuggestion[] = []
  const next = { item: 0, filter: 0 }
  let run = 0
  let previous: BrowseSuggestion['kind'] | undefined
  while (ranked.length < 100) {
    const title = titles[next.item]
    const filter = filters[next.filter]
    let pick: RankedSuggestion | undefined =
      title && (!filter || title.tier > filter.tier) ? title : filter
    const other = pick === title ? filter : title
    if (
      pick &&
      other &&
      pick.suggestion.kind === previous &&
      run >= kindRunLimit &&
      other.tier >= matchTiers.wordPrefix
    )
      pick = other
    if (!pick) break
    const kind = pick.suggestion.kind
    next[kind] += 1
    run = kind === previous ? run + 1 : 1
    previous = kind
    ranked.push(pick.suggestion)
  }
  return ranked
}

export function suggestionKey(option: BrowseSuggestion) {
  return option.kind === 'item'
    ? `item:${option.item.id}`
    : `filter:${option.filter.field}:${option.filter.value}`
}
