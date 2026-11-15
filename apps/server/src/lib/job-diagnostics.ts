import {
  JsonValueSchema,
  PluginDiagnosticSchema,
  type JsonValue,
  type PluginDiagnostic,
} from '@repo/media-plugin-sdk'
import { z } from 'zod'
import { redactJobText } from './job-errors'
import type { ProviderRequestDiagnostics } from '@repo/schemas/provider'

const EnvelopeSchema = z.object({
  stage: z.string().min(1).max(80),
  evidence: z.unknown(),
})
const REDACTED = '[REDACTED]'
const TRUNCATED = '[truncated]'
const INVALID = '[invalid-json]'
// Six search responses and candidate summaries plus the final decision fit
// together without losing the later fallback evidence. Individual caps still apply.
const MAX_BYTES = 384 * 1024
const MAX_ENTRIES = 14
const sensitiveKey =
  /secret|password|passwd|passkey|token|authorization|authentication|cookie|headers?|credential|session|apikey|apiuser|privatekey|clientsecret|csrf|xsrf|signature|^auth$|^key$|^jwt$/i

export const PROVIDER_ERROR_BODY_BYTES = 16 * 1024

export type CapturedProviderBody =
  | { state: 'captured'; text: string; relayed: boolean }
  | { state: 'empty' }
  | {
      state: 'unavailable'
      reason:
        | 'byte-limit'
        | 'read-failed'
        | 'unsupported-format'
        | 'local-response'
    }

type ProviderResponseEvidence = {
  diagnostics: ProviderRequestDiagnostics
  contentType: string | null
  body: CapturedProviderBody
  requestSecrets: string[]
}

// Keep raw upstream text off exception objects and out of API error logs.
const providerResponses = new WeakMap<Error, ProviderResponseEvidence>()

const isSensitiveKey = (key: string) =>
  sensitiveKey.test(key.replace(/[^a-z0-9]/gi, ''))
const isSensitiveProviderKey = (key: string) =>
  isSensitiveKey(key) ||
  /^(?:email(?:address)?|username|userid|accountid|ip(?:address)?)$/i.test(
    key.replace(/[^a-z0-9]/gi, ''),
  )

export function captureProviderResponseEvidence(
  error: Error,
  diagnostics: ProviderRequestDiagnostics,
  contentType: string | null,
  body: CapturedProviderBody,
  url: string | URL,
  headers: HeadersInit | undefined,
): void {
  const requestSecrets: string[] = []
  try {
    for (const [name, value] of new Headers(headers)) {
      if (!isSensitiveKey(name)) continue
      requestSecrets.push(value)
      for (const [, part] of value.matchAll(
        /(?:^(?:Bearer|Basic)\s+|(?:^|[\s,;])[\w-]+=)([^\s,;]+)/gi,
      )) {
        if (part) requestSecrets.push(part)
      }
    }
    const requestUrl = new URL(url)
    requestSecrets.push(requestUrl.username, requestUrl.password)
    for (const [name, value] of requestUrl.searchParams)
      if (isSensitiveProviderKey(name)) requestSecrets.push(value)
  } catch {
    // Diagnostics must preserve the HTTP failure even if request evidence is unreadable.
    body = { state: 'unavailable', reason: 'read-failed' }
  }
  providerResponses.set(error, {
    diagnostics,
    contentType,
    body,
    requestSecrets,
  })
}

function safeText(value: string, secrets: string[], maxBytes = 512): string {
  // Never retain a prefix that may cut a credential before it can be redacted.
  if (value.length > 16384) return '[omitted oversized text]'
  const safe = redactJobText(value, secrets)
    .replace(/https?:\/\/[^\s<>"']+/gi, (text) => {
      try {
        const url = new URL(text)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.href
      } catch {
        return '[invalid-url]'
      }
    })
    .replace(
      /((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]*/gi,
      '$1[REDACTED]',
    )
  if (Buffer.byteLength(safe) <= maxBytes) return safe
  let prefix = ''
  for (const character of safe) {
    if (Buffer.byteLength(prefix + character) > maxBytes - 32) break
    prefix += character
  }
  return `${prefix}${TRUNCATED}`
}

/** Retain provider evidence while keeping credentials out of durable snapshots. */
export function sanitizeProviderPayload(
  payload: unknown,
  secrets: string[],
): JsonValue {
  const sanitize = (value: string) =>
    safeText(value, secrets, Infinity)
      .replaceAll('\0', '\uFFFD')
      .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, REDACTED)
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (isSensitiveProviderKey(key) || sanitize(key) !== key) return undefined
    if (typeof value === 'number' && secrets.includes(String(value)))
      return REDACTED
    return typeof value === 'string' ? sanitize(value) : value
  })
  return JsonValueSchema.parse(JSON.parse(json))
}

