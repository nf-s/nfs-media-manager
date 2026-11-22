import {
  MAX_PROVIDER_RESPONSE_BYTES,
  type ProviderResponseBody,
} from '@repo/schemas/provider-response-body'

type CaptureBody = ProviderResponseBody

const sensitive =
  /secret|password|passwd|passkey|token|authorization|authentication|cookie|headers?$|credential|session|apikey|apiuser|privatekey|csrf|xsrf|signature|^auth$|^key$|^jwt$|^(?:email(?:address)?|username|userplaycount|userscrobblecount|(?:uploader|uploadedby|createdby|addedby)(?:name|username|id)?|owner(?:name|username|id)?|filepath|localpath|absolutepath|userid|accountid|ip(?:address)?)$/i
const normalizedKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '')
export const sensitiveKey = (value: string) =>
  sensitive.test(normalizedKey(value))
const nativeCredential =
  /secret|password|passwd|passkey|token|authorization|authentication|cookie|headers?$|credential|session|apikey|apiuser|privatekey|csrf|xsrf|signature|^auth$|^key$|^jwt$|^(?:email(?:address)?|username|(?:uploader|uploadedby|createdby|owner)(?:name|username))$/i
const nativeCredentialKey = (value: string) =>
  nativeCredential.test(normalizedKey(value))
// A job's own account data keeps fields naming its user, owner or uploader.
// Credentials and email addresses are still removed; page cursors are kept.
const accountCredential =
  /secret|password|passwd|passkey|token|authorization|authentication|cookie|headers?$|credential|session|apikey|apiuser|privatekey|csrf|xsrf|signature|^auth$|^key$|^jwt$|^email(?:address)?$/i
const pageCursor = /^(?:next|prev|previous)pagetoken$/
export const accountCredentialKey = (value: string) => {
  const key = normalizedKey(value)
  return !pageCursor.test(key) && accountCredential.test(key)
}
type ScrubMode = 'archive' | 'native' | 'account'
const keyFilters: Record<ScrubMode, (value: string) => boolean> = {
  archive: sensitiveKey,
  native: nativeCredentialKey,
  account: accountCredentialKey,
}
// A JSON boolean can describe permission to use a token without carrying it.
const tokenCapability = /^can[A-Z][A-Za-z]*Token$/
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
  return scrubResponseText(value, secrets, 'archive')
}

