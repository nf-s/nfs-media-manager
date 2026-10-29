import {
  PluginDiagnosticSchema,
  type JsonValue,
  type PluginDiagnostic,
} from '@repo/media-plugin-sdk'
import { z } from 'zod'
import { redactJobText } from './job-errors'

const EnvelopeSchema = z.object({
  stage: z.string().min(1).max(80),
  evidence: z.unknown(),
})
const REDACTED = '[REDACTED]'
const TRUNCATED = '[truncated]'
const INVALID = '[invalid-json]'
// Two response entries (48 KiB each) plus two candidate summaries (8 KiB
// each) must fit together, including the collection's truncation marker.
const MAX_BYTES = 128 * 1024
const MAX_ENTRIES = 8
const sensitiveKey =
  /secret|password|passwd|passkey|token|authorization|authentication|cookie|headers?|credential|session|apikey|apiuser|privatekey|clientsecret|csrf|xsrf|signature|^auth$|^key$|^jwt$/i

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
          const safeValue = sensitiveKey.test(key.replace(/[^a-z0-9]/gi, ''))
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
