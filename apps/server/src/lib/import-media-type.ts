import { ImportRunSchema, type ImportRun } from '@repo/schemas/imports'
import { sql, type SQLWrapper } from 'drizzle-orm'

export function importMediaTypeExpression(result: SQLWrapper) {
  return sql`case when ${result} ? 'mediaType' then ${result}->>'mediaType'
    when (${result}->>'albums')::numeric > 0 and (${result}->>'films')::numeric = 0 then 'album'
    when (${result}->>'films')::numeric > 0 and (${result}->>'albums')::numeric = 0 then 'film'
    else null end`
}

export function importMediaType(result: unknown): ImportRun['mediaType'] {
  const parsed = ImportRunSchema.shape.result.safeParse(result)
  if (!parsed.success || !parsed.data) return null
  const data = parsed.data
  if (data.mediaType !== undefined) return data.mediaType
  if (data.albums > 0 && data.films === 0) return 'album'
  if (data.films > 0 && data.albums === 0) return 'film'
  return null
}