function scrubResponseText(
  value: string,
  secrets: readonly string[],
  mode: ScrubMode,
) {
  const nativeCredentialsOnly = mode === 'native'
  const isSensitive = keyFilters[mode]
  let safe = value
  for (const secret of secrets) safe = safe.split(secret).join('[REDACTED]')
  safe = safe.replace(/https?:\/\/[^\s<>"']+/gi, (match, offset: number) => {
    // Preserve a matching BBCode URL delimiter outside the URL itself.
    const closingTag =
      safe.slice(Math.max(0, offset - 5), offset).toLowerCase() === '[url]'
        ? match.search(/\[\/url\]/i)
        : -1
    const link = closingTag < 0 ? match : match.slice(0, closingTag)
    const suffix = match.slice(link.length)
    try {
      const url = new URL(link)
      const removeFragment =
        Boolean(url.hash) &&
        !(
          nativeCredentialsOnly && /^#[a-z][a-z0-9_.:-]{0,127}$/i.test(url.hash)
        )
      let changed = Boolean(url.username || url.password || removeFragment)
      url.username = ''
      url.password = ''
      if (removeFragment) url.hash = ''
      for (const key of new Set(url.searchParams.keys())) {
        if (
          !isSensitive(key) &&
          !url.searchParams
            .getAll(key)
            .some((part) =>
              nativeCredentialsOnly
                ? containsSecret(part, secrets)
                : privatePath.test(part),
            )
        )
          continue
        changed = true
        url.searchParams.delete(key)
      }
      if (
        !nativeCredentialsOnly &&
        /(?:%2f(?:Users|home|private|Volumes|tmp|var|mnt|media)%2f|[a-z]%3a%5c)/i.test(
          url.pathname,
        )
      )
        return '[REDACTED]' + suffix
      return changed ? url.href + suffix : match
    } catch {
      return match
    }
  })
  if (!nativeCredentialsOnly)
    safe = safe
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
      .replace(
        /(^|[\s"'=(])(?:file:\/\/)?(?:[A-Z](?::|%3a)(?:[\\/]|%5c|%2f)|(?:\/|%2f)(?:Users|home|private|Volumes|tmp|var|mnt|media)(?:\/|%2f))[^<>"'\r\n,;|)]+/gi,
        '$1[REDACTED]',
      )
  if (nativeCredentialsOnly)
    safe = safe
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED]')
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        '[REDACTED]',
      )
  else
    safe = safe.replace(
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{5,}/gi,
      '[REDACTED]',
    )
  return safe.replace(
    /(["']?)([a-z][a-z0-9_-]{0,60})\1(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)/gi,
    (piece: string, quote: string, key: string, separator: string) =>
      isSensitive(key) ? `${quote}${key}${quote}${separator}[REDACTED]` : piece,
  )
}

export function sanitizeProviderResponseBody(
  body: CaptureBody,
  contentType: string | null,
  secrets: readonly string[],
): CaptureBody {
  return sanitizeResponseBody(body, contentType, secrets, 'archive')
}

/**
 * Sanitizes a job's own account data read: fields naming the user, owner or
 * uploader are kept, while credentials, configured secrets and email
 * addresses are removed as for any other response.
 */
export function sanitizeAccountResponseBody(
  body: CaptureBody,
  contentType: string | null,
  secrets: readonly string[],
): CaptureBody {
  return sanitizeResponseBody(body, contentType, secrets, 'account')
}

function sanitizeResponseBody(
  body: CaptureBody,
  contentType: string | null,
  secrets: readonly string[],
  mode: Exclude<ScrubMode, 'native'>,
): CaptureBody {
  const isSensitive = keyFilters[mode]
  const scrub = (text: string) => scrubResponseText(text, secrets, mode)
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
      const text = scrub(body.text)
      return {
        state: 'captured',
        text,
        redacted: body.redacted === true || text !== body.text,
      }
    }
    // Inspect each literal before trusting the original bytes. Parsing an
    // object alone would hide a credential overwritten by a duplicate key.
    let changed = false
    const member = /\s*:/y
    const booleanMember = /\s*:\s*(?:true|false)\s*(?=[,}])/y
    const probe = body.text.replace(
      /"(?:[^"\\]|\\.)*"/g,
      (token, offset: number) => {
        if (changed) return token
        const decoded: unknown = JSON.parse(token)
        if (typeof decoded !== 'string') return token
        if (scrub(decoded) !== decoded) changed = true
        if (!isSensitive(decoded)) return token
        const end = offset + token.length
        booleanMember.lastIndex = end
        if (tokenCapability.test(decoded) && booleanMember.test(body.text))
          return '""'
        member.lastIndex = end
        if (member.test(body.text)) changed = true
        return token
      },
    )
    if (!changed) changed = scrub(probe) !== probe
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
          (isSensitive(key) &&
            !(typeof value === 'boolean' && tokenCapability.test(key))) ||
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
        const safe = scrub(value)
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

/** Verify duplicate-free object/array JSON without reserializing its source. */
export function isNativeJsonResponse(text: string): boolean {
  if (
    text.length > MAX_PROVIDER_RESPONSE_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES
  )
    return false
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return false
    const containers: (Set<string> | null)[] = []
    const member = /\s*:/y
    for (const { 0: token, index } of text.matchAll(
      /"(?:[^"\\]|\\.)*"|[{}\[\]]/g,
    )) {
      if (token === '{' || token === '[') {
        containers.push(token === '{' ? new Set() : null)
      } else if (token === '}' || token === ']') {
        containers.pop()
      } else if (index !== undefined) {
        const keys = containers.at(-1)
        if (!keys) continue
        member.lastIndex = index + token.length
        if (!member.test(text)) continue
        const key: unknown = JSON.parse(token)
        if (typeof key !== 'string' || keys.has(key)) return false
        keys.add(key)
      }
    }
    return true
  } catch {
    return false
  }
}

export function isSafeNativeJsonResponse(
  text: string,
  secrets: readonly string[],
): boolean {
  if (!isNativeJsonResponse(text)) return false
  try {
    const variants = [
      ...new Set(
        secrets.flatMap((value) => [value, encodeURIComponent(value)]),
      ),
    ]
    if (containsSecret(text, variants)) return false
    const member = /\s*:/y
    const booleanMember = /\s*:\s*(?:true|false)\s*(?=[,}])/y
    for (const { 0: token, index } of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      const value: unknown = JSON.parse(token)
      if (
        typeof value !== 'string' ||
        scrubResponseText(value, variants, 'native') !== value
      )
        return false
      if (index === undefined || !nativeCredentialKey(value)) continue
      const end = index + token.length
      member.lastIndex = end
      if (!member.test(text)) continue
      booleanMember.lastIndex = end
      if (!tokenCapability.test(value) || !booleanMember.test(text))
        return false
    }
    return true
  } catch {
    return false
  }
}
