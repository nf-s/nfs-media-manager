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
    'user',
  ]),
  id: z.string().min(1).max(500),
})
export type DetailTarget = z.infer<typeof DetailTargetSchema>

const DetailEntrySchema = DetailTargetSchema.extend({
  view: z.string().max(4000).optional(),
}).refine(({ kind, id }) => kind !== 'user' || id === userDetailId)
export type DetailEntry = z.infer<typeof DetailEntrySchema>

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
  const playlist =
    pathname === '/playlists' || pathname === '/tracks'
      ? params.get('playlist')
      : null
  const collection =
    pathname === '/collections' ? params.get('collection') : null
  const parsed = DetailTargetSchema.safeParse(
    playlist
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
    user: [],
  }[parsed.data.kind]
  const view = new URLSearchParams()
  for (const key of keys) {
    const value = params.get(key)
    if (
      value !== null &&
      key !== 'item' &&
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

export function detailPageHref(target: DetailTarget, view?: URLSearchParams) {
  if (target.kind === 'user')
    return detailLocation('/user', new URLSearchParams(view))
  const id = encodeURIComponent(target.id)
  const collection = target.kind === 'person' ? 'people' : `${target.kind}s`
  return detailLocation(`/${collection}/${id}`, new URLSearchParams(view))
}
