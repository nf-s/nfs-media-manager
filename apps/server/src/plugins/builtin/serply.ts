import {
  PluginResultSchema,
  ProviderItemNotFoundError,
  ProviderRequestError,
  recordPluginDiagnostic,
  type JsonValue,
  type MediaPluginScrapeContext,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { sanitizeJobDiagnostic } from '@/lib/job-diagnostics'
import { z } from 'zod'
import {
  AlbumCountSchema,
  AlbumHttpUrlSchema,
  AlbumNumberSchema,
  AlbumRymUrlSchema,
  albumNameMatches,
  albumNames,
  albumReference,
  albumSecret,
  requestAlbumJson,
  requireAlbum,
} from './album-provider-helpers'

const ResponseSchema = z.object({ results: z.array(z.unknown()).max(100) })
const ResultSchema = z.object({
  title: z.string(),
  description: z.string().default(''),
  link: AlbumHttpUrlSchema,
  metadata: z
    .object({ rating: z.unknown().optional(), reviews: z.unknown().optional() })
    .nullish(),
})
const RatingSchema = AlbumNumberSchema.pipe(z.number().min(0).max(5))
const CountSchema = z
  .union([z.number(), z.string().regex(/^(?:\d+|\d{1,3}(?:,\d{3})+)$/)])
  .transform((value) =>
    typeof value === 'string' ? value.replaceAll(',', '') : value,
  )
  .pipe(AlbumCountSchema)

function rymPage(value: string) {
  const parsed = AlbumHttpUrlSchema.safeParse(value)
  if (!parsed.success) return null
  const url = new URL(parsed.data)
  const base = new URL(url)
  base.pathname = base.pathname.replace(/\/(?:reviews|lists)\/\d+\/?$/, '/')
  if (!AlbumRymUrlSchema.safeParse(base.href).success) return null
  const parts = base.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const review = parts[0] === 'music-review'
  if (!review && !['album', 'ep', 'mixtape'].includes(parts[1] ?? ''))
    return null
  const artist = parts[2]
  const title = parts[3]?.replace(/\.p$/, '')
  if (!artist || !title) return null
  base.search = ''
  base.hash = ''
  const release = new URL(base)
  if (review) release.pathname = `/release/album/${parts[2]}/${parts[3]}/`
  release.search = ''
  release.hash = ''
  return {
    artist,
    title,
    releaseUrl: release.href,
    referenceUrl: base.href,
    review,
    child: base.pathname !== url.pathname,
  }
}

function rating(result: z.infer<typeof ResultSchema>, review: boolean) {
  const aggregate = result.description.match(
    /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:\/\s*5[.\d]*\s*)?from\s+([\d,]+)\s+ratings?\b/i,
  )
  if (aggregate) {
    const value = RatingSchema.safeParse(aggregate[1])
    const votes = CountSchema.safeParse(aggregate[2])
    if (value.success && votes.success)
      return { value: value.data, votes: votes.data, source: 'description' }
  }
  // Review snippets can include the reviewer's own structured star rating.
  if (review) return null
  const value = RatingSchema.safeParse(result.metadata?.rating)
  const votes = CountSchema.safeParse(result.metadata?.reviews)
  return value.success
    ? {
        value: value.data,
        votes: votes.success ? votes.data : null,
        source: 'metadata',
      }
    : null
}

