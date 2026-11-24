import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  TidalSimilarKindSchema,
  TidalSuggestionSchema,
  type TidalSimilarKind,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import type { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { TidalSimilarDocumentSchema } from '@/lib/tidal-api'
import { providerResponse, scrapeJob, tidalSimilar } from '@/schemas/db'
import { mapSuggestions } from './similar-library-matches'
import { codeKey } from './spotify-code-search'
import { similarSuggestions } from './tidal-similar-lookup'
import {
  shareSimilarReferences,
  type SimilarOrigin,
} from './tidal-similar-references'

type Page = {
  kind: TidalSimilarKind
  items: TidalSuggestion[]
  origin: SimilarOrigin
}

/** Replay both the saved list and older successful reads whose lists have since been replaced. */
export async function repairTidalSimilarReferences(
  database: typeof db,
  apply: boolean,
) {
  const pages: Page[] = []
  let unreadable = 0
  const saved = await database
    .select()
    .from(tidalSimilar)
    .orderBy(tidalSimilar.mediaItemId)
  const savedJobs = new Set<string>()
  for (const row of saved) {
    const kind = TidalSimilarKindSchema.safeParse(row.kind).data
    const items = z.array(TidalSuggestionSchema).safeParse(row.items).data
    if (!kind || !items) {
      unreadable++
      continue
    }
    pages.push({
      kind,
      items,
      origin: {
        seedId: row.mediaItemId,
        jobId: row.scrapeJobId ?? undefined,
        observedAt: row.readAt,
      },
    })
    if (row.scrapeJobId) savedJobs.add(row.scrapeJobId)
  }
  const receipts = await database
    .select({
      id: providerResponse.id,
      job: providerResponse.jobId,
      url: providerResponse.requestUrl,
      at: sql<Date>`coalesce(${providerResponse.receivedAt},${scrapeJob.createdAt})`.mapWith(
        scrapeJob.createdAt,
      ),
      seed: sql<unknown>`${scrapeJob.options}->>'itemId'`,
    })
    .from(providerResponse)
    .innerJoin(scrapeJob, eq(scrapeJob.id, providerResponse.jobId))
    .where(
      and(
        eq(providerResponse.provider, 'tidal'),
        eq(providerResponse.status, 200),
        eq(scrapeJob.status, 'succeeded'),
        sql`${scrapeJob.options}->>'task'='tidal-similar'`,
        sql`${providerResponse.requestUrl} ~ '/relationships/similar(Tracks|Albums)$'`,
      ),
    )
    .orderBy(
      scrapeJob.createdAt,
      providerResponse.attempt,
      providerResponse.ordinal,
    )
  for (const receipt of receipts) {
    if (!receipt.job || typeof receipt.seed !== 'string') continue
    if (savedJobs.has(receipt.job)) {
      const page = pages.find((page) => page.origin.jobId === receipt.job)
      if (page) page.origin.responseId = receipt.id
      continue
    }
    const path =
      /\/(tracks|albums)\/(\d+)\/relationships\/similar(Tracks|Albums)$/.exec(
        receipt.url ?? '',
      )
    if (!path?.[2]) continue
    const kind = path[1] === 'tracks' ? 'track' : 'album'
    const [stored] = await database
      .select({ body: providerResponse.body })
      .from(providerResponse)
      .where(eq(providerResponse.id, receipt.id))
    if (stored?.body.state !== 'captured') {
      unreadable++
      continue
    }
    try {
      const document = TidalSimilarDocumentSchema.parse(
        JSON.parse(stored.body.text),
      )
      pages.push({
        kind,
        items: similarSuggestions(kind, path[2], document),
        origin: {
          seedId: receipt.seed,
          jobId: receipt.job,
          responseId: receipt.id,
          observedAt: receipt.at,
        },
      })
    } catch {
      unreadable++
    }
  }
  const identities = new Map<string, Set<string>>()
  const disputed = new Set<string>()
  for (const { kind, items } of pages)
    for (const item of items) {
      const key = codeKey(kind, item.code ?? '')
      if (!key) continue
      const ids = identities.get(key) ?? new Set<string>()
      ids.add(item.tidalId)
      identities.set(key, ids)
      if (ids.size > 1) disputed.add(key)
    }
  let writes = 0
  const rollback = new Error('Finish dry run')
  for (const { kind, items, origin } of pages) {
    const located = items.map((item) => ({
      ...item,
      catalogMediaItemId:
        item.catalogMediaItemId ??
        createStableId(
          `catalog-${kind}`,
          JSON.stringify(['tidal', kind, item.tidalId]),
        ),
    }))
    try {
      await database.transaction(async (tx) => {
        const mapped = await mapSuggestions(tx, kind, located)
        writes += await shareSimilarReferences(
          tx,
          kind,
          mapped,
          origin,
          disputed,
        )
        if (!apply) throw rollback
      })
    } catch (error) {
      if (error !== rollback) throw error
    }
  }
  return {
    pages: pages.length,
    unreadable,
    disputedCodes: disputed.size,
    writes,
  }
}
