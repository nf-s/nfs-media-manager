import { z } from 'zod'
import {
  isNativeJsonResponse,
  sanitizeProviderResponseBody,
  scrubText,
} from '@repo/media-plugin-sdk'
import type { ProviderResponseBody } from '@repo/schemas/provider-response-body'
import type { MixStation } from '@repo/schemas/subscriptions'
import type { PublicProviderCapturePolicy } from './provider-response-history'
import {
  LOT_RADIO_PAGE_SIZE,
  lotRadioActionReference,
  lotRadioChunkPaths,
  lotRadioFlightFrames,
} from './lotradio-api'

export const lotRadioActionId = /^[0-9a-f]{40,42}$/
const pageCursor = /^[a-zA-Z0-9+/=.:~_-]{1,1024}$/
const chunkPath = /^\/_next\/static\/[a-zA-Z0-9/_.~-]+\.js$/
const publicSlug = '[a-zA-Z0-9_~-]+'
const rinseShow = new RegExp(`^/api/query/v1/shows/${publicSlug}$`)
const ntsShow = new RegExp(`^/api/v2/shows/${publicSlug}$`)
const ntsEpisodes = new RegExp(`^/api/v2/shows/${publicSlug}/episodes$`)
const sitemap = /^\/sitemap(?:\d+)?\.xml(?:\.gz)?$/
const page = /^\d{1,6}$/
const site = {
  rinse: 'https://www.rinse.fm',
  nts: 'https://www.nts.live',
  lotradio: 'https://www.thelotradio.com',
}
const flightArguments = z.tuple([
  z
    .object({
      limit: z.literal(LOT_RADIO_PAGE_SIZE),
      order: z.enum(['date:asc', 'date:desc']),
      filters: z.object({}).strict(),
      staffChoice: z.literal(false),
      cursor: z.string().regex(pageCursor).optional(),
    })
    .strict(),
])

type Body = ProviderResponseBody
type Sanitizer = (
  body: Body,
  contentType: string | null,
  secrets: readonly string[],
) => Body
const unavailable = { state: 'unavailable', reason: 'policy' } satisfies Body

const nonArchiveFields =
  /^(?:ads?|adsettings|advertisements?|adplacements?|accounts?|viewer|currentuser|usersettings|userprofile)$/i
function hasNonArchiveFields(text: string) {
  try {
    for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)) {
      const token: unknown = JSON.parse(match[0].slice(0, -1).trimEnd())
      if (
        typeof token === 'string' &&
        nonArchiveFields.test(token.replace(/[^a-z]/gi, ''))
      )
        return true
    }
    return false
  } catch {
    return true
  }
}

const jsonBody: Sanitizer = (body, contentType, secrets) => {
  if (body.state !== 'captured') return body
  if (
    !contentType ||
    !/^application\/(?:[a-z0-9.+-]+\+)?json$/i.test(contentType)
  )
    return unavailable
  return hasNonArchiveFields(body.text)
    ? unavailable
    : sanitizeProviderResponseBody(body, contentType, secrets)
}

function kept(
  body: Extract<Body, { state: 'captured' }>,
  text: string,
  retainedRepresentation?: 'station-discovery' | 'station-episode-data',
): Body {
  return {
    state: 'captured',
    text,
    redacted: body.redacted === true || text !== body.text,
    ...(retainedRepresentation ? { retainedRepresentation } : {}),
  }
}

