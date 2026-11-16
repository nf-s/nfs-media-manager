import { z } from 'zod'

const inspectorParam = 'inspect'
export const userDetailId = 'account'
const browseDetailKinds = {
  '/albums': 'album',
  '/films': 'film',
  '/tracks': 'track',
  '/subscriptions': 'subscription',
}

const DetailTargetSchema = z.object({
  kind: z.enum([
    'album',
    'film',
    'track',
    'playlist',
    'subscription',
    'collection',
    'artist',
    'person',
    'channel',
    'job',
    'user',
    'tag',
  ]),
  id: z.string().min(1).max(500),
})
export type DetailTarget = z.infer<typeof DetailTargetSchema>

const DetailEntrySchema = DetailTargetSchema.extend({
  view: z.string().max(4000).optional(),
})
  .refine(({ kind, id }) => kind !== 'user' || id === userDetailId)
  .refine(({ kind, id }) => kind !== 'tag' || parseTagDetailId(id) !== null)
export type DetailEntry = z.infer<typeof DetailEntrySchema>

/** A tag's drawer entry carries its library, because tag IDs are per library. */
export function tagDetailId(mediaType: 'album' | 'film', id: string) {
  return `${mediaType}:${id}`
}

export function parseTagDetailId(
  value: string,
): { mediaType: 'album' | 'film'; id: string } | null {
  const match = /^(album|film):(.+)$/s.exec(value)
  const mediaType = match?.[1]
  const id = match?.[2]
  if (!id || (mediaType !== 'album' && mediaType !== 'film')) return null
  return { mediaType, id }
}

/**
 * The open tab of a detail: one of `tabs`, an older tab value mapped by
 * `aliases`, or else the first tab.
 */
export function detailTab<Tab extends string>(
  value: string | null,
  tabs: readonly [Tab, ...Tab[]],
  aliases: Readonly<Record<string, Tab>> = {},
): Tab {
  const direct = tabs.find((tab) => tab === value)
  if (direct) return direct
  return (value === null ? undefined : aliases[value]) ?? tabs[0]
}

export function sameDetail(
  a: DetailTarget | undefined,
  b: DetailTarget | undefined,
) {
  return a?.kind === b?.kind && a?.id === b?.id
}

export function detailBrowseKind(pathname: string) {
  return Object.entries(browseDetailKinds).find(
    ([path]) => path === pathname,
  )?.[1]
}

export function detailLocation(
  pathname: string,
  params: URLSearchParams,
  hash = '',
) {
  return `${pathname}${params.size ? `?${params}` : ''}${hash}`
}

function legacyDetail(pathname: string, params: URLSearchParams) {
  const job = pathname === '/jobs' ? params.get('jobId') : null
  const playlist =
    pathname === '/playlists' || pathname === '/tracks'
      ? params.get('playlist')
      : null
  const collection =
    pathname === '/collections' ? params.get('collection') : null
  const parsed = DetailTargetSchema.safeParse(
    job
      ? { kind: 'job', id: job }
      : playlist
        ? { kind: 'playlist', id: playlist }
        : collection
          ? { kind: 'collection', id: collection }
          : { kind: detailBrowseKind(pathname), id: params.get('item') },
  )
  if (!parsed.success) return null
  const keys = {
    album: ['item', 'tab', 'albumTrackView'],
    film: ['item', 'tab'],
    track: ['item'],
    subscription: ['item'],
    playlist: ['item', 'playlist', 'tab', 'playlistView'],
    collection: ['collection', 'tab'],
    artist: [],
    person: [],
    channel: [],
    job: ['jobId', 'tab'],
    user: [],
    tag: [],
  }[parsed.data.kind]
  const view = new URLSearchParams()
  for (const key of keys) {
    const value = params.get(key)
    if (
      value !== null &&
      key !== 'item' &&
      key !== 'jobId' &&
      key !== 'playlist' &&
      key !== 'collection'
    )
      view.set(key, value)
  }
  return {
    entry: { ...parsed.data, ...(view.size ? { view: view.toString() } : {}) },
    keys,
  }
}

export function detailEntries(
  pathname: string,
  params: URLSearchParams,
): DetailEntry[] {
  const encoded = params.get(inspectorParam)
  if (encoded) {
    try {
      const parsed = z.array(DetailEntrySchema).safeParse(JSON.parse(encoded))
      if (parsed.success && parsed.data.length) return parsed.data
    } catch {
      // A malformed inspector URL leaves the original workspace available.
    }
  }
  const legacy = legacyDetail(pathname, params)
  return legacy ? [legacy.entry] : []
}

export function withoutDetailEntries(
  pathname: string,
  params: URLSearchParams,
) {
  const next = new URLSearchParams(params)
  next.delete(inspectorParam)
  const legacy = legacyDetail(pathname, params)
  if (legacy) for (const key of legacy.keys) next.delete(key)
  return next
}

