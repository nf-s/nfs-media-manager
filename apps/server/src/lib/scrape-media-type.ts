import { MediaTypeSchema } from '@repo/schemas/common'

/**
 * The scraped library a stored media type belongs to. Albums and films are
 * scraped and tagged; a library track is neither, and gives null.
 */
export function scrapeMediaType(value: string) {
  const parsed = MediaTypeSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
