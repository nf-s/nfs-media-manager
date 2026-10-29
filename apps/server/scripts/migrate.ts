import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import * as schema from '@/schemas/db'
import pg from 'pg'
import { env } from '@/env'
import { getDatabaseConnectionOptions } from '@/lib/database-config'

async function main(): Promise<void> {
  const client = new pg.Client(getDatabaseConnectionOptions(env))

  await client.connect()

  try {
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: './drizzle' })
    console.info('Database migrations completed.')
  } finally {
    await client.end()
  }
}

void main()
