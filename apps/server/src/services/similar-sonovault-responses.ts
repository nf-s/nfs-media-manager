import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { providerResponse } from '@/schemas/db'
import type { z } from 'zod'

// Similar uses Sonovault's transient cache window regardless of plan.
const CACHE_MS = 30 * 24 * 60 * 60 * 1000

export async function readSimilarSonovaultResponses(
  database: Pick<typeof db, 'select'>,
  ids: readonly string[],
) {
  if (!ids.length) return []
  return database
    .select({
      id: providerResponse.id,
      jobId: providerResponse.jobId,
      requestUrl: providerResponse.requestUrl,
      status: providerResponse.status,
      text: sql<string | null>`${providerResponse.body}->>'text'`,
    })
    .from(providerResponse)
    .where(
      and(
        inArray(providerResponse.id, [...new Set(ids)]),
        eq(providerResponse.provider, 'sonovault'),
        inArray(providerResponse.status, [200, 404]),
        eq(providerResponse.bodyState, 'captured'),
        gte(providerResponse.receivedAt, new Date(Date.now() - CACHE_MS)),
      ),
    )
}

export function parseSimilarSonovaultResponse<S extends z.ZodType>(
  schema: S,
  text: string | null,
): z.output<S> | null {
  if (!text) return null
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  const result = schema.safeParse(body)
  return result.success ? result.data : null
}
