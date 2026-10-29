import { z } from 'zod'
import { youtubeTrailerUrl } from '@repo/schemas/trailer'

const StoredTrailerSchema = z.object({
  trailer: z.unknown().optional(),
  videos: z.unknown().optional(),
})
const VideoSchema = z.object({
  site: z.literal('YouTube'),
  type: z.literal('Trailer'),
  key: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  official: z.boolean().optional(),
})

/** Only receives projected public-provider trailer fields, not private payloads. */
export function storedTrailerUrl(value: unknown): string | undefined {
  const parsed = StoredTrailerSchema.safeParse(value)
  if (!parsed.success) return undefined
  const trailers = Array.isArray(parsed.data.trailer)
    ? parsed.data.trailer
    : [parsed.data.trailer]
  for (const trailer of trailers) {
    const url = youtubeTrailerUrl(trailer)
    if (url) return url
  }
  const videos = z
    .object({ results: z.array(z.unknown()) })
    .safeParse(parsed.data.videos)
  if (!videos.success) return undefined
  const candidates = videos.data.results.flatMap((video) => {
    const result = VideoSchema.safeParse(video)
    return result.success ? [result.data] : []
  })
  const video =
    candidates.find((candidate) => candidate.official) ?? candidates[0]
  return video
    ? youtubeTrailerUrl(`https://www.youtube.com/watch?v=${video.key}`)
    : undefined
}