export function sanitizeJobDiagnostic(
  diagnostic: unknown,
  secrets: string[],
): PluginDiagnostic | null {
  try {
    const envelope = EnvelopeSchema.safeParse(diagnostic)
    if (!envelope.success || envelope.data.evidence === undefined) return null
    // Raw Serply JSON has its own budget; candidate summaries keep their
    // original limits, including when the host sanitizes the entries again.
    const response = envelope.data.stage === 'serply.response'
    const maxNodes = response ? 4000 : 200
    const maxDepth = response ? 12 : 6
    const maxBytes = response ? 32 * 1024 : 6000
    const maxChildren = response ? 100 : 20
    const seen = new Set<object>()
    let nodes = 0
    let bytes = 0
    function visit(value: unknown, depth: number): JsonValue {
      if (++nodes > maxNodes || depth > maxDepth || bytes > maxBytes)
        return TRUNCATED
      if (value === null || typeof value === 'boolean') {
        bytes += Buffer.byteLength(JSON.stringify(value))
        return value
      }
      if (typeof value === 'number') {
        bytes += Buffer.byteLength(String(value))
        return secrets.includes(String(value))
          ? REDACTED
          : Number.isFinite(value)
            ? value
            : INVALID
      }
      if (typeof value === 'string') {
        const safe = safeText(value, secrets, response ? 4096 : 512)
        bytes += Buffer.byteLength(JSON.stringify(safe))
        return safe
      }
      if (typeof value !== 'object') return INVALID
      if (seen.has(value)) return '[circular]'
      seen.add(value)
      try {
        if (Array.isArray(value)) {
          const result: JsonValue[] = []
          for (
            let index = 0;
            index < Math.min(value.length, maxChildren);
            index++
          ) {
            if (nodes >= maxNodes || bytes > maxBytes) break
            result.push(visit(value[index], depth + 1))
          }
          if (result.length < value.length) result.push(TRUNCATED)
          return result
        }
        if (
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null
        )
          return INVALID
        const result: Record<string, JsonValue> = {}
        let count = 0
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue
          if (++count > maxChildren || nodes >= maxNodes || bytes > maxBytes) {
            result['[truncated]'] = true
            break
          }
          const safeKey = safeText(key, secrets)
          bytes += Buffer.byteLength(JSON.stringify(safeKey))
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          const safeValue = isSensitiveKey(key)
            ? REDACTED
            : descriptor && 'value' in descriptor
              ? visit(descriptor.value, depth + 1)
              : INVALID
          Object.defineProperty(result, safeKey, {
            value: safeValue,
            enumerable: true,
            configurable: true,
            writable: true,
          })
        }
        return result
      } finally {
        seen.delete(value)
      }
    }
    const parsed = PluginDiagnosticSchema.safeParse({
      stage: safeText(envelope.data.stage, secrets),
      evidence: visit(envelope.data.evidence, 0),
    })
    if (!parsed.success) return null
    if (
      Buffer.byteLength(JSON.stringify(parsed.data)) >
      (response ? 48 * 1024 : 8192)
    )
      return {
        stage: parsed.data.stage,
        evidence: '[omitted oversized diagnostic]',
      }
    return parsed.data
  } catch {
    // Malformed plugin values must never replace the provider's real failure.
    return null
  }
}

