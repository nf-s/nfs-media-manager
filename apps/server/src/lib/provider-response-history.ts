import { createHash } from 'node:crypto'
import {
  ProviderItemNotFoundError,
  ProviderRequestError,
  sanitizeProviderResponseBody,
  isNativeJsonResponse,
  isSafeNativeJsonResponse,
  type MediaProviderPlugin,
  containsSecret,
  scrubText,
  sensitiveKey,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  ProviderResponseBodySchema,
  ProviderResponseCaptureSchema,
  type ProviderResponseCapture,
} from '@repo/schemas/provider-response'
import { hasProviderQuotaError } from './request-policy'

export type { ProviderResponseCapture } from '@repo/schemas/provider-response'

type RequestInput = Parameters<MediaPluginTestContext['request']>
type RequestIdentity = ProviderResponseCapture['request']
type ResponseEvidence = ProviderResponseCapture['response']
type CaptureBody = ResponseEvidence['body']
type PublicArchiveRequest = {
  readOnlyBody?: readonly (string | number | boolean | null)[]
  sanitizeBody?: (
    body: CaptureBody,
    contentType: string | null,
    secrets: readonly string[],
  ) => CaptureBody
}
export type PublicProviderCapturePolicy = (
  url: URL,
  init?: RequestInit,
) => PublicArchiveRequest | null

type ArchiveSanitizer = (input: {
  contentType: string | null
  text: string
  sensitiveValues: readonly string[]
}) => { contentType: string; text: string } | null

type ArchiveRepresentation = 'adapter' | 'native' | 'legacy-native'
const nativeJsonMime = /^application\/(?:[a-z0-9.+-]+\+)?json$/i

const accountPath =
  /(?:^|\/)(?:oauth2?|auth|authorize|token|log(?:in|out)|accounts?|me|users|profile|sessions?|credentials|authentication)(?:\/|$)/i
const MAX_RETAINED_BYTES_PER_ATTEMPT = 64 * 1024 * 1024
const spotifyTokenPath = 'https://accounts.spotify.com/api/token'
const trafficHeaders = [
  'accept',
  'accept-language',
  'content-type',
  'range',
  'x-user-agent',
]

export function providerResponseSecretValues(settings: Record<string, string>) {
  return Object.entries(settings).flatMap(([name, value]) =>
    name === 'market' && /^[A-Z]{2}$/.test(value) ? [] : [value],
  )
}

function requestSecrets(
  url: URL,
  init?: RequestInit,
  secrets: readonly string[] = [],
) {
  const values = new Set(secrets.map((value) => value.trim()).filter(Boolean))
  for (const value of [url.username, url.password]) {
    if (value) values.add(value)
  }
  for (const [key, value] of url.searchParams) {
    if (value && sensitiveKey(key)) values.add(value)
  }
  for (const [key, value] of new Headers(init?.headers)) {
    if (!sensitiveKey(key)) continue
    if (value.trim()) values.add(value.trim())
    for (const [, secret] of value.matchAll(
      /(?:^(?:Bearer|Basic)\s+|(?:^|[\s,;])[\w-]+=)([^\s,;]+)/gi,
    )) {
      if (secret) values.add(secret)
    }
  }
  return [...values].sort((first, second) => second.length - first.length)
}

