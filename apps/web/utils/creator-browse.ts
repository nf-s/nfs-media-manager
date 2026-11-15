import type { BrowseFilter } from '@repo/schemas/browse'
import {
  CreatorIdSchema,
  PersonRoleSchema,
  type PersonRole,
} from '@repo/schemas/common'
import { serializeAlbumBrowseFilters } from '@repo/schemas/media'
import { tracksHref } from './track-browse'

export const personRoleLabels: Record<PersonRole, string> = {
  director: 'Director',
  actor: 'Actor',
}

export type CreatorBrowseScope = { creatorId: string; creatorRole?: PersonRole }

export const clearCreatorScope = { creatorId: null, creatorRole: null }

export function parseCreatorBrowseScope(
  params: Pick<URLSearchParams, 'get'>,
  mediaType: 'album' | 'track' | 'film',
): CreatorBrowseScope | undefined {
  const id = CreatorIdSchema.safeParse(params.get('creatorId'))
  if (!id.success) return undefined
  const role = PersonRoleSchema.safeParse(params.get('creatorRole'))
  return {
    creatorId: id.data,
    ...(mediaType === 'film' && role.success ? { creatorRole: role.data } : {}),
  }
}

export function artistBrowseHref(library: 'albums' | 'tracks', id: string) {
  return `/${library}?${new URLSearchParams({ creatorId: id })}`
}

export function artistTagBrowseHref(
  library: 'albums' | 'tracks',
  value: string,
) {
  const filter: BrowseFilter = { field: 'artistTag', value, mode: 'required' }
  if (library === 'tracks') return tracksHref([filter])
  return `/albums?${new URLSearchParams({ filters: serializeAlbumBrowseFilters([filter]) ?? '' })}`
}

export function personFilmsHref(id: string, role: PersonRole) {
  return `/films?${new URLSearchParams({ creatorId: id, creatorRole: role })}`
}
