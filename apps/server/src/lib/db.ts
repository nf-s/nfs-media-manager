import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '@/schemas/db'
import { env } from '@/env'
import { getDatabaseConnectionOptions } from '@/lib/database-config'

const pool = new pg.Pool(getDatabaseConnectionOptions(env))

export const db = drizzle(pool, {
  schema,
})
