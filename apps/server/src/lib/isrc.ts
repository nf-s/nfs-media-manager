import { type SQL, sql } from 'drizzle-orm'

/** Two letters for the country, three for the registrant, then year and designation. */
export const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/

/** The stored form of an ISRC: uppercase, without hyphens or spaces. */
export const normalizedIsrc = (value: string) =>
  value.trim().toUpperCase().replace(/[-\s]/g, '')

/** A valid ISRC in its stored form, or null. */
export function validIsrc(value: string | null | undefined): string | null {
  if (!value) return null
  const isrc = normalizedIsrc(value)
  return isrcPattern.test(isrc) ? isrc : null
}

/** The SQL equivalent of validIsrc: the stored form, or null when invalid. */
export const validIsrcSql = (value: SQL) =>
  sql`substring(upper(regexp_replace(${value}, '[-[:space:]]', '', 'g')) from '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$')`
