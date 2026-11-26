import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  TidalSimilarKindSchema,
  TidalSuggestionSchema,
  type TidalSimilarKind,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import type { db } from '@/lib/db'
import { TidalSimilarDocumentSchema } from '@/lib/tidal-api'
import { providerResponse, scrapeJob, tidalSimilar } from '@/schemas/db'
import { similarSuggestions } from './tidal-similar-lookup'
import type { SimilarOrigin } from './tidal-similar-references'

type Page = {
  source: 'saved' | 'receipt'
  kind: TidalSimilarKind
  items: TidalSuggestion[]
  origin: SimilarOrigin
}

function similarReceiptLocation(
  url: string | null,
): { kind: TidalSimilarKind; seed: string } | undefined {
  const path =
    /\/(tracks|albums)\/(\d+)\/relationships\/similar(Tracks|Albums)$/.exec(
      url ?? '',
    )
  if (!path?.[2]) return
  return {
    kind: path[1] === 'tracks' ? 'track' : 'album',
    seed: path[2],
  }
}

export function parseStoredTrackSimilarReceipt(url: string, document: unknown) {
  const location = similarReceiptLocation(url)
  if (location?.kind !== 'track') return
  return parseSimilarReceipt(location, document)
}

function parseSimilarReceipt(
  location: NonNullable<ReturnType<typeof similarReceiptLocation>>,
  body: unknown,
) {
  try {
    const document = TidalSimilarDocumentSchema.parse(
      typeof body === 'string' ? JSON.parse(body) : body,
    )
    return similarSuggestions(location.kind, location.seed, document)
  } catch {
    return
  }
}

/** Read saved lists and successful receipts, including lists superseded by a later read. */
export async function readStoredSimilarPages(
  database: Pick<typeof db, 'select'>,
  purpose: 'references' | 'artist-credits' = 'references',
) {
  const artistCredits = purpose === 'artist-credits'
  const pages: Page[] = []
  let unreadable = 0
  const saved = await database
    .select()
    .from(tidalSimilar)
    .where(artistCredits ? eq(tidalSimilar.kind, 'track') : undefined)
    .orderBy(tidalSimilar.mediaItemId)
  const savedJobs = new Map<string, Page>()
  for (const row of saved) {
    const kind = TidalSimilarKindSchema.safeParse(row.kind).data
    const items =
      artistCredits && Array.isArray(row.items)
        ? row.items.flatMap(
            (item) => TidalSuggestionSchema.safeParse(item).data ?? [],
          )
        : z.array(TidalSuggestionSchema).safeParse(row.items).data
    if (!kind || !items) {
      unreadable++
      continue
    }
    const page: Page = {
      source: 'saved',
      kind,
      items,
      origin: {
        seedId: row.mediaItemId,
        jobId: row.scrapeJobId ?? undefined,
        observedAt: row.readAt,
      },
    }
    pages.push(page)
    if (row.scrapeJobId) savedJobs.set(row.scrapeJobId, page)
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
        artistCredits
          ? sql`${providerResponse.requestUrl} ~ '/relationships/similarTracks$'`
          : sql`${providerResponse.requestUrl} ~ '/relationships/similar(Tracks|Albums)$'`,
      ),
    )
    .orderBy(
      scrapeJob.createdAt,
      providerResponse.attempt,
      providerResponse.ordinal,
    )
  for (const receipt of receipts) {
    if (!receipt.job || typeof receipt.seed !== 'string') continue
    const page = savedJobs.get(receipt.job)
    if (page) {
      page.origin.responseId = receipt.id
      // Older saved lists retained names even when the response contained native artist IDs.
      if (!artistCredits) continue
    }
    const location = similarReceiptLocation(receipt.url)
    if (!location) continue
    const [stored] = await database
      .select({ body: providerResponse.body })
      .from(providerResponse)
      .where(eq(providerResponse.id, receipt.id))
    const items =
      stored?.body.state === 'captured' &&
      parseSimilarReceipt(location, stored.body.text)
    if (!items) {
      unreadable++
      continue
    }
    pages.push({
      source: 'receipt',
      kind: location.kind,
      items,
      origin: {
        seedId: receipt.seed,
        jobId: receipt.job,
        responseId: receipt.id,
        observedAt: receipt.at,
      },
    })
  }
  return { pages, unreadable }
}