export function detailEntryParams(
  pathname: string,
  params: URLSearchParams,
  entries: DetailEntry[],
) {
  const next = withoutDetailEntries(pathname, params)
  if (entries.length) next.set(inspectorParam, JSON.stringify(entries))
  return next
}

export const detailKindNames: Record<DetailTarget['kind'], string> = {
  album: 'Album',
  film: 'Film',
  track: 'Track',
  playlist: 'Playlist',
  subscription: 'Subscription',
  collection: 'Collection',
  artist: 'Artist',
  person: 'Person',
  channel: 'Channel',
  job: 'Job',
  user: 'Account',
  tag: 'Tag',
}

type LibraryPage = { path: string; label: string }

/** Longer paths first, so a section wins over the page that contains it. */
const libraries = {
  channels: { path: '/subscriptions/channels', label: 'Channels' },
  subscriptions: { path: '/subscriptions', label: 'Subscriptions' },
  albums: { path: '/albums', label: 'Albums' },
  films: { path: '/films', label: 'Films' },
  tracks: { path: '/tracks', label: 'Tracks' },
  artists: { path: '/artists', label: 'Artists' },
  people: { path: '/people', label: 'People' },
  playlists: { path: '/playlists', label: 'Playlists' },
  collections: { path: '/collections', label: 'Collections' },
  tags: { path: '/tags', label: 'Tags' },
  imports: { path: '/imports', label: 'Imports' },
  jobs: { path: '/jobs', label: 'Jobs' },
  providers: { path: '/providers', label: 'Providers' },
  account: { path: '/user', label: 'Account' },
} satisfies Record<string, LibraryPage>

const pathLibraries: readonly LibraryPage[] = Object.values(libraries)

/** The library page each kind belongs to. */
const kindLibraries: Record<DetailTarget['kind'], LibraryPage> = {
  album: libraries.albums,
  film: libraries.films,
  track: libraries.tracks,
  playlist: libraries.playlists,
  subscription: libraries.subscriptions,
  collection: libraries.collections,
  artist: libraries.artists,
  person: libraries.people,
  channel: libraries.channels,
  job: libraries.jobs,
  user: libraries.account,
  tag: libraries.tags,
}

/** What a drawer item's details say about it once loaded. */
export type DetailCrumb = {
  title: string
  /** The Jobs list of the batch a job belongs to. */
  batchHref?: string
}

export type DetailCrumbStep =
  | { label: string; to: 'library' }
  | { label: string; to: 'entry'; index: number }
  | { label: string; to: 'href'; href: string }
  | { label: string; to: 'current' }

export function detailCrumbKey(target: DetailTarget) {
  return `${target.kind}:${target.id}`
}

/**
 * The drawer's breadcrumbs: the library the path started from, then each
 * item on the path by title (its kind until its details have loaded), with a
 * job's batch before the job. The library crumb closes the drawer when that
 * library is the page underneath, and otherwise links to it: from an item's
 * page to its library, or from a page outside the libraries to the root
 * item's library.
 */
export function detailCrumbTrail(
  pathname: string,
  entries: readonly DetailTarget[],
  crumbs: ReadonlyMap<string, DetailCrumb>,
): DetailCrumbStep[] {
  const root = entries[0]
  if (!root) return []
  const library =
    pathLibraries.find(
      ({ path }) => pathname === path || pathname.startsWith(`${path}/`),
    ) ?? kindLibraries[root.kind]
  const trail: DetailCrumbStep[] = [
    pathname === library.path
      ? { label: library.label, to: 'library' }
      : { label: library.label, to: 'href', href: library.path },
  ]
  entries.forEach((entry, index) => {
    const crumb = crumbs.get(detailCrumbKey(entry))
    if (entry.kind === 'job' && crumb?.batchHref)
      trail.push({ label: 'Batch', to: 'href', href: crumb.batchHref })
    const label = crumb?.title || detailKindNames[entry.kind]
    trail.push(
      index === entries.length - 1
        ? { label, to: 'current' }
        : { label, to: 'entry', index },
    )
  })
  return trail
}

export function detailPageHref(target: DetailTarget, view?: URLSearchParams) {
  if (target.kind === 'user')
    return detailLocation('/user', new URLSearchParams(view))
  if (target.kind === 'tag') {
    const tag = parseTagDetailId(target.id)
    const params = new URLSearchParams(view)
    if (tag) {
      params.set('mediaType', tag.mediaType)
      params.set('tag', tag.id)
    }
    return detailLocation('/tags', params)
  }
  const id = encodeURIComponent(target.id)
  const collection = target.kind === 'person' ? 'people' : `${target.kind}s`
  return detailLocation(`/${collection}/${id}`, new URLSearchParams(view))
}
