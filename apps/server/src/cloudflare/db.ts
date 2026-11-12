import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'
import * as schema from '@/schemas/db'
import { env } from '@/env'

function createDatabase(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10000,
  })
  return drizzle(pool, { schema })
}

type Database = ReturnType<typeof createDatabase>
const context = new AsyncLocalStorage<Database>()

// The proxy contains no shared connection. Every operation resolves the current
// invocation's database, including calls made by the existing service layer.
const target = createDatabase(
  'postgresql://unconfigured@localhost/unconfigured',
)
export const db = new Proxy(target, {
  get(_target, property) {
    const current = context.getStore()
    if (!current)
      throw new Error('Database accessed outside a Worker invocation')
    const value = Reflect.get(current, property, current)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

export async function withCloudDatabase<T>(
  execute: () => Promise<T>,
): Promise<T> {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const url = new URL(env.DATABASE_URL)
  if (
    !url.hostname.endsWith('.neon.tech') &&
    !url.hostname.endsWith('.neon.build')
  ) {
    throw new Error('Cloud deployment requires a Neon database connection')
  }
  const database = createDatabase(env.DATABASE_URL)
  try {
    return await context.run(database, execute)
  } finally {
    await database.$client.end()
  }
}