function requestDescriptor(
  [input, init, options]: RequestInput,
  configuredSecrets: readonly string[],
  capturePolicy?: PublicProviderCapturePolicy,
) {
  const url = new URL(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  const policyMatch = capturePolicy?.(url, init)
  if (capturePolicy && !policyMatch) return null
  if (
    /^(?:accounts|oauth|auth)\./i.test(url.hostname) ||
    accountPath.test(url.pathname)
  )
    return null
  const lastfmMethod = url.searchParams.get('method')
  if (
    lastfmMethod &&
    /^(?:auth|user|track\.scrobble|track\.updateNowPlaying)\b/i.test(
      lastfmMethod,
    )
  )
    return null
  const secrets = requestSecrets(url, init, configuredSecrets)
  const path = decodeURIComponent(url.pathname)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    scrubText(path, secrets) !== path
  )
    return { identity: { method, url: null, key: null }, secrets, policyMatch }
  url.hash = ''
  url.searchParams.sort()
  const entries = [...url.searchParams]
  const known = entries.every(([name, value]) =>
    sensitiveKey(name)
      ? !/user|account|owner|uploader/i.test(name)
      : !containsSecret(value, secrets),
  )
  for (const name of new Set(url.searchParams.keys())) {
    if (sensitiveKey(name)) url.searchParams.delete(name)
  }
  const headers = new Headers(init?.headers)
  const safeHeaders = trafficHeaders.map((name) => headers.get(name))
  const replayable =
    known &&
    (((method === 'GET' || method === 'HEAD') && init?.body == null) ||
      (method === 'POST' && policyMatch?.readOnlyBody !== undefined)) &&
    safeHeaders.every(
      (value) => value === null || !containsSecret(value, secrets),
    )
  const identity: RequestIdentity = {
    method,
    url:
      (url.origin + url.pathname).length <= 2048
        ? url.origin + url.pathname
        : null,
    key: replayable
      ? createHash('sha256')
          .update(
            JSON.stringify([
              method,
              url.href,
              safeHeaders,
              options?.notFoundOn404 === true,
              options?.requireLocalTransport === true,
              ...(policyMatch?.readOnlyBody ? [policyMatch.readOnlyBody] : []),
            ]),
          )
          .digest('hex')
      : null,
  }
  return { identity, secrets, policyMatch }
}

export function pairedProviderResponseCapture(result: unknown) {
  if (
    typeof result !== 'object' ||
    !result ||
    !('providerResponseCapture' in result)
  )
    return undefined
  const capture = result.providerResponseCapture
  if (typeof capture !== 'object' || !capture || !('body' in capture))
    return undefined
  const body = ProviderResponseBodySchema.safeParse(capture.body)
  if (!body.success) return undefined
  const mediaType = 'contentType' in capture ? capture.contentType : null
  const contentType =
    typeof mediaType === 'string' &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i.test(
      mediaType,
    )
      ? mediaType.toLowerCase()
      : null
  const nativeStatus = 'status' in capture ? capture.status : undefined
  const status =
    typeof nativeStatus === 'number' &&
    Number.isInteger(nativeStatus) &&
    nativeStatus >= 100 &&
    nativeStatus <= 599
      ? nativeStatus
      : undefined
  const marker =
    'representation' in capture ? capture.representation : undefined
  if (marker !== undefined && marker !== 'native' && marker !== 'adapter')
    return undefined
  const representation: ArchiveRepresentation = marker ?? 'legacy-native'
  return { body: body.data, contentType, status, representation }
}

export class ProviderResponseStorageError extends Error {
  constructor() {
    super('Provider response evidence could not be saved.')
    this.name = 'ProviderResponseStorageError'
  }
}

