import {
  JsonValueSchema,
  ProviderRequestError,
  type MediaPluginScrapeContext,
  type MediaPluginTestContext,
  type PluginReference,
} from '@repo/media-plugin-sdk'
import { z } from 'zod'
import { isJsonRecord } from '@/lib/provider-normalizers'
import { retryAfterTime } from '@/lib/request-policy'

export const AlbumMbidSchema = z.string().uuid()
export const AlbumCountSchema = z.union([
  z.number().int().nonnegative().safe(),
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().safe()),
])
export const AlbumNumberSchema = z.union([
  z.number().finite().nonnegative(),
  z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .transform(Number)
    .pipe(z.number().finite().nonnegative()),
])
export const AlbumHttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
    } catch {
      return false
    }
  }, 'Expected a public HTTP URL')

export const AlbumRymUrlSchema = AlbumHttpUrlSchema.refine((value) => {
  try {
    const url = new URL(value)
    return (
      ['rateyourmusic.com', 'www.rateyourmusic.com'].includes(url.hostname) &&
      !url.port &&
      (/^\/release\/[^/]+\/[^/]+\/[^/]+\/?$/.test(url.pathname) ||
        /^\/music-review\/[^/]+\/[^/]+\/[^/]+\/\d+\/?$/.test(url.pathname))
    )
  } catch {
    return false
  }
}, 'Expected a RYM release or album review URL')

export function albumReference(
  context: MediaPluginScrapeContext,
  provider: string,
  ...referenceTypes: string[]
): PluginReference | undefined {
  return context.existingReferences.find(
    (reference) =>
      referenceTypes.includes(reference.referenceType) &&
      reference.metadata?.['sourceProvider'] === provider,
  )
}

export function albumBarcode(
  context: MediaPluginScrapeContext,
): string | undefined {
  const reference = context.existingReferences.find((item) =>
    ['upc', 'ean'].includes(item.referenceType),
  )
  return reference
    ? z
        .string()
        .regex(/^\d{8,14}$/)
        .parse(reference.externalId)
    : undefined
}

export function albumNames(context: MediaPluginScrapeContext) {
  const title = context.media?.title.trim()
  const artist = context.media?.artists.find((name) => name.trim())?.trim()
  if (!title || !artist)
    throw new Error('Album lookup requires a title and artist.')
  return { title, artist }
}

export function requireAlbum(
  context: MediaPluginScrapeContext,
  provider: string,
) {
  if (context.mediaType !== 'album')
    throw new Error(`${provider} scraping only supports albums.`)
}

export function albumSecret(
  context: MediaPluginTestContext,
  key: string,
  provider: string,
) {
  const value = context.secrets[key]?.trim()
  if (!value || /[\r\n]/.test(value))
    throw new Error(`${provider} ${key} is missing or invalid.`)
  return value
}

async function readAlbumErrorBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ''
  try {
    let chunk = await reader.read()
    while (!chunk.done) {
      bytes += chunk.value.byteLength
      if (bytes > 16384) {
        await reader.cancel()
        return null
      }
      body += decoder.decode(chunk.value, { stream: true })
      chunk = await reader.read()
    }
    return JSON.parse(body + decoder.decode())
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

export async function requestAlbumJson(
  context: MediaPluginTestContext,
  provider: string,
  url: URL,
  init?: RequestInit,
  classifyFailure?: (body: unknown) => ProviderRequestError['code'] | null,
) {
  const response = await context.request(url, init)
  if (!response.ok) {
    const bodyCode = classifyFailure
      ? classifyFailure(await readAlbumErrorBody(response))
      : null
    const limited = response.status === 429 || bodyCode === 'rate-limit'
    throw new ProviderRequestError(
      `${provider} request failed with status ${response.status}.`,
      limited
        ? 'rate-limit'
        : (bodyCode ??
            ([401, 403].includes(response.status)
              ? 'access-denied'
              : 'request-failed')),
      limited
        ? retryAfterTime(response.headers.get('retry-after'), Date.now(), 60000)
        : null,
    )
  }
  const payload = JsonValueSchema.parse(await response.json())
  if (!isJsonRecord(payload))
    throw new Error(`${provider} returned a non-object payload.`)
  const bodyCode = classifyFailure?.(payload)
  if (bodyCode)
    throw new ProviderRequestError(
      `${provider} returned a service error.`,
      bodyCode,
      bodyCode === 'rate-limit'
        ? retryAfterTime(response.headers.get('retry-after'), Date.now(), 60000)
        : null,
    )
  return payload
}

export function albumNameMatches(actual: string, expected: string) {
  const normalize = (value: string) =>
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  return normalize(actual) === normalize(expected)
}