// Only catalogue Sitemap documents are admitted. Reject entity declarations,
// embedded markup, nonpublic URL data, and unrelated XML rather than guess.
const sitemapBody: Sanitizer = (body, contentType, secrets) => {
  if (body.state !== 'captured') return body
  if (
    !contentType ||
    !/^(?:text\/xml|application\/(?:xml|gzip|x-gzip))$/.test(contentType)
  )
    return unavailable
  const text = body.text.trim()
  const document = text.replace(
    /^<\?xml\s+version="1\.0"(?:\s+encoding="UTF-8")?\s*\?>\s*/i,
    '',
  )
  if (
    !/^<(sitemapindex|urlset)(?:\s+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9")?>[\s\S]*<\/\1>$/.test(
      document,
    ) ||
    scrubText(text, secrets) !== text
  )
    return unavailable
  const withoutLocations = document.replace(
    /<loc>\s*([^<\s]+)\s*<\/loc>/g,
    (tag, value: string) => {
      try {
        const url = new URL(value)
        return url.origin === site.nts &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
          ? ''
          : tag
      } catch {
        return tag
      }
    },
  )
  if (
    withoutLocations
      .replace(
        /<\/?(?:sitemapindex|urlset|sitemap|url)(?:\s+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9")?>|<(?:lastmod|changefreq|priority)>[a-zA-Z0-9:+. -]*<\/(?:lastmod|changefreq|priority)>/g,
        '',
      )
      .trim()
  )
    return unavailable
  return kept(body, body.text)
}

const indexBody: Sanitizer = (body, contentType) => {
  if (body.state !== 'captured') return body
  if (contentType !== 'text/html') return unavailable
  const paths = lotRadioChunkPaths(body.text)
  if (paths.some((path) => !chunkPath.test(path))) return unavailable
  return kept(
    body,
    paths
      .reverse()
      .map((path) => `<script src="${path}"></script>`)
      .join('\n'),
    'station-discovery',
  )
}

const chunkBody: Sanitizer = (body, contentType) => {
  if (body.state !== 'captured') return body
  if (
    !contentType ||
    !/^(?:application|text)\/(?:javascript|ecmascript)$/.test(contentType)
  )
    return unavailable
  const action = lotRadioActionReference.exec(body.text)?.[1]
  return kept(
    body,
    action ? `createServerReference("${action}",x,"getEpisodes")` : '',
    'station-discovery',
  )
}

const flightBody: Sanitizer = (body, contentType, secrets) => {
  if (body.state !== 'captured') return body
  if (contentType !== 'text/x-component') return unavailable
  const { rows, texts } = lotRadioFlightFrames(body.text)
  for (const row of rows) {
    const references = new Set<string>()
    let value: unknown
    try {
      value = JSON.parse(row.json, (_key, entry: unknown) => {
        if (
          typeof entry === 'string' &&
          /^\$[0-9a-f]+$/.test(entry) &&
          texts.has(entry.slice(1))
        )
          references.add(entry.slice(1))
        return entry
      })
    } catch {
      continue
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('items' in value) ||
      !Array.isArray(value.items)
    )
      continue
    if (hasNonArchiveFields(row.json)) return unavailable
    const payload = sanitizeProviderResponseBody(
      { state: 'captured', text: row.json },
      'application/json',
      secrets,
    )
    if (payload.state !== 'captured') return unavailable
    let text = `${row.id}:${payload.text}\n`
    for (const id of references) {
      const source = texts.get(id)
      if (source === undefined) return unavailable
      const safe =
        source.length === 0
          ? ({ state: 'captured', text: '' } satisfies Body)
          : sanitizeProviderResponseBody(
              { state: 'captured', text: source },
              'text/plain',
              secrets,
            )
      if (safe.state !== 'captured') return unavailable
      text += `${id}:T${Buffer.byteLength(safe.text).toString(16)},${safe.text}`
    }
    return kept(body, text, 'station-episode-data')
  }
  // Framework/error-only pages contain no public archive records. Keep the
  // adapter's empty-page retry behaviour without retaining UI and account rows.
  return kept(body, '', 'station-episode-data')
}

function queryMatches(url: URL, fields: Record<string, RegExp>) {
  const entries = [...url.searchParams]
  return (
    entries.length === Object.keys(fields).length &&
    new Set(entries.map(([key]) => key)).size === entries.length &&
    entries.every(
      ([key, value]) => Object.hasOwn(fields, key) && fields[key]?.test(value),
    )
  )
}

export function mixStationCapturePolicy(
  station: MixStation,
  knownAction?: () => string | null,
): PublicProviderCapturePolicy {
  return (url, init) => {
    if (
      url.origin !== site[station] ||
      url.username ||
      url.password ||
      url.hash
    )
      return null
    const headers = new Headers(init?.headers)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname
    if (method === 'POST') {
      if (
        station !== 'lotradio' ||
        path !== '/the-index' ||
        url.search ||
        typeof init?.body !== 'string' ||
        init.body.length > 2048 ||
        !isNativeJsonResponse(init.body) ||
        [...headers.keys()].some(
          (key) => !['accept', 'content-type', 'next-action'].includes(key),
        ) ||
        headers.get('accept') !== 'text/x-component' ||
        headers.get('content-type')?.toLowerCase() !==
          'text/plain;charset=utf-8'
      )
        return null
      const action = headers.get('next-action')
      if (
        !action ||
        !lotRadioActionId.test(action) ||
        (knownAction && knownAction() !== action)
      )
        return null
      try {
        const parsed = flightArguments.safeParse(JSON.parse(init.body))
        if (!parsed.success) return null
        const [args] = parsed.data
        return {
          readOnlyBody: [action, args.limit, args.order, args.cursor ?? null],
          sanitizeBody: flightBody,
        }
      } catch {
        return null
      }
    }
    if (
      !['GET', 'HEAD'].includes(method) ||
      init?.body != null ||
      [...headers.keys()].some((key) => key !== 'accept')
    )
      return null
    if (station === 'rinse') {
      const permitted =
        path === '/api/query/v1/shows/filter'
          ? queryMatches(url, { offset: page })
          : !url.search &&
            (rinseShow.test(path) ||
              /^\/api\/query\/v1\/schedule\/\d{4}-\d{2}-\d{2}$/.test(path))
      return permitted ? { sanitizeBody: jsonBody } : null
    }
    if (station === 'nts') {
      if (!url.search && sitemap.test(path))
        return { sanitizeBody: sitemapBody }
      const permitted =
        path === '/api/v2/collections/recently-added' || ntsEpisodes.test(path)
          ? queryMatches(url, { offset: page, limit: /^12$/ })
          : !url.search && ntsShow.test(path)
      return permitted ? { sanitizeBody: jsonBody } : null
    }
    if (url.search) return null
    if (path === '/the-index') return { sanitizeBody: indexBody }
    return chunkPath.test(path) ? { sanitizeBody: chunkBody } : null
  }
}