/** Ordinals are assigned at dispatch, even when responses complete out of order. */
export function createProviderResponseRecorder(
  save: (capture: ProviderResponseCapture, artistId?: string) => Promise<void>,
  secrets: readonly string[],
  sanitizeResponseCapture?: ArchiveSanitizer,
  sanitizeNativeJsonResponseCapture?: MediaProviderPlugin['sanitizeNativeJsonResponseCapture'],
  capturePolicy?: PublicProviderCapturePolicy,
) {
  let ordinal = 0
  let retainedBytes = 0
  let failure: ProviderResponseStorageError | undefined
  function assertStored() {
    if (failure) throw failure
  }
  const forPhase = (
    phase: ProviderResponseCapture['phase'],
    artistId?: string,
  ) => {
    const begin = (...request: RequestInput) => {
      try {
        const descriptor = requestDescriptor(request, secrets, capturePolicy)
        if (!descriptor) return undefined
        const nextOrdinal = ++ordinal
        return async (
          response: ResponseEvidence,
          representation: ArchiveRepresentation = 'adapter',
        ) => {
          let { body, contentType } = response
          const trustedNativeJson =
            representation === 'native' &&
            body.state === 'captured' &&
            contentType !== null &&
            nativeJsonMime.test(contentType) &&
            sanitizeNativeJsonResponseCapture !== undefined
          if (trustedNativeJson && body.state === 'captured') {
            try {
              const text = body.text
              const approved = isNativeJsonResponse(text)
                ? sanitizeNativeJsonResponseCapture({
                    text,
                    sensitiveValues: descriptor.secrets,
                  })
                : null
              body =
                typeof approved === 'string' &&
                isSafeNativeJsonResponse(approved, descriptor.secrets)
                  ? {
                      state: 'captured',
                      text: approved,
                      redacted: body.redacted === true || approved !== text,
                    }
                  : { state: 'unavailable', reason: 'policy' }
            } catch {
              body = { state: 'unavailable', reason: 'redact-failed' }
            }
          }
          if (
            body.state === 'captured' &&
            contentType === 'text/html' &&
            sanitizeResponseCapture
          ) {
            try {
              const approved = sanitizeResponseCapture({
                contentType,
                text: body.text,
                sensitiveValues: descriptor.secrets,
              })
              if (
                !approved ||
                typeof approved.text !== 'string' ||
                !['text/html', 'application/json'].includes(
                  approved.contentType,
                )
              ) {
                body = { state: 'unavailable', reason: 'policy' }
              } else {
                contentType = approved.contentType
                body = {
                  state: 'captured',
                  text: approved.text,
                  redacted: true,
                }
              }
            } catch {
              body = { state: 'unavailable', reason: 'redact-failed' }
            }
          }
          if (
            !trustedNativeJson &&
            (body.state !== 'captured' ||
              contentType !== 'text/html' ||
              !sanitizeResponseCapture ||
              !body.redacted)
          ) {
            const sanitize =
              descriptor.policyMatch?.sanitizeBody ??
              sanitizeProviderResponseBody
            body = sanitize(body, contentType, descriptor.secrets)
          }
          if (body.state === 'captured') {
            const size = Buffer.byteLength(body.text)
            if (size > MAX_PROVIDER_RESPONSE_BYTES) {
              body = { state: 'unavailable', reason: 'byte-limit' }
            } else if (retainedBytes + size > MAX_RETAINED_BYTES_PER_ATTEMPT) {
              body = { state: 'unavailable', reason: 'capture-limit' }
            } else {
              retainedBytes += size
            }
          }
          try {
            await save(
              {
                ordinal: nextOrdinal,
                phase,
                request:
                  representation !== 'adapter' && descriptor.identity.key
                    ? {
                        ...descriptor.identity,
                        key: nativeKey(descriptor.identity.key),
                      }
                    : descriptor.identity,
                response: { ...response, contentType, body },
              },
              artistId,
            )
          } catch {
            failure ??= new ProviderResponseStorageError()
            throw failure
          }
        }
      } catch {
        return undefined
      }
    }
    return Object.assign(begin, {
      assertStored,
      scopedBodyPolicy: capturePolicy !== undefined,
    })
  }
  return Object.assign(forPhase, { assertStored, storageError: () => failure })
}

export type BeginProviderResponseCapture = ReturnType<
  ReturnType<typeof createProviderResponseRecorder>
>

/**
 * Replays only recorded SDK requests. The adapter gets no live fallback.
 * Client-credentials Spotify authentication receives a synthetic token, not an archived credential.
 */
type ReplayOptions = {
  secrets?: readonly string[]
  capturePolicy?: PublicProviderCapturePolicy
  projectNativeResponse?: (
    archive: ProviderResponseCapture,
    input: RequestInput[0],
  ) => Promise<Response>
}

const nativeKey = (key: string) =>
  createHash('sha256').update('native:').update(key).digest('hex')

