/**
 * A Browse list shown inside a detail, held to that detail's own items.
 */
export type EmbeddedBrowse = {
  /**
   * The request parameters that hold the list to its owner, such as an
   * artist's `creatorId`. They are not part of the list's settings, so
   * nothing in the list can remove them.
   */
  scope: Readonly<Record<string, string>>
  /** Names the list in browser storage, apart from its Browse page. */
  storage: string
  /** The artwork shape that the remembered grid size belongs to. */
  mediaType: 'album' | 'film' | 'subscription'
  /** The order the list starts in, until another is chosen. */
  sort: { key: string; direction: 'asc' | 'desc' }
}

/** The scroll area for a Browse list inside a detail. */
export const embeddedScrollClass = 'dtl-browse-entries'

/**
 * Every setting a Browse list keeps in its URL. A detail removes them when
 * its tab changes, and they are what its Show in link carries across.
 */
export const browseStateKeys: readonly string[] = [
  'q',
  'fields',
  'filters',
  'ranges',
  'tagLevels',
  'listening',
  'listeningSort',
  'playlistIds',
  'includeArchived',
  'editions',
  'limitResults',
  'groupRecordings',
  'sortBy',
  'direction',
  'view',
  'density',
  'overlays',
  'columns',
  'columnOrder',
]

/** The Browse page with a list's scope and the settings it has now. */
export function embeddedBrowseHref(
  collection: string,
  scope: Readonly<Record<string, string>>,
  settings: URLSearchParams,
) {
  const params = new URLSearchParams(scope)
  for (const key of browseStateKeys) {
    const value = settings.get(key)
    if (value !== null && value !== '') params.set(key, value)
  }
  return `/${collection}?${params}`
}

/**
 * The settings a list inside a detail remembers for the next detail, beside
 * its view and grid size: how it is sorted and which columns it shows. Search
 * and filters belong to one visit.
 */
const embeddedLayoutKeys: readonly string[] = [
  'sortBy',
  'direction',
  'listeningSort',
  'overlays',
  'columns',
  'columnOrder',
]

export function embeddedLayoutKey(storage: string) {
  return `embedded-browse:${storage}`
}

/** The remembered part of a list's settings, as it is kept in storage. */
export function embeddedLayout(settings: URLSearchParams) {
  const layout = new URLSearchParams()
  for (const key of embeddedLayoutKeys) {
    const value = settings.get(key)
    if (value !== null && value !== '') layout.set(key, value)
  }
  return layout.toString()
}

/**
 * A list's settings with the remembered layout filled in where the URL names
 * none, then the list's starting order.
 */
export function withEmbeddedLayout(
  settings: URLSearchParams,
  saved: string,
  sort?: EmbeddedBrowse['sort'],
) {
  const params = new URLSearchParams(settings)
  const layout = new URLSearchParams(saved)
  // A sort and its direction are one choice: the URL's sort keeps its own.
  const sorted = params.has('sortBy')
  for (const key of embeddedLayoutKeys) {
    const value = layout.get(key)
    if (value === null || params.has(key)) continue
    if (sorted && (key === 'direction' || key === 'listeningSort')) continue
    params.set(key, value)
  }
  if (sort && !params.has('sortBy')) {
    params.set('sortBy', sort.key)
    if (!params.has('direction')) params.set('direction', sort.direction)
  }
  return params
}
