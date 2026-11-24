import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '@/schemas/db'
import { env } from '@/env'
import { getDatabaseConnectionOptions } from '@/lib/database-config'
import { requestQueryLogger } from '@/lib/request-log'

const options = getDatabaseConnectionOptions(env)
const pool = new pg.Pool(options)

export const db = drizzle(pool, {
  schema,
  logger: requestQueryLogger,
})

// A read holding an item lock still needs ordinary connections for Spotify's
// request gate and independently committed evidence, including on failure.
export const providerLookupDb = drizzle(
  new pg.Pool({ ...options, max: 2, connectionTimeoutMillis: 10000 }),
  {
    schema,
    logger: requestQueryLogger,
  },
)
