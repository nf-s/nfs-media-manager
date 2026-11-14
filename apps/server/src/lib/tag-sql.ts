import { sql, type SQL } from 'drizzle-orm'

export function normalizedTagSql(value: SQL): SQL {
  return sql`lower(btrim(regexp_replace(normalize(${value}, NFC), ${'[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'}, ' ', 'g')))`
}
