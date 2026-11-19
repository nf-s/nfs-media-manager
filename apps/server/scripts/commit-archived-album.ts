import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  archiveSha256,
  ArchivedAlbumReplayDetailSchema,
  ArchivedAlbumReplayError,
  ArchivedAlbumReplayLocalBodySchema,
  ArchivedAlbumReplayPlanSchema,
  type ArchivedAlbumReplayLocalBody,
  verifyArchivedGroupReview,
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

async function readPinnedArchive(pin: { path: string; sha256: string }) {
  if (!isAbsolute(pin.path))
    throw new ArchivedAlbumReplayError(
      'Use an absolute path to the reviewed archive.',
    )
  const bytes = await readPrivateFile(pin.path, 32 * 1024 * 1024 + 4096)
  if (archiveSha256(bytes) !== pin.sha256)
    throw new ArchivedAlbumReplayError(
      'The archive differs from the reviewed file.',
    )
  const decoded: unknown = JSON.parse(bytes.toString('utf8'))
  return decoded
}

async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      plan: { type: 'string' },
      sha256: { type: 'string' },
      output: { type: 'string' },
      'evidence-sha256': { type: 'string' },
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
  const reviewEvidence = values['evidence-sha256']
  let reviewBytes
  if (plan.version === 3) {
    const evidence = plan.review.evidenceFile
    if (reviewEvidence !== evidence.sha256 || !isAbsolute(evidence.path))
      throw new ArchivedAlbumReplayError(
        'Specify --evidence-sha256 with the separately approved group evidence digest.',
      )
    reviewBytes = await readPrivateFile(evidence.path, 128 * 1024)
    verifyArchivedGroupReview(plan, reviewBytes)
  } else if (reviewEvidence !== undefined)
    throw new ArchivedAlbumReplayError(
      'Group evidence requires a version 3 plan.',
    )
  const archiveFile =
    plan.version === 1 ? plan.supplement.archiveFile : undefined
  if (
    ![plan.adapter, plan.projector, ...plan.dependencies].every(({ path }) =>
      isAbsolute(path),
    )
  )
    throw new ArchivedAlbumReplayError(
      'Use absolute paths to the reviewed code and archive.',
    )
  const detail = archiveFile
    ? ArchivedAlbumReplayDetailSchema.parse(
        await readPinnedArchive(archiveFile),
      )
    : undefined
  const localOriginals = new Map<string, ArchivedAlbumReplayLocalBody>()
  for (const { responseId, localArchive } of plan.originals) {
    if (localArchive)
      localOriginals.set(
        responseId,
        ArchivedAlbumReplayLocalBodySchema.parse(
          await readPinnedArchive(localArchive.file),
        ),
      )
  }
  const { commitArchivedAlbumReplay } =
    await import('@/services/archived-album-replay')
  const { db } = await import('@/lib/db')
  const output = await open(values.output, 'wx', 0o600)
  let wroteReceipt = false
  try {
    const result = await commitArchivedAlbumReplay(
      plan,
      sha256,
      detail,
      localOriginals,
      reviewBytes,
    )
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
