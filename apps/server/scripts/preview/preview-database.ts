import type { env } from '@/env'

/** Every database the preview command creates starts with this name. */
export const previewDatabasePrefix = 'media_preview_run_'
export const previewDatabasePattern = /^media_preview_run_[0-9a-f]{8}$/

const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isLocalDatabaseHost(host: string): boolean {
  return localHosts.has(host)
}

/**
 * Stops a preview script unless its settings name a disposable preview
 * database on a local server, so it can never write to the real library.
 */
export function assertPreviewDatabase(
  configuration: Pick<
    typeof env,
    'DATABASE_URL' | 'DATABASE_HOST' | 'DATABASE_NAME'
  >,
): void {
  if (configuration.DATABASE_URL)
    throw new Error('Refusing: the preview does not connect with DATABASE_URL')
  if (!isLocalDatabaseHost(configuration.DATABASE_HOST))
    throw new Error('Refusing: the preview database host is not local')
  if (!previewDatabasePattern.test(configuration.DATABASE_NAME))
    throw new Error('Refusing: not a preview database')
}
