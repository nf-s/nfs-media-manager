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
  query: string,
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
    .sort(
      (a, b) =>
        Number(b.title.toLowerCase() === query.trim().toLowerCase()) -
          Number(a.title.toLowerCase() === query.trim().toLowerCase()) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    )
}

export function browseSuggestions(
  options: FilterSuggestion[],
  items: TitleSuggestion[],
  query: string,
): BrowseSuggestion[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const titles: BrowseSuggestion[] = items.map((item) => ({
    kind: 'item',
    item,
  }))
  const filters: BrowseSuggestion[] = options
    .filter(
      (option) =>
        option.field !== 'title' &&
        words.every((word) => option.label.toLowerCase().includes(word)),
    )
    .map((filter) => ({ kind: 'filter', filter }))
  return [...titles, ...filters].slice(0, 100)
}

export function enterSuggestion(
  suggestions: BrowseSuggestion[],
  active: number,
): BrowseSuggestion | undefined {
  return active >= 0
    ? suggestions[active]
    : suggestions.find((option) => option.kind === 'item')
}

export function suggestionKey(option: BrowseSuggestion) {
  return option.kind === 'item'
    ? `item:${option.item.id}`
    : `filter:${option.filter.field}:${option.filter.value}`
}
