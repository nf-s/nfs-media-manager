import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  LocalWorkerResultSchema,
  type LocalWorkerResult,
} from '@repo/media-plugin-sdk/local-worker'
import { z } from 'zod'
import { WorkerError } from './config.js'

const EntrySchema = z
  .object({
    id: z.string().uuid(),
    state: z.enum(['claimed', 'result', 'acked']),
    result: LocalWorkerResultSchema.optional(),
  })
  .strict()
  .refine((entry) =>
    entry.state === 'result'
      ? entry.result?.id === entry.id &&
        (entry.result.kind !== 'response' || entry.result.body === '')
      : entry.result === undefined,
  )
const JournalSchema = z
  .object({
    version: z.literal(1),
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(EntrySchema),
  })
  .strict()
  .refine(
    ({ entries }) =>
      new Set(entries.map(({ id }) => id)).size === entries.length,
  )
type Journal = z.infer<typeof JournalSchema>

function syncDirectory(directory: string) {
  const descriptor = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function atomicWrite(directory: string, name: string, value: string) {
  const temporary = join(directory, `.write-${randomUUID()}`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, value, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  try {
    renameSync(temporary, join(directory, name))
    syncDirectory(directory)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function privateRead(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new WorkerError('Worker state must be private, owned regular files')
    }
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function validateDirectory(directory: string) {
  const stat = lstatSync(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new WorkerError(
      'Worker state directory must be owned and not a symlink',
    )
  }
}

export class JournalStore {
  private constructor(
    readonly directory: string,
    private journal: Journal,
  ) {}

  static open(directory: string, binding: string): JournalStore {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    validateDirectory(directory)
    chmodSync(directory, 0o700)
    atomicWrite(directory, '.gitignore', '*\n')
    const lock = join(directory, 'lock')
    try {
      mkdirSync(lock, { mode: 0o700 })
    } catch {
      throw new WorkerError(
        'Worker state is locked; stop the other process or inspect a stale lock before removing it',
      )
    }
    try {
      atomicWrite(lock, 'pid', `${process.pid}\n`)
      syncDirectory(directory)
      const path = join(directory, 'journal.json')
      const journal: Journal = existsSync(path)
        ? JournalSchema.parse(JSON.parse(privateRead(path)))
        : { version: 1, binding, entries: [] }
      if (journal.binding !== binding)
        throw new WorkerError(
          'Worker state belongs to another app, provider or origin',
        )
      const store = new JournalStore(directory, journal)
      store.save()
      return store
    } catch {
      JournalStore.releaseLock(directory)
      throw new WorkerError(
        'Cannot read private worker journal; preserve state and investigate before restarting',
      )
    }
  }

  private static releaseLock(directory: string) {
    const lock = join(directory, 'lock')
    if (existsSync(join(lock, 'pid'))) unlinkSync(join(lock, 'pid'))
    rmdirSync(lock)
    syncDirectory(directory)
  }

  close() {
    JournalStore.releaseLock(this.directory)
  }

  private save() {
    atomicWrite(this.directory, 'journal.json', JSON.stringify(this.journal))
  }

  has(id: string): boolean {
    return this.journal.entries.some((entry) => entry.id === id)
  }

  claim(id: string) {
    if (this.has(id)) throw new WorkerError('Task already claimed')
    this.journal.entries.push(EntrySchema.parse({ id, state: 'claimed' }))
    this.save()
  }

  pending(): string[] {
    return this.journal.entries
      .filter((entry) => entry.state !== 'acked')
      .map(({ id }) => id)
  }

  readResult(id: string): LocalWorkerResult {
    const entry = this.journal.entries.find((item) => item.id === id)
    if (entry?.result) {
      if (entry.result.kind === 'error') return entry.result
      try {
        return LocalWorkerResultSchema.parse({
          ...entry.result,
          body: privateRead(join(this.directory, `${id}.body`)),
        })
      } catch {
        /* Missing or uncertain body must never repeat a provider request. */
      }
    }
    return { kind: 'error', id, error: 'interrupted' }
  }

  record(result: LocalWorkerResult) {
    const validated = LocalWorkerResultSchema.parse(result)
    const entry = this.journal.entries.find((item) => item.id === validated.id)
    if (!entry) throw new WorkerError('Cannot record an unclaimed task')
    if (validated.kind === 'response')
      atomicWrite(this.directory, `${validated.id}.body`, validated.body)
    entry.state = 'result'
    entry.result =
      validated.kind === 'response' ? { ...validated, body: '' } : validated
    this.save()
  }

  acknowledge(id: string) {
    const entry = this.journal.entries.find((item) => item.id === id)
    if (!entry) throw new WorkerError('Cannot acknowledge an unclaimed task')
    entry.state = 'acked'
    delete entry.result
    this.save()
    const body = join(this.directory, `${id}.body`)
    if (existsSync(body)) unlinkSync(body)
  }
}

export function readStatus(directory: string) {
  if (!existsSync(directory))
    return { locked: false, pending: 0, acknowledged: 0 }
  validateDirectory(directory)
  const path = join(directory, 'journal.json')
  const journal = existsSync(path)
    ? JournalSchema.parse(JSON.parse(privateRead(path)))
    : null
  const lock = join(directory, 'lock')
  const pidPath = join(lock, 'pid')
  const pid = existsSync(pidPath)
    ? z.coerce.number().int().positive().parse(privateRead(pidPath).trim())
    : undefined
  return {
    locked: existsSync(lock),
    pid,
    pending:
      journal?.entries.filter(({ state }) => state !== 'acked').length ?? 0,
    acknowledged:
      journal?.entries.filter(({ state }) => state === 'acked').length ?? 0,
  }
}
