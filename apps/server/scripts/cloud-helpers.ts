import { createHash, createHmac, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { checksumJson } from '../src/lib/media-utils'

/** The owner address is supplied by the caller, never stored in the repository. */
export function requireOwnerEmail(
  environment: Record<string, string | undefined> = process.env,
): string {
  return z.email().parse(environment['CLOUD_OWNER_EMAIL'])
}
/**
 * Deployment-specific Worker variables. They are passed to Wrangler at deploy
 * time from the caller's environment so no account, origin or owner address is
 * stored in the repository.
 */
export function deployVariables(
  environment: Record<string, string | undefined> = process.env,
): string[] {
  z.string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(environment['CLOUDFLARE_ACCOUNT_ID'])
  const origin = new URL(z.url().parse(environment['CLOUDFLARE_APP_URL']))
  if (origin.protocol !== 'https:' || origin.pathname !== '/')
    throw new Error('CLOUDFLARE_APP_URL must be an HTTPS origin')
  const variables = {
    APP_URL: origin.origin,
    AUTH_BASE_URL: origin.origin,
    TRUSTED_ORIGINS: origin.origin,
    OWNER_EMAIL: requireOwnerEmail(environment),
  }
  return Object.entries(variables).flatMap(([key, value]) => [
    '--var',
    `${key}:${value}`,
  ])
}

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const inventorySchema = z
  .object({
    tables: z.array(
      z
        .object({
          schema: z.string(),
          name: z.string(),
          count: z.number().int().nonnegative(),
          sha256: digestSchema,
        })
        .strict(),
    ),
    sequences: z.array(
      z
        .object({
          schema: z.string(),
          name: z.string(),
          lastValue: z.string(),
          isCalled: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
export const manifestSchema = z
  .object({
    version: z.literal(1),
    source: digestSchema,
    target: digestSchema,
    ownerId: z.string().min(1),
    createdAt: z.iso.datetime(),
    archiveSha256: digestSchema,
    inventory: inventorySchema,
  })
  .strict()

export function connection(raw: string, target = false) {
  const url = new URL(raw)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    url.hash ||
    !/^\/[^/]+$/.test(url.pathname)
  ) {
    throw new Error('Invalid database connection')
  }
  for (const key of url.searchParams.keys()) {
    if (!['sslmode', 'channel_binding'].includes(key)) {
      throw new Error('Unsupported database URL parameter')
    }
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host.includes('-pooler.'))
    throw new Error('Use a direct database endpoint')
  if (target && !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(host)) {
    throw new Error('Target must be a direct Neon endpoint')
  }
  const database = decodeURIComponent(url.pathname.slice(1))
  if (!/^[A-Za-z0-9_-]+$/.test(database))
    throw new Error('Unsupported database name')
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (
    [host, database, user, password].some((value) =>
      /[\x00-\x1f\x7f]/.test(value),
    )
  ) {
    throw new Error('Unsupported connection characters')
  }
  const ssl = target || url.searchParams.get('sslmode') !== 'disable'
  return { host, port: Number(url.port || 5432), database, user, password, ssl }
}

export type Connection = ReturnType<typeof connection>

export function fingerprint(value: Connection): string {
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(value.host)
    ? 'loopback'
    : value.host
  return checksumJson([host, value.port, value.database])
}

export function requireDistinct(source: Connection, target: Connection): void {
  if (fingerprint(source) === fingerprint(target)) {
    throw new Error('Source and target must be different databases')
  }
}

export function migrationTarget(
  raw: string,
  localRehearsal: boolean,
): Connection {
  if (!localRehearsal) return connection(raw, true)
  const target = connection(raw)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.host)) {
    throw new Error('Local rehearsal requires an explicit loopback target')
  }
  return target
}

export function soleUser(rows: unknown): { id: string; email: string } {
  const users = z
    .array(z.object({ id: z.string().min(1), email: z.string() }))
    .parse(rows)
  const owner = users[0]
  if (users.length !== 1 || !owner) {
    throw new Error('Expected exactly one user')
  }
  return owner
}

export function soleOwner(
  rows: unknown,
  ownerEmail: string,
): { id: string; email: string } {
  const owner = soleUser(rows)
  if (owner.email !== ownerEmail) throw new Error('Unexpected owner email')
  return owner
}

export function bootstrapOwner(
  rows: unknown,
  manifestOwnerId: string,
  allowEmailReassignment: boolean,
  ownerEmail: string,
): { id: string; email: string } {
  const owner = soleUser(rows)
  if (owner.id !== manifestOwnerId)
    throw new Error('Owner ID differs from the manifest')
  if (owner.email !== ownerEmail && !allowEmailReassignment) {
    throw new Error('Explicit target-only owner email reassignment is required')
  }
  return owner
}

export function requireMatchingInventory(
  expected: unknown,
  actual: unknown,
): void {
  if (
    checksumJson(inventorySchema.parse(expected)) !==
    checksumJson(inventorySchema.parse(actual))
  ) {
    throw new Error('Database inventory does not match the backup')
  }
}

export function generateCredentials() {
  return {
    password: randomBytes(32).toString('base64url'),
    betterAuthSecret: randomBytes(48).toString('base64url'),
  }
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export async function requirePrivateDirectory(path: string): Promise<string> {
  const absolute = resolve(path)
  const info = await lstat(absolute)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(absolute)) !== absolute
  ) {
    throw new Error(
      'Use an owned, mode-0700 directory without symlink ancestors',
    )
  }
  return absolute
}

export async function privateOutput(path: string) {
  const absolute = resolve(path)
  await requirePrivateDirectory(dirname(absolute))
  return open(
    absolute,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  )
}

export async function writePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  const file = await privateOutput(path)
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n')
    await file.sync()
  } finally {
    await file.close()
  }
}

export async function privateInput(path: string) {
  const absolute = resolve(path)
  await requirePrivateDirectory(dirname(absolute))
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  const info = await file.stat()
  if (
    !info.isFile() ||
    info.size === 0 ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    info.nlink !== 1
  ) {
    await file.close()
    throw new Error('Use an owned, nonempty, mode-0600 regular file')
  }
  return file
}

export async function fileChecksum(path: string): Promise<string> {
  const file = await privateInput(path)
  try {
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk)
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

export function signNfoPayload(payload: string, key: string): string {
  if (Buffer.byteLength(key) < 32)
    throw new Error('Signing key must be at least 32 bytes')
  return createHmac('sha256', key)
    .update('nfs-media-manager:nfo-export:v1\n')
    .update(payload)
    .digest('hex')
}
