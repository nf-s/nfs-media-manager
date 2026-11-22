import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  SonovaultBulkResolveResponseSchema,
  SonovaultReleaseSchema,
  SonovaultStoredRecordSchema,
  type SonovaultStoredRecord,
} from '@/lib/sonovault-api'
import { providerResponse, sonovaultTrackLookup } from '@/schemas/db'
import { sameSonovaultInput } from './sonovault-track-lookup'

type Database = Pick<typeof db, 'select' | 'execute'>

/** Responses read at a time: a bulk response is about 130 KB. */
const RESPONSE_BATCH = 20
const BodySchema = z.object({ state: z.literal('captured'), text: z.string() })
const LookupInputTypeSchema = z.enum(['spotify_id', 'isrc', 'track_name'])

function parseBody(body: unknown): unknown {
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) return null
  try {
    return JSON.parse(parsed.data.text)
  } catch {
    return null
  }
}

type Row = {
  mediaItemId: string
  inputType: string
  input: string
  sonovaultTrackId: string | null
  responseId: string | null
}

/** A matched row's own record, read from the response it names. */
function recordFrom(row: Row, payload: unknown): SonovaultStoredRecord | null {
  if (row.inputType === 'release') {
    const release = SonovaultReleaseSchema.safeParse(payload)
    if (!release.success) return null
    const track = release.data.tracks.find(
      ({ id }) => String(id) === row.sonovaultTrackId,
    )
    return track ? { kind: 'release', releaseId: release.data.id, track } : null
  }
  const inputType = LookupInputTypeSchema.safeParse(row.inputType)
  const bulk = SonovaultBulkResolveResponseSchema.safeParse(payload)
  if (!inputType.success || !bulk.success) return null
  const line = bulk.data.results.find(
    (result) =>
      sameSonovaultInput(inputType.data, row.input, result.input) &&
      result.status === 'matched' &&
      String(result.track?.id) === row.sonovaultTrackId,
  )
  return line?.track
    ? { kind: 'resolve', track: line.track, links: line.links }
    : null
}

/**
 * Keeps each matched track's own record on its lookup row, read from the
 * stored response the row names, for rows stored before records were kept
 * there. Makes no requests; `apply: false` only counts.
 */
export async function backfillSonovaultTrackRecords(
  database: Database,
  { apply }: { apply: boolean },
) {
  const rows = await database
    .select({
      mediaItemId: sonovaultTrackLookup.mediaItemId,
      inputType: sonovaultTrackLookup.inputType,
      input: sonovaultTrackLookup.input,
      sonovaultTrackId: sonovaultTrackLookup.sonovaultTrackId,
      responseId: sonovaultTrackLookup.responseId,
    })
    .from(sonovaultTrackLookup)
    .where(
      and(
        eq(sonovaultTrackLookup.status, 'matched'),
        isNull(sonovaultTrackLookup.record),
      ),
    )
    .orderBy(asc(sonovaultTrackLookup.responseId))
  const byResponse = new Map<string, Row[]>()
  let noResponse = 0
  for (const row of rows) {
    if (!row.responseId) {
      noResponse += 1
      continue
    }
    byResponse.set(row.responseId, [
      ...(byResponse.get(row.responseId) ?? []),
      row,
    ])
  }
  const responseIds = [...byResponse.keys()]
  let filled = 0
  let unreadable = 0
  for (let start = 0; start < responseIds.length; start += RESPONSE_BATCH) {
    const ids = responseIds.slice(start, start + RESPONSE_BATCH)
    const bodies = await database
      .select({ id: providerResponse.id, body: providerResponse.body })
      .from(providerResponse)
      .where(
        and(
          inArray(providerResponse.id, ids),
          isNotNull(providerResponse.body),
        ),
      )
    const updates: { id: string; record: SonovaultStoredRecord }[] = []
    for (const id of ids) {
      const payload = parseBody(bodies.find((body) => body.id === id)?.body)
      for (const row of byResponse.get(id) ?? []) {
        const record = payload === null ? null : recordFrom(row, payload)
        const valid = SonovaultStoredRecordSchema.safeParse(record)
        if (valid.success)
          updates.push({ id: row.mediaItemId, record: valid.data })
        else unreadable += 1
      }
    }
    filled += updates.length
    if (apply && updates.length)
      await database.execute(sql`
        update sonovault_track_lookup l set record = r.record, updated_at = now()
        from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) as r(id text, record jsonb)
        where l.media_item_id = r.id and l.record is null and l.status = 'matched'`)
  }
  return {
    apply,
    rows: rows.length,
    filled,
    unreadable,
    noResponse,
  }
}
