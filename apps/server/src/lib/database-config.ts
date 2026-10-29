import type { env } from '@/env'

type DatabaseEnvironment = Pick<
  typeof env,
  | 'NODE_ENV'
  | 'DATABASE_URL'
  | 'DATABASE_SCHEMA'
  | 'DATABASE_SSL'
  | 'DATABASE_HOST'
  | 'DATABASE_PORT'
  | 'DATABASE_USER'
  | 'DATABASE_PASSWORD'
  | 'DATABASE_NAME'
>

type DatabaseConnectionOptions = {
  ssl: false | { rejectUnauthorized: true }
  options?: string
} & (
  | { connectionString: string }
  | {
      host: string
      port: number
      user: string
      password: string
      database: string
    }
)

export function getDatabaseConnectionOptions(
  configuration: DatabaseEnvironment,
): DatabaseConnectionOptions {
  const mode =
    configuration.DATABASE_SSL ??
    (configuration.NODE_ENV === 'production' ? 'verify' : 'disable')
  const shared = {
    ssl: mode === 'verify' ? { rejectUnauthorized: true } : false,
    options: configuration.DATABASE_SCHEMA
      ? `-c search_path=${configuration.DATABASE_SCHEMA},public`
      : undefined,
  } satisfies Pick<DatabaseConnectionOptions, 'ssl' | 'options'>

  if (configuration.DATABASE_URL) {
    const url = new URL(configuration.DATABASE_URL)
    // pg lets URL parameters replace its TLS options. Keep the explicit policy
    // authoritative while retaining optional client certificates and root CAs.
    url.searchParams.set(
      'sslmode',
      mode === 'verify' ? 'verify-full' : 'disable',
    )
    return { ...shared, connectionString: url.href }
  }

  return {
    ...shared,
    host: configuration.DATABASE_HOST,
    port: configuration.DATABASE_PORT,
    user: configuration.DATABASE_USER,
    password: configuration.DATABASE_PASSWORD,
    database: configuration.DATABASE_NAME,
  }
}