export function createProviderResponseReplay(
  captures: readonly ProviderResponseCapture[],
  options: ReplayOptions = {},
) {
  const archive = captures
    .map((capture) => ProviderResponseCaptureSchema.parse(capture))
    .sort((first, second) => first.ordinal - second.ordinal)
  if (archive.some(({ ordinal }, index) => ordinal !== index + 1))
    throw new Error('Provider response history is incomplete')
  let next = 0
  let failure: Error | undefined
  const reject = (message: string): never => {
    failure ??= new Error(message)
    throw failure
  }
  const requestFor =
    (
      phase?: ProviderResponseCapture['phase'],
    ): MediaPluginTestContext['request'] =>
    async (...parameters) => {
      if (failure) throw failure
      const [input, init, requestOptions] = parameters
      init?.signal?.throwIfAborted()
      if (
        new URL(input).href === spotifyTokenPath &&
        init?.method?.toUpperCase() === 'POST'
      ) {
        return Response.json({
          access_token: 'offline-replay',
          token_type: 'Bearer',
          expires_in: 3600,
        })
      }
      const descriptor = requestDescriptor(
        parameters,
        options.secrets ?? [],
        options.capturePolicy,
      )
      const capture = archive[next]
      const key = descriptor?.identity.key
      if (!key || !capture || (phase !== undefined && capture.phase !== phase))
        return reject(
          'Provider replay request is missing or differs from the recorded request',
        )
      const native = capture.request.key === nativeKey(key)
      if (native) {
        if (!options.projectNativeResponse)
          return reject(
            'Provider replay requires an offline projector for native worker evidence',
          )
        if (capture.response.body.state === 'unavailable')
          return reject('Provider replay native response body is unavailable')
        next += 1
        return options.projectNativeResponse(capture, input)
      }
      if (capture.request.key !== key)
        return reject(
          'Provider replay request differs from the recorded request',
        )
      let received = capture.response
      next += 1
      while (
        received.retry !== undefined &&
        archive[next]?.response.retry === received.retry + 1 &&
        archive[next]?.request.key === capture.request.key &&
        archive[next]?.phase === capture.phase
      ) {
        const retry = archive[next]
        if (!retry) break
        received = retry.response
        next += 1
      }
      if (received.notFound && requestOptions?.notFoundOn404)
        throw new ProviderItemNotFoundError(
          'Provider has no matching recorded item',
        )
      if (
        received.status !== null &&
        (received.status >= 300 || received.status < 200)
      ) {
        const code =
          received.status === 429
            ? 'rate-limit'
            : [401, 403].includes(received.status)
              ? 'access-denied'
              : 'request-failed'
        throw new ProviderRequestError(
          'Recorded provider request failed',
          code,
          null,
        )
      }
      if (received.status === null)
        throw new ProviderRequestError(
          'Recorded provider request did not produce a response',
          'request-failed',
          null,
        )
      if (
        received.body.state !== 'captured' &&
        !(
          received.body.state === 'unavailable' &&
          received.body.reason === 'empty'
        )
      )
        return reject('Provider replay response body is unavailable')
      const text = received.body.state === 'captured' ? received.body.text : ''
      if (received.contentType?.includes('json')) {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          // The adapter owns JSON parsing when the upstream returned malformed data.
        }
        if (hasProviderQuotaError(parsed, true))
          throw new ProviderRequestError(
            'Recorded provider request was rate limited',
            'rate-limit',
            null,
          )
      }
      return new Response([204, 205].includes(received.status) ? null : text, {
        status: received.status,
        headers: received.contentType
          ? { 'content-type': received.contentType }
          : undefined,
      })
    }
  return {
    request: requestFor(),
    requestFor,
    assertComplete() {
      if (failure) throw failure
      if (next !== archive.length)
        reject('Provider replay did not consume its complete request history')
    },
  }
}

export async function replayProviderResponses<Result>(
  captures: readonly ProviderResponseCapture[],
  map: (request: MediaPluginTestContext['request']) => Promise<Result>,
  options: ReplayOptions = {},
): Promise<Result> {
  const replay = createProviderResponseReplay(captures, options)
  try {
    return await map(replay.request)
  } finally {
    replay.assertComplete()
  }
}
