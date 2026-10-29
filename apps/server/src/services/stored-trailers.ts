import { and, inArray, sql } from 'drizzle-orm'
import type { FilmListItem } from '@repo/schemas/media'
import { youtubeTrailerUrl } from '@repo/schemas/trailer'
import { db } from '@/lib/db'
import { storedTrailerUrl } from '@/lib/stored-trailers'
import { providerCurrentState } from '@/schemas/db'

export async function withStoredTrailerLinks<
  T extends { id: string; links: FilmListItem['links'] },
>(items: T[]): Promise<T[]> {
  const missing = items.filter(
    (item) =>
      !item.links.some(
        (link) =>
          link.provider === 'youtube-trailer' && youtubeTrailerUrl(link.url),
      ),
  )
  if (!missing.length) return items
  // One bounded detail read; no payloads, imports or jobs are rewritten.
  const states = await db
    .select({
      mediaItemId: providerCurrentState.mediaItemId,
      provider: providerCurrentState.provider,
      payload: sql<unknown>`jsonb_build_object(
      'trailer', coalesce(
        nullif(${providerCurrentState.payload}->'trailer', 'null'::jsonb),
        nullif(${providerCurrentState.payload}->'data'->'movie'->'trailer', 'null'::jsonb),
        nullif(${providerCurrentState.payload}->'movie'->'trailer', 'null'::jsonb)
      ),
      'videos', ${providerCurrentState.payload}->'videos'
    )`,
    })
    .from(providerCurrentState)
    .where(
      and(
        inArray(
          providerCurrentState.mediaItemId,
          missing.map((item) => item.id),
        ),
        inArray(providerCurrentState.provider, ['nfo', 'mdblist', 'tmdb']),
      ),
    )
  const trailers = new Map<string, string>()
  // Prefer a stored explicit trailer before optional TMDb video results.
  for (const provider of ['nfo', 'mdblist', 'tmdb']) {
    for (const state of states) {
      if (state.provider !== provider || trailers.has(state.mediaItemId))
        continue
      const url = storedTrailerUrl(state.payload)
      if (url) trailers.set(state.mediaItemId, url)
    }
  }
  return items.map((item) => {
    const url = trailers.get(item.id)
    return url
      ? {
          ...item,
          links: [
            ...item.links.filter((link) => link.provider !== 'youtube-trailer'),
            {
              provider: 'youtube-trailer',
              label: 'YouTube trailer',
              url,
            },
          ],
        }
      : item
  })
}