function genres(result: z.infer<typeof ResultSchema>) {
  const explicit = result.description.match(
    /\bGenres:\s*([^\n.…]+)(\.{1,3}|…|$)/i,
  )
  if (explicit?.[1]) {
    const names = explicit[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    if (
      ['...', '…'].includes(explicit[2] ?? '') &&
      !explicit[1].trim().endsWith(',')
    )
      names.pop()
    if (names.length) return { names, source: 'description' }
  }
  // Flattened header text can join two genre tiers without a delimiter.
  // Its first comma-delimited genre is complete even if a later boundary is lost.
  const firstGenre = result.description
    .match(/\bGenres\s+([^,\n]{1,80}),/i)?.[1]
    ?.trim()
  if (
    firstGenre &&
    !/\b(?:Descriptors|Language|Ranked|Reviews)\b|[.…]/i.test(firstGenre)
  )
    return { names: [firstGenre], source: 'header' }
  // The title's explicitly labelled genre also remains usable.
  const title = result.title.match(/\((?:Album|EP|Mixtape),\s*([^;)]+)\)/i)
  return {
    names: title?.[1] ? [title[1].trim()] : [],
    source: 'title',
  }
}

function candidates(
  payload: unknown,
  names: { title: string; artist: string },
  reference: ReturnType<typeof rymPage>,
  expectedYear: number | undefined,
  diagnostic: { candidates: JsonValue[]; reasons: Record<string, number> },
) {
  const matches = []
  for (const [index, entry] of ResponseSchema.parse(
    payload,
  ).results.entries()) {
    const record = (reason: string) => {
      diagnostic.reasons[reason] = (diagnostic.reasons[reason] ?? 0) + 1
      if (diagnostic.candidates.length >= 20) return
      const fields = z
        .object({
          title: z.unknown().optional(),
          description: z.unknown().optional(),
          link: z.unknown().optional(),
          metadata: z.unknown().optional(),
        })
        .safeParse(entry)
      diagnostic.candidates.push({
        index,
        reason,
        response: fields.success
          ? {
              title: diagnosticField(fields.data.title),
              description: diagnosticField(fields.data.description),
              link: diagnosticField(fields.data.link),
              metadata: diagnosticMetadata(fields.data.metadata),
            }
          : null,
      })
    }
    const parsed = ResultSchema.safeParse(entry)
    if (!parsed.success) {
      record(
        parsed.error.issues.some((issue) => issue.path[0] === 'link')
          ? 'invalid-url'
          : 'invalid-result',
      )
      continue
    }
    const result = parsed.data
    let page: ReturnType<typeof rymPage>
    try {
      page = rymPage(result.link)
    } catch {
      record('invalid-url')
      continue
    }
    if (!page) {
      record('invalid-url')
      continue
    }
    if (
      reference &&
      (!albumNameMatches(page.artist, reference.artist) ||
        !albumNameMatches(page.title, reference.title))
    ) {
      record('reference-identity-mismatch')
      continue
    }
    const title =
      result.title.match(
        /^(?:Reviews of |Lists with )?(.+) by (.+) \((?:Album|EP|Mixtape)[,)]/i,
      ) ?? result.title.match(/^Review for (.+) - (.+) by /i)
    const titleMatches =
      title?.[1] &&
      title[2] &&
      albumNameMatches(title[1], names.title) &&
      albumNameMatches(title[2], names.artist)
    const pathMatches =
      albumNameMatches(page.artist, names.artist) &&
      albumNameMatches(page.title, names.title)
    if (title && !titleMatches) {
      record('title-identity-mismatch')
      continue
    }
    if (!reference && !titleMatches && !pathMatches) {
      record('identity-mismatch')
      continue
    }
    if (/\((?:Album|EP|Mixtape);/i.test(result.title)) {
      record('edition-title')
      continue
    }
    if (
      /[-_]\d+$/.test(page.title) &&
      !albumNameMatches(page.title, names.title)
    ) {
      record('edition-path')
      continue
    }
    const descriptionIdentity = result.description.match(
      /^(.+), an? (?:Album|EP|Mixtape) by (.+?)(?:\.\s+(?:Released|Genres:)|\.$)/i,
    )
    if (
      descriptionIdentity &&
      (!albumNameMatches(descriptionIdentity[1] ?? '', names.title) ||
        !albumNameMatches(descriptionIdentity[2] ?? '', names.artist))
    ) {
      record('description-identity-mismatch')
      continue
    }
    const year = result.description.match(
      /\bReleased\s+(?:\d{1,2}\s+\w+\s+)?(\d{4})\b/i,
    )?.[1]
    if (expectedYear !== undefined && year && Number(year) !== expectedYear) {
      record('year-mismatch')
      continue
    }
    const score = rating(result, page.review || page.child)
    const tags = genres(result)
    record(!score && !tags.names.length ? 'no-rating-or-genres' : 'accepted')
    matches.push({
      result,
      page,
      rating: score,
      genres: tags,
    })
  }
  return matches.sort(
    (a, b) =>
      Number(a.page.review || a.page.child) -
      Number(b.page.review || b.page.child),
  )
}

function diagnosticField(value: unknown): JsonValue {
  if (typeof value === 'string')
    return value.length > 4096 ? '[omitted oversized field]' : value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function diagnosticMetadata(value: unknown): JsonValue {
  const parsed = z
    .object({
      rating: z.unknown().optional(),
      reviews: z.unknown().optional(),
    })
    .safeParse(value)
  return parsed.success
    ? {
        rating: diagnosticField(parsed.data.rating),
        reviews: diagnosticField(parsed.data.reviews),
      }
    : null
}

function recordSearchDiagnostic(
  context: MediaPluginScrapeContext,
  evidence: unknown,
  stage = 'serply.search',
) {
  const diagnostic = sanitizeJobDiagnostic(
    { stage, evidence },
    Object.values(context.secrets),
  )
  if (diagnostic) recordPluginDiagnostic(context, diagnostic)
}

export const serplyPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'serply',
    displayName: 'Serply (Rate Your Music)',
    description:
      'RYM album ratings and genres from indexed Google search results',
    mediaTypes: ['album'],
    identifierTypes: ['rym-url'],
    supportsNameLookup: true,
    rateLimit: {
      maxConcurrent: 2,
      concurrentRequests: true,
      minTimeMs: 250,
      configurableRequestBudget: true,
    },
    secrets: [
      {
        key: 'apiKey',
        label: 'API Key',
        required: true,
        envVars: ['SERPLY_API_KEY'],
        helpText:
          'Searches Google through Serply. Up to two searches per album; indexed ratings may lag RYM.',
      },
    ],
  },
  async scrapeMediaItem(context) {
    requireAlbum(context, 'Serply')
    const owned = albumReference(context, 'serply', 'rym-url')
    const existing =
      owned ??
      context.existingReferences.find(
        (item) => item.referenceType === 'rym-url',
      )
    const reference = existing
      ? rymPage(AlbumRymUrlSchema.parse(existing.externalId))
      : null
    const names =
      context.media?.title && context.media.artists.some((name) => name.trim())
        ? albumNames(context)
        : reference
          ? { title: reference.title, artist: reference.artist }
          : albumNames(context)
    const releaseDate = context.media?.releaseDate
      ? z.coerce.date().safeParse(context.media.releaseDate)
      : null
    const expectedYear = releaseDate?.success
      ? releaseDate.data.getUTCFullYear()
      : undefined
    const searches = []
    const matches: ReturnType<typeof candidates> = []
    let query = `site:rateyourmusic.com ${names.artist} ${names.title}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const payload = await search(context, query)
      searches.push({ query, response: payload })
      const diagnostic = { candidates: [], reasons: {} }
      try {
        matches.push(
          ...candidates(payload, names, reference, expectedYear, diagnostic),
        )
      } finally {
        recordSearchDiagnostic(context, {
          query,
          expectedYear: expectedYear ?? null,
          resultCount: Array.isArray(payload['results'])
            ? payload['results'].length
            : null,
          reason: ResponseSchema.safeParse(payload).success
            ? 'evaluated'
            : 'invalid-response',
          reasons: diagnostic.reasons,
          candidates: diagnostic.candidates,
        })
      }
      const selected = matches.find((match) => match.rating) ?? matches[0]
      if (
        matches.some((match) => match.rating) &&
        matches.some((match) => match.genres.source === 'description')
      )
        break
      const releaseUrl = reference?.releaseUrl ?? selected?.page.releaseUrl
      const nextQuery = releaseUrl
        ? `site:${releaseUrl}`
        : `${names.artist} ${names.title} Rate Your Music rating genres`
      if (nextQuery === query) break
      query = nextQuery
    }
    matches.sort(
      (a, b) =>
        Number(a.page.review || a.page.child) -
        Number(b.page.review || b.page.child),
    )
    const rated = matches.find((match) => match.rating)
    const tagged =
      matches.find(
        (match) =>
          match.genres.source === 'description' && match.genres.names.length,
      ) ?? matches.find((match) => match.genres.names.length)
    const selected = rated ?? tagged
    if (!selected)
      throw new ProviderItemNotFoundError(
        'Serply found no matching RYM rating or genres.',
      )
    const score = rated?.rating
    return PluginResultSchema.parse({
      payload: { searches },
      normalized: {
        mediaPatch: {
          metadata: {
            browse: score
              ? { ratingRymValue: score.value, ratingRymVotes: score.votes }
              : {},
            'plugin.serply.provenance': {
              source: 'rym',
              retrievalProvider: 'serply',
              sourceUrl: selected.result.link,
              ratingSourceUrl: rated?.result.link ?? null,
              ratingField: score?.source ?? null,
              genresSourceUrl: tagged?.result.link ?? null,
              genresField: tagged?.genres.source ?? null,
              retrievedAt: new Date().toISOString(),
              indexedAt: null,
            },
          },
        },
        references: [
          {
            referenceType: 'rym-url',
            externalId: selected.page.referenceUrl,
            isPrimary: true,
          },
        ],
        links: [
          {
            provider: 'serply',
            label: 'Rate Your Music',
            url: selected.result.link,
          },
        ],
        tags: (tagged?.genres.names ?? []).map((name) => ({
          name,
          kind: 'genre',
          source: 'rym',
          rawName: name,
        })),
      },
    })
  },
}

async function search(context: MediaPluginScrapeContext, query: string) {
  const url = new URL('https://api.serply.io/v1/search/')
  for (const [key, value] of Object.entries({
    q: query,
    gl: 'us',
    num: '10',
    filter: '0',
  }))
    url.searchParams.set(key, value)
  let status: number | null = null
  const recordResponse = (evidence: unknown) => {
    recordSearchDiagnostic(context, evidence, 'serply.response')
  }
  const payload = await requestAlbumJson(
    {
      ...context,
      request: async (input, init, options) => {
        const response = await context.request(input, init, options)
        status = response.status
        if (response.ok) {
          try {
            // Capture before envelope validation or service-error handling,
            // without consuming the body used by the shared request helper.
            const body: unknown = await response.clone().json()
            recordResponse({ query, status, response: body })
          } catch {
            recordResponse({
              query,
              status,
              responseUnavailable: 'invalid-or-unreadable-json',
            })
          }
        }
        return response
      },
    },
    'Serply',
    url,
    {
      headers: {
        'X-Api-Key': albumSecret(context, 'apiKey', 'Serply'),
        'X-User-Agent': 'desktop',
      },
    },
    (body) => {
      // The helper already bounds HTTP error reads to 16 KiB. A null result
      // cannot distinguish a JSON null from an oversized/unreadable body.
      if (status !== null && (status < 200 || status >= 300))
        recordResponse(
          body === null
            ? {
                query,
                status,
                responseUnavailable:
                  'null-invalid-unreadable-or-over-16384-bytes',
              }
            : { query, status, response: body },
        )
      return null
    },
  )
  if ('error' in payload || 'detail' in payload)
    throw new ProviderRequestError(
      'Serply returned a service error.',
      'request-failed',
    )
  return payload
}
