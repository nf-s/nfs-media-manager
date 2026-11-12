import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { loadWorkspaceEnv } from '../src/lib/load-workspace-env'
import {
  requireOwnerEmail,
  signNfoPayload,
  writePrivateJson,
} from './cloud-helpers'
import { checksumJson } from '../src/lib/media-utils'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      output: { type: 'string' },
      limit: { type: 'string', default: '1000' },
      'sign-key-env': { type: 'string' },
    },
  })
  const ownerEmail = requireOwnerEmail()
  // Signing credentials are explicitly caller-supplied, not loaded from source dotenv.
  const signingKey = values['sign-key-env']
    ? z
        .string()
        .min(32)
        .parse(
          process.env[
            z
              .string()
              .regex(/^CLOUD_[A-Z0-9_]+$/)
              .parse(values['sign-key-env'])
          ],
        )
    : undefined
  loadWorkspaceEnv()
  const root = resolve(
    z
      .string()
      .min(1)
      .parse(values.root ?? process.env.SCAN_DIR),
  )
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory()) {
    throw new Error('Choose a real directory without symlink ancestors')
  }
  const output = z.string().min(1).parse(values.output)
  const limit = z.coerce
    .number()
    .int()
    .positive()
    .max(10000)
    .parse(values.limit)
  // Reuse the bounded scanner and XML validator without calling any DB service.
  const { nfoFiles, readNfoFile } = await import('../src/services/file-imports')
  const files: { source: string; xml: string; birthtimeMs: number | null }[] =
    []
  let bytes = 0
  for await (const path of nfoFiles(root)) {
    if (files.length >= limit)
      throw new Error('Export limit reached; choose a smaller folder')
    if ((await realpath(path)) !== resolve(path))
      throw new Error('Symlink path changed during scan')
    const source = relative(root, path).split(sep).join('/')
    if (source.startsWith('../') || isAbsolute(source))
      throw new Error('File escaped scan root')
    const before = await lstat(path)
    const { content } = await readNfoFile(path)
    const after = await lstat(path)
    if (
      !before.isFile() ||
      !after.isFile() ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (await realpath(path)) !== resolve(path)
    ) {
      throw new Error('NFO changed during scan; retry on a stable tree')
    }
    bytes += Buffer.byteLength(content)
    if (bytes > 20 * 1024 * 1024)
      throw new Error('Metadata exceeds 20 MiB; choose a smaller folder')
    files.push({
      source,
      xml: content,
      birthtimeMs:
        before.birthtimeMs > 0 && before.birthtimeMs <= Date.now()
          ? before.birthtimeMs
          : null,
    })
  }
  if (!files.length) throw new Error('No NFO metadata found')
  files.sort((left, right) =>
    left.source < right.source ? -1 : left.source > right.source ? 1 : 0,
  )
  const payload = JSON.stringify({
    version: 1,
    kind: 'nfo-metadata',
    ownerEmail,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
    files,
  })
  if (Buffer.byteLength(payload) > 20 * 1024 * 1024)
    throw new Error('Encoded metadata exceeds 20 MiB')
  await writePrivateJson(output, {
    version: 1,
    payload,
    payloadChecksum: checksumJson(JSON.parse(payload)),
    signature: signingKey ? signNfoPayload(payload, signingKey) : null,
  })
}

void main().catch(() => {
  process.stderr.write(
    'NFO export failed. No upload or database operation was performed. Check the private output location, scan bounds and source files.\n',
  )
  process.exitCode = 1
})
