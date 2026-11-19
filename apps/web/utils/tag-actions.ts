import type {
  SetTagParentsInput,
  Tag,
  TagProvenancePage,
} from '@repo/schemas/tags'
import type { QueryClient } from '@tanstack/react-query'

export function tagSelectionMediaType(tags: Pick<Tag, 'mediaType'>[]) {
  const mediaType = tags[0]?.mediaType
  return mediaType && tags.every((tag) => tag.mediaType === mediaType)
    ? mediaType
    : null
}

export function relevantTagSources(items: TagProvenancePage['items']) {
  const seen = new Set<string>()
  return items.filter((source) => {
    if (!source.link || source.onMedia === false || seen.has(source.link.url))
      return false
    seen.add(source.link.url)
    return true
  })
}

export async function invalidateTags(client: QueryClient) {
  for (const key of [
    'tags',
    'tag-detail',
    'tag-provenance',
    'films',
    'albums',
    'tracks',
    'artists',
    'film',
    'album',
    'film-facets',
    'film-selection',
    'album-selection',
    'artist-selection',
  ])
    await client.invalidateQueries({ queryKey: [key] })
}

/**
 * Sends a tag selection in batches of 100, in order. The first failure stops
 * the run: later batches are not sent and the failure is returned.
 */
export async function dispatchTagBatches(
  ids: string[],
  send: (ids: string[]) => Promise<unknown>,
): Promise<{ completed: string[]; interrupted: boolean; error?: unknown }> {
  const unique = [...new Set(ids)]
  const completed: string[] = []
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100)
    try {
      await send(batch)
      completed.push(...batch)
    } catch (error) {
      return { completed, interrupted: true, error }
    }
  }
  return { completed, interrupted: false }
}

/** Sets the parents of tags: one request per 100 tags, same parents and mode. */
export function dispatchTagParents(
  input: SetTagParentsInput,
  send: (body: SetTagParentsInput) => Promise<unknown>,
) {
  return dispatchTagBatches(input.tagIds, (tagIds) =>
    send({ ...input, tagIds }),
  )
}
