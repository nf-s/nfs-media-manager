import {
  MAX_PROVIDER_RESPONSE_BYTES,
  type ProviderResponseBody,
} from '@repo/schemas/provider-response-body'

type CaptureBody = ProviderResponseBody

const sensitive =
  /secret|password|passwd|passkey|token|authorization|authentication|cookie|headers?$|credential|session|apikey|apiuser|privatekey|csrf|xsrf|signature|^auth$|^key$|^jwt$|^(?:email(?:address)?|username|userplaycount|userscrobblecount|(?:uploader|uploadedby|createdby)(?:name|username|id)?|owner(?:name|username|id)?|filepath|localpath|absolutepath|userid|accountid|ip(?:address)?)$/i
const normalizedKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '')
export const sensitiveKey = (value: string) =>
  sensitive.test(normalizedKey(value))
const collection = /^(?:collages?|collections?)$/
const personalCollection =
  /^(?:(?:personal|private|user|my|own)(?:collages?|collections?)|(?:collages?|collections?)(?:personal|private|owned|mine))$/
const personalLabel =
  /^(?:name|title|label|collage(?:name|title)|collection(?:name|title))$/

function isPersonalCollection(record: object) {
  return Object.entries(record).some(([key, value]: [string, unknown]) => {
    const field = normalizedKey(key)
    if (
      /^(?:personal|private|ispersonal|isprivate|personalcollage)$/.test(field)
    )
      return value === true || value === 1 || value === '1' || value === 'true'
    return (
      /^(?:visibility|scope|type)$/.test(field) &&
      typeof value === 'string' &&
      /^(?:personal|private)$/i.test(value)
    )
  })
}

export function containsSecret(value: string, secrets: readonly string[]) {
  return secrets.some((secret) => value.includes(secret))
}

const privatePath =
  /^(?:(?:file:)?\/\/|file:)?(?:[A-Z](?::|%3a)(?:[\\/]|%5c|%2f)|(?:\/|%2f)(?:Users|home|private|Volumes|tmp|var|mnt|media)(?:\/|%2f))/i

