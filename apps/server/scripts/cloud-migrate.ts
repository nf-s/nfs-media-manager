import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { z } from 'zod'
import { getDatabaseConnectionOptions } from '../src/lib/database-config'
import {
  connection,
  bootstrapOwner,
  fileChecksum,
  fingerprint,
  generateCredentials,
  manifestSchema,
  migrationTarget,
  requireOwnerEmail,
  privateInput,
  privateOutput,
  quoteIdentifier,
  requireDistinct,
  requireMatchingInventory,
  requirePrivateDirectory,
  writePrivateJson,
  soleOwner,
} from './cloud-helpers'
import {
  databaseClient,
  inventory,
  liveIdentity,
  postgresTool,
  readOwner,
  requireEmpty,
  requireIdle,
  requireStoppedWorker,
} from './cloud-database'

let stage = 'configuration'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      action: { type: 'string', default: 'plan' },
      'target-url-env': {
        type: 'string',
        default: 'CLOUD_TARGET_DATABASE_URL',
      },
      report: { type: 'string' },
      bundle: { type: 'string' },
      archive: { type: 'string' },
      credentials: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'confirm-target': { type: 'string' },
      'writers-stopped': { type: 'boolean', default: false },
      'local-rehearsal': { type: 'boolean', default: false },
      'storage-approved': { type: 'boolean', default: false },
      'source-port': { type: 'string' },
      'reassign-owner-email': { type: 'boolean', default: false },
    },
  })
  const action = z
    .enum(['plan', 'backup', 'adopt', 'restore', 'verify', 'bootstrap'])
    .parse(values.action)
  const targetVariable = z
    .string()
    .regex(/^CLOUD_[A-Z0-9_]+$/)
    .parse(values['target-url-env'])
  // Capture before dotenv: target must be supplied by the caller, never source files.
  const targetUrl = z.string().min(1).parse(process.env[targetVariable])
  const ownerEmail = requireOwnerEmail()
  const target = migrationTarget(targetUrl, values['local-rehearsal'])
  const { env } = await import('../src/env')
  if (env.DATABASE_SCHEMA && env.DATABASE_SCHEMA !== 'public') {
    throw new Error(
      'Owner bootstrap currently requires the public application schema',
    )
  }
  const options = getDatabaseConnectionOptions(env)
  const sourceUrl =
    'connectionString' in options
      ? new URL(options.connectionString)
      : new URL('postgresql://localhost')
  if (!('connectionString' in options)) {
    sourceUrl.hostname = options.host
    sourceUrl.port = String(options.port)
    sourceUrl.username = options.user
    sourceUrl.password = options.password
    sourceUrl.pathname = '/' + encodeURIComponent(options.database)
    sourceUrl.searchParams.set(
      'sslmode',
      options.ssl ? 'verify-full' : 'disable',
    )
  }
  const source = connection(sourceUrl.href)
  if (values['source-port'])
    source.port = z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(values['source-port'])
  requireDistinct(source, target)
  const sourceFingerprint = fingerprint(source)
  const targetFingerprint = fingerprint(target)
  if (!values.report) throw new Error('A private report path is required')
  if (values.apply && !['restore', 'bootstrap'].includes(action)) {
    throw new Error('Apply is only valid with restore or bootstrap')
  }
  if (
    values.apply &&
    (values['confirm-target'] !== targetFingerprint ||
      !values['writers-stopped'])
  ) {
    throw new Error(
      'Apply requires the exact target fingerprint and stopped writers acknowledgement',
    )
  }
  if (values.apply && action === 'restore' && !values['storage-approved']) {
    throw new Error('Restore requires explicit storage capacity approval')
  }
  if (['backup', 'adopt'].includes(action) && !values['writers-stopped']) {
    throw new Error('Stop all writers before producing a cutover backup')
  }
  if (action === 'bootstrap' && values.apply && !values.credentials) {
    throw new Error('Bootstrap requires a private credentials handoff path')
  }
  const report = await privateOutput(values.report)
  const sourceClient = databaseClient(source)
  const targetClient = databaseClient(target)
  try {
    stage = 'target connection'
    await targetClient.connect()
    const targetIdentity = await liveIdentity(targetClient)
    // Target-only validation/bootstrap remains possible after source shutdown.
    if (['plan', 'backup', 'adopt', 'restore'].includes(action)) {
      stage = 'source connection and distinctness'
      await sourceClient.connect()
      const sourceIdentity = await liveIdentity(sourceClient)
      if (JSON.stringify(sourceIdentity) === JSON.stringify(targetIdentity)) {
        throw new Error('Source and target resolve to the same live database')
      }
    }
    let result: Record<string, unknown> = {
      action,
      applied: false,
      source: sourceFingerprint,
      target: targetFingerprint,
    }
    if (action === 'plan') {
      stage = 'read-only inventory plan'
      await sourceClient.query(
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      )
      await targetClient.query(
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      )
      const owner = await readOwner(sourceClient)
      await requireIdle(sourceClient)
      result = {
        ...result,
        ownerId: owner.id,
        sourceInventory: await inventory(sourceClient),
        targetInventory: await inventory(targetClient),
      }
    } else if (action === 'backup' || action === 'adopt') {
      stage = 'backup preconditions'
      if (!values.bundle) throw new Error('A new bundle directory is required')
      const bundle = resolve(values.bundle)
      await requirePrivateDirectory(dirname(bundle))
      await mkdir(bundle, { mode: 0o700 })
      await sourceClient.query(
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      )
      await requireStoppedWorker(sourceClient)
      const owner = await readOwner(sourceClient)
      await requireIdle(sourceClient)
      const snapshot = z
        .object({ snapshot: z.string().regex(/^[0-9A-F-]+$/i) })
        .parse(
          (await sourceClient.query('SELECT pg_export_snapshot() AS snapshot'))
            .rows[0],
        )
      const contents = await inventory(sourceClient)
      stage = 'archive creation'
      const archivePath =
        action === 'adopt'
          ? resolve(z.string().min(1).parse(values.archive))
          : join(bundle, 'database.dump')
      if (action === 'backup') {
        const archive = await privateOutput(archivePath)
        try {
          await postgresTool(
            'pg_dump',
            [
              '--format=custom',
              '--no-password',
              `--snapshot=${snapshot.snapshot}`,
            ],
            source,
            archive.fd,
          )
          await archive.sync()
        } finally {
          await archive.close()
        }
      } else {
        await postgresTool('pg_restore', ['--list', archivePath], target)
      }
      const archiveSha256 = await fileChecksum(archivePath)
      stage = 'manifest creation'
      const manifest = manifestSchema.parse({
        version: 1,
        source: sourceFingerprint,
        target: targetFingerprint,
        ownerId: owner.id,
        createdAt: new Date().toISOString(),
        archiveSha256,
        inventory: contents,
      })
      await writePrivateJson(join(bundle, 'manifest.json'), manifest)
      result = {
        ...result,
        archiveSha256,
        complete: true,
        archiveValidatedAgainstSource: action === 'backup',
        nextStep:
          'Verify the restored target against this inventory before bootstrap or serving traffic',
      }
    } else {
      stage = 'backup validation'
      if (!values.bundle)
        throw new Error('A completed backup bundle is required')
      const bundle = await requirePrivateDirectory(values.bundle)
      const manifestFile = await privateInput(join(bundle, 'manifest.json'))
      let manifest: z.infer<typeof manifestSchema>
      try {
        if ((await manifestFile.stat()).size > 8 * 1024 * 1024)
          throw new Error('Manifest too large')
        manifest = manifestSchema.parse(
          JSON.parse(await manifestFile.readFile('utf8')),
        )
      } finally {
        await manifestFile.close()
      }
      if (
        manifest.source !== sourceFingerprint ||
        manifest.target !== targetFingerprint
      ) {
        throw new Error('Backup is not bound to this source/target pair')
      }
      const archivePath = values.archive
        ? resolve(values.archive)
        : join(bundle, 'database.dump')
      if ((await fileChecksum(archivePath)) !== manifest.archiveSha256)
        throw new Error('Archive checksum mismatch')
      await postgresTool('pg_restore', ['--list', archivePath], target)
      if (action === 'restore') {
        stage = 'empty target validation'
        await requireEmpty(targetClient)
        if (values.apply) {
          stage = 'restore transaction'
          await postgresTool(
            'pg_restore',
            [
              '--no-password',
              '--no-owner',
              '--no-acl',
              '--exit-on-error',
              '--single-transaction',
              '--dbname',
              target.database,
              archivePath,
            ],
            target,
          )
        }
        result = {
          ...result,
          applied: values.apply,
          archiveSha256: manifest.archiveSha256,
        }
      }
      if (action !== 'restore' || values.apply) {
        stage = 'target inventory verification'
        await targetClient.query(
          values.apply && action === 'bootstrap'
            ? 'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE'
            : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        )
        if (action === 'bootstrap' && values.apply) {
          stage = 'owner bootstrap transaction'
          await requireStoppedWorker(targetClient)
          const tables = manifest.inventory.tables.map(
            (table) =>
              `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`,
          )
          if (!tables.length) throw new Error('Backup has no tables')
          await targetClient.query(
            `LOCK TABLE ${tables.join(', ')} IN ACCESS EXCLUSIVE MODE`,
          )
        }
        requireMatchingInventory(
          manifest.inventory,
          await inventory(targetClient),
        )
        const owner = await readOwner(targetClient)
        if (owner.id !== manifest.ownerId)
          throw new Error('Owner ID changed since backup')
        if (action === 'bootstrap')
          bootstrapOwner(
            [owner],
            manifest.ownerId,
            values['reassign-owner-email'],
            ownerEmail,
          )
        await requireIdle(targetClient)
        result = { ...result, verified: true, ownerId: owner.id }
        if (action === 'bootstrap' && values.apply) {
          const credentialsPath = values.credentials
          if (!credentialsPath) throw new Error('Missing credentials path')
          const credentials = generateCredentials()
          const passwordHash = await hashPassword(credentials.password)
          const credentialAccounts = z
            .array(z.object({ id: z.string() }))
            .parse(
              (
                await targetClient.query(
                  "SELECT id FROM public.account WHERE user_id = $1 AND provider_id = 'credential'",
                  [owner.id],
                )
              ).rows,
            )
          if (credentialAccounts.length > 1)
            throw new Error('Ambiguous credential accounts')
          // Persist before COMMIT so an interrupted process cannot lose the password.
          // The separate success report, not this file, confirms the transaction.
          await writePrivateJson(credentialsPath, {
            version: 1,
            email: ownerEmail,
            ownerId: owner.id,
            target: targetFingerprint,
            ...credentials,
            activation:
              'UNCONFIRMED until the bootstrap report says applied=true; install betterAuthSecret before starting any app',
          })
          await targetClient.query('DELETE FROM public.session')
          await targetClient.query('DELETE FROM public.verification')
          await targetClient.query('DELETE FROM public.film_import_preview')
          await targetClient.query(
            "DELETE FROM public.provider_secret WHERE provider LIKE 'spotify-account-%' AND key = 'state'",
          )
          await targetClient.query(
            'DELETE FROM public.two_factor WHERE user_id = $1',
            [owner.id],
          )
          await targetClient.query(
            'UPDATE public.apikey SET enabled = false, updated_at = now()',
          )
          await targetClient.query(
            "UPDATE public.invitation SET status = 'canceled' WHERE status = 'pending'",
          )
          await targetClient.query(
            "DELETE FROM public.account WHERE provider_id <> 'credential'",
          )
          await targetClient.query(
            `UPDATE public.account SET access_token = NULL, refresh_token = NULL,
            id_token = NULL, access_token_expires_at = NULL, refresh_token_expires_at = NULL,
            password = NULL, updated_at = now() WHERE user_id = $1`,
            [owner.id],
          )
          const credential = credentialAccounts[0]
          if (credential) {
            await targetClient.query(
              'UPDATE public.account SET password = $1, account_id = $2 WHERE id = $3',
              [passwordHash, owner.id, credential.id],
            )
          } else {
            await targetClient.query(
              `INSERT INTO public.account
              (id, account_id, provider_id, user_id, password, created_at, updated_at)
              VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
              [randomUUID(), owner.id, passwordHash],
            )
          }
          await targetClient.query(
            `UPDATE public."user" SET email = $2, role = 'admin', email_verified = true,
            banned = false, ban_reason = NULL, ban_expires = NULL, two_factor_enabled = false,
            is_anonymous = false, updated_at = now() WHERE id = $1`,
            [owner.id, ownerEmail],
          )
          soleOwner(
            (await targetClient.query('SELECT id, email FROM public."user"'))
              .rows,
            ownerEmail,
          )
          z.array(
            z.object({
              user_id: z.literal(owner.id),
              provider_id: z.literal('credential'),
            }),
          )
            .length(1)
            .parse(
              (
                await targetClient.query(
                  'SELECT user_id, provider_id FROM public.account',
                )
              ).rows,
            )
          await targetClient.query('COMMIT')
          result = {
            ...result,
            applied: true,
            credentialsWritten: true,
            nextStep:
              'Install the handoff betterAuthSecret, preserve the source MEDIA_ENCRYPTION_KEY, and keep SCRAPING_ENABLED=false plus queue consumers paused before starting services',
          }
        }
      }
    }
    stage = 'success report'
    await report.writeFile(JSON.stringify(result, null, 2) + '\n')
    await report.sync()
  } finally {
    await sourceClient.end().catch(() => undefined)
    await targetClient.end().catch(() => undefined)
    await report.close()
  }
}

void main().catch(() => {
  // Never print raw errors: drivers, parsers and subprocesses can contain secrets.
  process.stderr.write(
    `Cloud migration failed during ${stage}. No secrets were printed. Keep services stopped; review the documented preconditions and any private report.\n`,
  )
  process.exitCode = 1
})
