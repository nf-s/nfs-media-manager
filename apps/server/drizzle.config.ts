import type { Config } from 'drizzle-kit'
import { env } from './src/env'
import { getDatabaseConnectionOptions } from './src/lib/database-config'

const connection = getDatabaseConnectionOptions(env)

export default {
  schema: './src/schemas/db.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials:
    'connectionString' in connection
      ? { url: connection.connectionString, ssl: connection.ssl }
      : connection,
} satisfies Config
