import type { z } from 'zod'
import { EnrichmentResultSchema } from '@repo/schemas/job'

type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>

export async function dispatchFilmSelection(
  selected: string[],
  send: (ids: string[]) => Promise<EnrichmentResult>,
  onProgress: (count: number) => void,
) {
  const ids = [...new Set(selected)]
  const completed: string[] = []
  let queued = 0
  let skipped = 0
  const warnings = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100)
    try {
      const result = await send(chunk)
      completed.push(...chunk)
      queued += result.queued
      skipped += result.skipped
      result.warnings.forEach((warning) => warnings.add(warning))
      onProgress(completed.length)
    } catch {
      // The failed request may have queued some work. Never automatically retry it.
      warnings.add(
        'Stopped: this batch could not be confirmed. Check job progress before retrying the remaining selection.',
      )
      return {
        queued,
        skipped,
        completed,
        warnings: [...warnings],
        interrupted: true,
      }
    }
  }
  return {
    queued,
    skipped,
    completed,
    warnings: [...warnings],
    interrupted: false,
  }
}
