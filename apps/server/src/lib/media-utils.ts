import { createHash } from 'node:crypto'

export function createStableId(prefix: string, seed: string): string {
  return `${prefix}_${createHash('sha1').update(seed).digest('hex').slice(0, 20)}`
}

export function slugifyParts(...parts: Array<string | null | undefined>): string {
  const combined = parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/g, '')
    .replace(/-+$/g, '')

  return combined.length > 0 ? combined : 'untitled'
}

export function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null
  }

  if (/^\d{4}$/.test(value)) {
    return new Date(`${value}-01-01T00:00:00.000Z`)
  }

  if (/^\d{4}-\d{2}$/.test(value)) {
    return new Date(`${value}-01T00:00:00.000Z`)
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date
}

export function toIsoString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export function checksumJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