export function scrubText(value: string, secrets: readonly string[]) {
  let safe = value
  for (const secret of secrets) safe = safe.split(secret).join('[REDACTED]')
  safe = safe.replace(/https?:\/\/[^\s<>"']+/gi, (link) => {
    try {
      const url = new URL(link)
      let changed = Boolean(url.username || url.password || url.hash)
      url.username = ''
      url.password = ''
      url.hash = ''
      for (const key of new Set(url.searchParams.keys())) {
        if (
          !sensitiveKey(key) &&
          !url.searchParams.getAll(key).some((part) => privatePath.test(part))
        )
          continue
        changed = true
        url.searchParams.delete(key)
      }
      if (
        /(?:%2f(?:Users|home|private|Volumes|tmp|var|mnt|media)%2f|[a-z]%3a%5c)/i.test(
          url.pathname,
        )
      )
        return '[REDACTED]'
      return changed ? url.href : link
    } catch {
      return link
    }
  })
  return safe
    .replace(
      /(^|[\s"'=(])(?:file:\/\/)?(?:[A-Z](?::|%3a)(?:[\\/]|%5c|%2f)|(?:\/|%2f)(?:Users|home|private|Volumes|tmp|var|mnt|media)(?:\/|%2f))[^<>"'\r\n,;|)]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{5,}/gi, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(
      /(["']?)([a-z][a-z0-9_-]{0,60})\1(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)/gi,
      (piece: string, quote: string, key: string, separator: string) =>
        sensitiveKey(key)
          ? `${quote}${key}${quote}${separator}[REDACTED]`
          : piece,
    )
}

export function sanitizeProviderResponseBody(
  body: CaptureBody,
  contentType: string | null,
  secrets: readonly string[],
): CaptureBody {
  if (body.state !== 'captured') return body
  if (!body.text.length) return { state: 'unavailable', reason: 'empty' }
  if (
    new TextEncoder().encode(body.text).byteLength > MAX_PROVIDER_RESPONSE_BYTES
  )
    return { state: 'unavailable', reason: 'byte-limit' }
  try {
    let parsed: unknown
    let numberSpellingUnavailable = false
    let sourceCount = 0
    const numberSources = new WeakMap<object, Map<string, string>>()
    try {
      parsed = JSON.parse(
        body.text,
        function (
          this: object,
          key: string,
          value: unknown,
          context?: { source: string },
        ) {
          if (
            typeof value === 'number' &&
            context?.source &&
            context.source !== JSON.stringify(value)
          ) {
            sourceCount += 1
            if (sourceCount > 100_000) {
              numberSpellingUnavailable = true
              return value
            }
            const sources = numberSources.get(this) ?? new Map<string, string>()
            sources.set(key, context.source)
            numberSources.set(this, sources)
          }
          return value
        },
      )
    } catch {
      if (
        !contentType ||
        !/^(?:text\/plain|application\/(?:[\w.+-]+\+)?json)\b/i.test(
          contentType,
        )
      )
        return { state: 'unavailable', reason: 'unsupported-format' }
      // Do not archive HTML forms, XML tags, or binary-looking text as plaintext.
      if (/[\x00-\x08\x0b-\x1f]|<\/?[a-z][^>]*>/i.test(body.text))
        return { state: 'unavailable', reason: 'unsupported-format' }
      const text = scrubText(body.text, secrets)
      return {
        state: 'captured',
        text,
        redacted: body.redacted === true || text !== body.text,
      }
    }
    // Inspect the raw document too, so an overwritten duplicate key cannot
    // conceal a known secret or sensitive text from the parsed object.
    let changed = scrubText(body.text, secrets) !== body.text
    if (!changed) {
      for (const { 0: token, index } of body.text.matchAll(
        /"(?:[^"\\]|\\.)*"/g,
      )) {
        const decoded: unknown = JSON.parse(token)
        if (
          typeof decoded === 'string' &&
          (scrubText(decoded, secrets) !== decoded ||
            (index !== undefined &&
              sensitiveKey(decoded) &&
              /^\s*:/.test(body.text.slice(index + token.length))))
        ) {
          changed = true
          break
        }
      }
    }
    const privateContainers = new WeakSet<object>()
    const privateRecords = new WeakSet<object>()
    const cleaned = JSON.stringify(
      parsed,
      function (this: object, key, value: unknown) {
        const field = normalizedKey(key)
        if (typeof value === 'object' && value) {
          const privateContainer =
            personalCollection.test(field) ||
            (privateContainers.has(this) &&
              /^(?:items|results|entries|data)$/.test(field))
          if (privateContainer) privateContainers.add(value)
          if (privateContainer || collection.test(field)) {
            const records: unknown[] = Array.isArray(value) ? value : [value]
            for (const record of records) {
              if (
                typeof record === 'object' &&
                record &&
                (privateContainer || isPersonalCollection(record))
              ) {
                privateRecords.add(record)
              }
            }
          }
        }
        if (
          sensitiveKey(key) ||
          containsSecret(key, secrets) ||
          (privateRecords.has(this) && personalLabel.test(field))
        ) {
          changed = true
          return undefined
        }
        if (typeof value === 'number') {
          const source = numberSources.get(this)?.get(key)
          if (secrets.includes(source ?? String(value))) {
            changed = true
            return '[REDACTED]'
          }
          if (source && 'rawJSON' in JSON && typeof JSON.rawJSON === 'function')
            return JSON.rawJSON(source)
          if (
            !Number.isFinite(value) ||
            (!('rawJSON' in JSON) && !Number.isSafeInteger(value))
          )
            numberSpellingUnavailable = true
          return value
        }
        if (typeof value !== 'string') return value
        const safe = scrubText(value, secrets)
        if (safe !== value) changed = true
        return safe
      },
    )
    if (cleaned === undefined || (changed && numberSpellingUnavailable))
      return { state: 'unavailable', reason: 'redact-failed' }
    return {
      state: 'captured',
      text: changed ? cleaned : body.text,
      redacted: body.redacted === true || changed,
    }
  } catch {
    return { state: 'unavailable', reason: 'redact-failed' }
  }
}