function safeProviderBody(
  body: CapturedProviderBody,
  secrets: string[],
): JsonValue {
  if (body.state !== 'captured') return body
  const { text } = body
  const workerRedacted = body.relayed && text.includes('[redacted]')
  const sanitize = (value: string) =>
    safeText(value, secrets, Infinity)
      .replaceAll('\0', '\uFFFD')
      .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, REDACTED)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    const namedField = /([\w.-]+)["']?\s*[:=]|<\/?([\w.-]+)/g
    if (
      /<(?:input|script)\b/i.test(text) ||
      Array.from(text.matchAll(namedField)).some(([, name, tag]) =>
        isSensitiveProviderKey(name ?? tag ?? ''),
      )
    )
      return { state: 'unavailable', reason: 'sensitive-fields' }
    const safe = sanitize(text)
    if (Buffer.byteLength(safe) > PROVIDER_ERROR_BODY_BYTES)
      return { state: 'unavailable', reason: 'byte-limit' }
    return {
      state: 'captured',
      format: 'text',
      text: safe,
      redacted: workerRedacted || safe !== text,
    }
  }
  try {
    let sensitiveKeyValue = false
    const sanitized = JSON.stringify(raw, (key, value: unknown) => {
      if (sanitize(key) !== key) sensitiveKeyValue = true
      if (isSensitiveProviderKey(key)) return REDACTED
      if (typeof value === 'number' && secrets.includes(String(value)))
        return REDACTED
      return typeof value === 'string' ? sanitize(value) : value
    })
    if (sensitiveKeyValue)
      return { state: 'unavailable', reason: 'sensitive-fields' }
    if (Buffer.byteLength(sanitized) > PROVIDER_ERROR_BODY_BYTES)
      return { state: 'unavailable', reason: 'byte-limit' }
    // Scan original JSON strings too. A duplicate property can hide its older
    // value from JSON.parse, including values written with Unicode escapes.
    const changed =
      sanitized !== JSON.stringify(raw) ||
      sanitize(text) !== text ||
      Array.from(text.matchAll(/"(?:[^"\\]|\\.)*"/g)).some(
        ({ 0: token, index }) => {
          const value = z.string().parse(JSON.parse(token))
          return (
            sanitize(value) !== value ||
            (isSensitiveProviderKey(value) &&
              /^\s*:/.test(text.slice(index + token.length)))
          )
        },
      )
    return {
      state: 'captured',
      format: 'json',
      text: changed ? sanitized : text,
      redacted: workerRedacted || changed,
    }
  } catch {
    return { state: 'unavailable', reason: 'redaction-failed' }
  }
}

export function providerResponseEvidence(
  error: unknown,
  secrets: string[],
): JsonValue[] {
  const evidence: JsonValue[] = []
  const seen = new Set<Error>()
  for (let current = error; current instanceof Error && seen.size < 6; ) {
    if (seen.has(current)) break
    seen.add(current)
    const response = providerResponses.get(current)
    if (response) {
      const credentials = [...secrets, ...response.requestSecrets]
      const {
        contentType,
        diagnostics: { retryAfter, quotaHeaders, ...status },
      } = response
      const safeRetry = JSON.stringify(retryAfter ?? null)
      const safeQuota = JSON.stringify(quotaHeaders ?? null)
      evidence.push({
        stage: 'provider.response',
        evidence: {
          ...status,
          ...(retryAfter && redactJobText(safeRetry, credentials) === safeRetry
            ? { retryAfter }
            : {}),
          ...(quotaHeaders &&
          redactJobText(safeQuota, credentials) === safeQuota
            ? { quotaHeaders }
            : {}),
          contentType:
            contentType &&
            redactJobText(contentType, credentials) === contentType
              ? contentType
              : null,
          responseBody: safeProviderBody(response.body, credentials),
        },
      })
    }
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value
  }
  return evidence
}

export function createJobDiagnostics(secrets: string[]) {
  const entries: PluginDiagnostic[] = []
  const credentials = secrets.filter(Boolean)
  let truncated = false
  const marker = { stage: 'diagnostics.truncated', evidence: true }
  return {
    recordDiagnostic(diagnostic: unknown): void {
      if (truncated) return
      const safe = sanitizeJobDiagnostic(diagnostic, credentials)
      if (!safe) return
      if (
        entries.length >= MAX_ENTRIES - 1 ||
        Buffer.byteLength(JSON.stringify([...entries, safe, marker])) >
          MAX_BYTES
      ) {
        truncated = true
        return
      }
      entries.push(safe)
    },
    snapshot(): JsonValue[] {
      return structuredClone(truncated ? [...entries, marker] : entries)
    },
  }
}
