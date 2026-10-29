import type { Tag, TagProvenancePage } from '@repo/schemas/tags'
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
    'film',
    'album',
    'film-facets',
    'film-selection',
  ])
    await client.invalidateQueries({ queryKey: [key] })
}

export async function dispatchTagVisibility(
  ids: string[],
  send: (ids: string[]) => Promise<unknown>,
) {
  const unique = [...new Set(ids)]
  const completed: string[] = []
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100)
    try {
      await send(batch)
      completed.push(...batch)
    } catch {
      return { completed, interrupted: true }
    }
  }
  return { completed, interrupted: false }
}
