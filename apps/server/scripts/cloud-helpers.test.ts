import { createHmac } from 'node:crypto'
import {
  mkdtemp,
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyPassword } from 'better-auth/crypto'
import {
  connection,
  bootstrapOwner,
  fileChecksum,
  fingerprint,
  generateCredentials,
  manifestSchema,
  migrationTarget,
  deployVariables,
  requireOwnerEmail,
  privateInput,
  quoteIdentifier,
  requireDistinct,
  requireMatchingInventory,
  signNfoPayload,
  soleOwner,
  writePrivateJson,
} from './cloud-helpers'
import { hashPassword } from 'better-auth/crypto'

const sourceUrl =
  'postgresql://admin:fake-password@localhost:5431/media-manager-dev?sslmode=disable'
const targetUrl =
  'postgresql://owner:fake-password@ep-test-123.us-east-2.aws.neon.tech/neondb?sslmode=require'
const emptyInventory = { tables: [], sequences: [] }

const ownerEmail = 'owner@example.com'

describe('cloud migration pure safety helpers', () => {
  it('builds Worker variables only from a complete caller environment', () => {
    const environment = {
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      CLOUDFLARE_APP_URL: 'https://media.example',
      CLOUD_OWNER_EMAIL: ownerEmail,
    }
    expect(deployVariables(environment)).toEqual([
      '--var',
      'APP_URL:https://media.example',
      '--var',
      'AUTH_BASE_URL:https://media.example',
      '--var',
      'TRUSTED_ORIGINS:https://media.example',
      '--var',
      `OWNER_EMAIL:${ownerEmail}`,
    ])
    for (const invalid of [
      { ...environment, CLOUDFLARE_ACCOUNT_ID: undefined },
      { ...environment, CLOUDFLARE_APP_URL: 'http://media.example' },
      { ...environment, CLOUDFLARE_APP_URL: 'https://media.example/path' },
      { ...environment, CLOUD_OWNER_EMAIL: undefined },
    ])
      expect(() => deployVariables(invalid)).toThrow()
  })

  it('requires a caller-supplied owner email', () => {
    expect(requireOwnerEmail({ CLOUD_OWNER_EMAIL: ownerEmail })).toBe(ownerEmail)
    expect(() => requireOwnerEmail({})).toThrow()
    expect(() => requireOwnerEmail({ CLOUD_OWNER_EMAIL: 'not-an-email' })).toThrow()
  })

  it('binds explicit sole-owner email reassignment to the manifest ID', () => {
    const original = [{ id: 'preserved-owner', email: 'previous@example.com' }]
    expect(bootstrapOwner(original, 'preserved-owner', true, ownerEmail)).toEqual(
      original[0],
    )
    expect(original[0]?.email).toBe('previous@example.com')
    expect(() => bootstrapOwner(original, 'preserved-owner', false, ownerEmail)).toThrow()
    expect(() => bootstrapOwner(original, 'different-id', true, ownerEmail)).toThrow()
    expect(() => bootstrapOwner([], 'preserved-owner', true, ownerEmail)).toThrow()
    expect(() =>
      bootstrapOwner(
        [...original, { id: 'other', email: ownerEmail }],
        'preserved-owner',
        true,
        ownerEmail,
      ),
    ).toThrow()
    expect(
      bootstrapOwner(
        [{ id: 'preserved-owner', email: ownerEmail }],
        'preserved-owner',
        false,
        ownerEmail,
      ).id,
    ).toBe('preserved-owner')
  })
  it('rejects equal destinations even with changed credentials, scheme or loopback spelling', () => {
    const source = connection(sourceUrl)
    const alias = connection(
      'postgres://other:other@127.0.0.1:5431/media-manager-dev?sslmode=require',
    )
    expect(() => requireDistinct(source, alias)).toThrow()
    expect(() =>
      requireDistinct(source, connection(targetUrl, true)),
    ).not.toThrow()
    expect(fingerprint(source)).not.toContain('admin')
  })

  it('requires direct Neon targets and rejects URL overrides, fragments and missing credentials', () => {
    for (const url of [
      sourceUrl,
      targetUrl.replace('ep-test-123.', 'ep-test-123-pooler.'),
      targetUrl + '&host=localhost',
      targetUrl + '&options=-csearch_path=other',
      targetUrl + '#fragment',
      targetUrl.replace(':fake-password', ''),
      targetUrl.replace('neondb?', 'dbname%3Devil?'),
    ]) {
      expect(() => connection(url, true)).toThrow()
    }
    expect(
      connection(targetUrl.replace('sslmode=require', 'sslmode=disable'), true)
        .ssl,
    ).toBe(true)
  })

  it('allows only an explicit, distinct loopback rehearsal', () => {
    expect(() => migrationTarget(sourceUrl, false)).toThrow()
    const rehearsal = migrationTarget(
      sourceUrl.replace('media-manager-dev', 'media-cloud-rehearsal'),
      true,
    )
    expect(() =>
      requireDistinct(connection(sourceUrl), rehearsal),
    ).not.toThrow()
    expect(() =>
      requireDistinct(connection(sourceUrl), migrationTarget(sourceUrl, true)),
    ).toThrow()
    expect(() => migrationTarget(targetUrl, true)).toThrow()
  })

  it('preserves the sole owner ID and never selects or deletes other users', () => {
    expect(soleOwner([{ id: 'existing-id', email: ownerEmail }], ownerEmail).id).toBe(
      'existing-id',
    )
    for (const rows of [
      [],
      [{ id: 'x', email: 'other@example.com' }],
      [
        { id: 'a', email: ownerEmail },
        { id: 'b', email: ownerEmail },
      ],
      [{ id: '', email: ownerEmail }],
    ]) {
      expect(() => soleOwner(rows, ownerEmail)).toThrow()
    }
  })

  it('rejects row, count, table and sequence drift', () => {
    const inventory = {
      tables: [
        { schema: 'public', name: 'user', count: 1, sha256: 'a'.repeat(64) },
      ],
      sequences: [
        { schema: 'drizzle', name: 'serial', lastValue: '3', isCalled: true },
      ],
    }
    expect(() => requireMatchingInventory(inventory, inventory)).not.toThrow()
    expect(() => requireMatchingInventory(inventory, emptyInventory)).toThrow()
    expect(() =>
      requireMatchingInventory(inventory, { ...inventory, sequences: [] }),
    ).toThrow()
    expect(() =>
      requireMatchingInventory(inventory, {
        ...inventory,
        tables: [{ ...inventory.tables[0], count: 2 }],
      }),
    ).toThrow()
    expect(() =>
      requireMatchingInventory(inventory, {
        ...inventory,
        tables: [{ ...inventory.tables[0], sha256: 'b'.repeat(64) }],
      }),
    ).toThrow()
  })

  it('validates manifests and quotes database identifiers', () => {
    expect(
      manifestSchema.safeParse({
        version: 1,
        source: 'a'.repeat(64),
        target: 'b'.repeat(64),
        ownerId: 'owner',
        createdAt: new Date().toISOString(),
        archiveSha256: 'c'.repeat(64),
        inventory: emptyInventory,
      }).success,
    ).toBe(true)
    expect(manifestSchema.safeParse({ version: 1 }).success).toBe(false)
    expect(quoteIdentifier('odd"name')).toBe('"odd""name"')
  })

  it('generates independent cryptographic credentials compatible with Better Auth', async () => {
    const first = generateCredentials()
    const second = generateCredentials()
    expect(first.password).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.betterAuthSecret).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(first.password).not.toBe(second.password)
    expect(first.betterAuthSecret).not.toBe(second.betterAuthSecret)
    expect(
      await verifyPassword({
        password: first.password,
        hash: await hashPassword(first.password),
      }),
    ).toBe(true)
  })

  it('signs exact bytes with a separate domain and rejects short keys', () => {
    const payload = '{"version":1}'
    const key = 'test-only-signing-key'.repeat(3)
    expect(signNfoPayload(payload, key)).toBe(
      createHmac('sha256', key)
        .update('nfs-media-manager:nfo-export:v1\n' + payload)
        .digest('hex'),
    )
    expect(signNfoPayload(payload + '\n', key)).not.toBe(
      signNfoPayload(payload, key),
    )
    expect(() => signNfoPayload(payload, 'short')).toThrow()
  })
})

describe('private local files (no database or network)', () => {
  it('creates exclusive private files, checksums them, and rejects permissive or symlink paths', async () => {
    // realpath avoids macOS /var -> /private/var aliases in the safety fixture.
    const { realpath } = await import('node:fs/promises')
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'cloud-helper-test-')),
    )
    await chmod(directory, 0o700)
    try {
      const path = join(directory, 'report.json')
      await writePrivateJson(path, { safe: true })
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ safe: true })
      expect(await fileChecksum(path)).toMatch(/^[a-f0-9]{64}$/)
      await expect(writePrivateJson(path, { safe: false })).rejects.toThrow()
      const linked = join(directory, 'link.json')
      await symlink(path, linked)
      await expect(privateInput(linked)).rejects.toThrow()
      const publicDirectory = join(directory, 'public')
      await mkdir(publicDirectory, { mode: 0o755 })
      await chmod(publicDirectory, 0o755)
      await expect(
        writePrivateJson(join(publicDirectory, 'secret.json'), {}),
      ).rejects.toThrow()
      await chmod(path, 0o644)
      await expect(privateInput(path)).rejects.toThrow()
      await writeFile(join(directory, 'empty'), '', { mode: 0o600 })
      await expect(privateInput(join(directory, 'empty'))).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
