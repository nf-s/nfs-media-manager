import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  archiveSha256,
  ArchivedAlbumReplayDetailSchema,
  ArchivedAlbumReplayError,
  ArchivedAlbumReplayPlanSchema,
} from '@/lib/archived-album-replay'

async function readPrivateFile(path: string, maxBytes: number) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > maxBytes
    )
      throw new ArchivedAlbumReplayError(
        'The reviewed input must be an owner-only regular file within the size limit.',
      )
    const bytes = await file.readFile()
    if (bytes.length > maxBytes)
      throw new ArchivedAlbumReplayError('The reviewed input is too large.')
    return bytes
  } finally {
    await file.close()
  }
}

async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      plan: { type: 'string' },
      sha256: { type: 'string' },
      output: { type: 'string' },
    },
  })
  if (!values.plan || !values.sha256 || !values.output)
    throw new ArchivedAlbumReplayError(
      'Specify --plan PRIVATE_FILE --sha256 REVIEWED_DIGEST --output NEW_PRIVATE_FILE.',
    )
  const bytes = await readPrivateFile(values.plan, 128 * 1024)
  const sha256 = archiveSha256(bytes)
  if (sha256 !== values.sha256)
    throw new ArchivedAlbumReplayError(
      'The plan differs from the digest explicitly approved for this commit.',
    )
  const plan = ArchivedAlbumReplayPlanSchema.parse(
    JSON.parse(bytes.toString('utf8')),
  )
  const archiveFile =
    plan.version === 1 ? plan.supplement.archiveFile : undefined
  if (
    (archiveFile && !isAbsolute(archiveFile.path)) ||
    ![plan.adapter, plan.projector, ...plan.dependencies].every(({ path }) =>
      isAbsolute(path),
    )
  )
    throw new ArchivedAlbumReplayError(
      'Use absolute paths to the reviewed code and archive.',
    )
  let detail
  if (archiveFile) {
    const archiveBytes = await readPrivateFile(
      archiveFile.path,
      32 * 1024 * 1024 + 4096,
    )
    if (archiveSha256(archiveBytes) !== archiveFile.sha256)
      throw new ArchivedAlbumReplayError(
        'The independent archive differs from the reviewed file.',
      )
    detail = ArchivedAlbumReplayDetailSchema.parse(
      JSON.parse(archiveBytes.toString('utf8')),
    )
  }
  const { commitArchivedAlbumReplay } =
    await import('@/services/archived-album-replay')
  const { db } = await import('@/lib/db')
  const output = await open(values.output, 'wx', 0o600)
  let wroteReceipt = false
  try {
    const result = await commitArchivedAlbumReplay(plan, sha256, detail)
    await output.writeFile(
      JSON.stringify({ version: 1, sha256, ...result }) + '\n',
    )
    await output.sync()
    wroteReceipt = true
    process.stdout.write('Saved the private archived replay receipt.\n')
  } finally {
    await output.close()
    if (!wroteReceipt) await unlink(values.output)
    await db.$client.end()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      (error instanceof ArchivedAlbumReplayError
        ? error.message
        : 'The archived replay could not be committed safely.') + '\n',
    )
    process.exitCode = 1
  })
