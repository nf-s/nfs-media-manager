import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { env } from '@/env'
import { createVersionedReadCache } from './versioned-read-cache'

const VersionSchema = z
  .array(
    z.object({
      version: z.string().min(1),
      database: z.string().min(1),
      role: z.string().min(1),
      schemas: z.string().min(1),
    }),
  )
  .length(1)

const OptionalDatabaseCacheErrorSchema = z.object({
  code: z.enum(['25006', '40001', '40P01', '42501', '42P01', '55P03', '57014']),
})

/** A persisted cache is optional when its tables or refresh cannot be used. */
export function canReadDatabaseWithoutCache(error: unknown) {
  return (
    OptionalDatabaseCacheErrorSchema.safeParse(error).success ||
    (error instanceof Error &&
      OptionalDatabaseCacheErrorSchema.safeParse(error.cause).success)
  )
}

async function readDatabaseVersion() {
  // The full MVCC snapshot includes in-progress writers, unlike xmax alone.
  // Every lookup checks the primary DB, so commits by scripts/other workers
  // invalidate too. Unrelated writes can cause conservative misses. No timers,
  // mutation hooks, persistent cache service or migration are required.
  const result =
    await db.execute(sql`select pg_current_snapshot()::text as version,
    current_database() as database, current_user as role,
    current_schemas(true)::text as schemas`)
  const parsed = VersionSchema.safeParse(result.rows)
  if (!parsed.success) return null
  // Never retain credentials. Include the server endpoint plus the actual DB,
  // role and search path so identical MVCC versions cannot cross databases.
  const endpoint = env.DATABASE_URL
    ? new URL(env.DATABASE_URL).host
    : `${env.DATABASE_HOST}:${env.DATABASE_PORT}`
  return JSON.stringify([endpoint, parsed.data[0]])
}

export function createDatabaseReadCache<T>(options: {
  maxEntries: number
  maxValueBytes: number
}) {
  return createVersionedReadCache<T>({
    ...options,
    ttlMs: 30_000,
    readVersion: readDatabaseVersion,
  })
}
