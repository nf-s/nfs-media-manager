import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '@/lib/db'
import { scrapeJob, scrapeJobItem, scrapeJobLog } from '@/schemas/db'
import { processQueuedJobs } from '@/services/jobs'

const workerLock = 614105
const interruptionReason =
  'Worker interrupted before the job finished. Review the retained results and retry unfinished work manually.'
const lockResultSchema = z.object({
  rows: z.array(z.object({ locked: z.boolean() })).length(1),
})

export interface JobWorker {
  stop(): Promise<void>
}

export interface JobWorkerOptions {
  onFatal(error: unknown): void
  pollIntervalMs?: number
}

export async function startJobWorker({
  onFatal,
  pollIntervalMs = 2000,
}: JobWorkerOptions): Promise<JobWorker> {
  z.number().int().positive().max(2147483647).parse(pollIntervalMs)
  const client = await db.$client.connect()
  let stopping = false
  let failed = false
  let released = false
  let timer: ReturnType<typeof setInterval> | undefined = undefined
  let processing: Promise<void> | undefined
  let checking: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined

  function disableDispatch(): void {
    stopping = true
    if (timer !== undefined) clearInterval(timer)
  }

  function fatal(error: unknown): void {
    if (failed || released) return
    failed = true
    disableDispatch()
    release()
    // Ownership is no longer trustworthy. The application must terminate,
    // rather than reconnect or wait for work while another owner can start.
    onFatal(error)
  }

  function connectionEnded(): void {
    fatal(new Error('Job worker ownership connection ended unexpectedly.'))
  }

  function release(): void {
    if (released) return
    released = true
    client.removeListener('error', fatal)
    client.removeListener('end', connectionEnded)
    // Never return a session that may still own an advisory lock to the pool.
    client.release(true)
  }

  client.on('error', fatal)
  client.on('end', connectionEnded)

  try {
    const ownership = lockResultSchema.parse(
      await client.query('select pg_try_advisory_lock($1) as locked', [
        workerLock,
      ]),
    )
    if (!ownership.rows[0]?.locked) {
      throw new Error('Another job worker already owns this database.')
    }

    // Recovery shares the ownership session, so losing that session rolls the
    // transaction back. Lock parent rows just like all normal worker writes.
    await drizzle(client).transaction(async (tx) => {
      const interrupted = await tx
        .select({ id: scrapeJob.id })
        .from(scrapeJob)
        .where(eq(scrapeJob.status, 'running'))
        .orderBy(scrapeJob.id)
        .for('update')
      const finishedAt = new Date()
      for (const job of interrupted) {
        const items = await tx
          .select()
          .from(scrapeJobItem)
          .where(eq(scrapeJobItem.jobId, job.id))
        const completed =
          items.length > 0 && items.every((item) => item.status === 'succeeded')
        if (completed) {
          await tx
            .update(scrapeJob)
            .set({
              status: 'succeeded',
              errorMessage: null,
              finishedAt,
              updatedAt: finishedAt,
            })
            .where(
              and(eq(scrapeJob.id, job.id), eq(scrapeJob.status, 'running')),
            )
          await tx.insert(scrapeJobLog).values({
            id: nanoid(),
            jobId: job.id,
            level: 'info',
            message:
              'Worker recovered a job whose items had already succeeded.',
            metadata: { reason: 'worker_recovered_completed' },
          })
          continue
        }
        await tx
          .update(scrapeJobItem)
          .set({
            status: 'failed',
            message: interruptionReason,
            finishedAt,
            updatedAt: finishedAt,
          })
          .where(
            and(
              eq(scrapeJobItem.jobId, job.id),
              inArray(scrapeJobItem.status, ['queued', 'running']),
            ),
          )
        await tx
          .update(scrapeJob)
          .set({
            status: 'failed',
            errorMessage: interruptionReason,
            finishedAt,
            updatedAt: finishedAt,
          })
          .where(and(eq(scrapeJob.id, job.id), eq(scrapeJob.status, 'running')))
        await tx.insert(scrapeJobLog).values({
          id: nanoid(),
          jobId: job.id,
          level: 'error',
          message: interruptionReason,
          metadata: { reason: 'worker_interrupted' },
        })
      }
    })
    if (failed) throw new Error('Job worker lost ownership during startup.')
  } catch (error) {
    disableDispatch()
    release()
    throw error
  }

  async function tick(): Promise<void> {
    // Probe even while a long dispatch is in flight. A silent connection
    // failure must not leave the dispatcher running indefinitely.
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        client.query('select 1'),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => {
            reject(new Error('Job worker ownership probe timed out.'))
          }, 5000)
        }),
      ])
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog)
    }
    if (stopping || processing !== undefined) return
    processing = processQueuedJobs(() => !stopping)
      .catch(fatal)
      .finally(() => {
        processing = undefined
      })
  }

  timer = setInterval(() => {
    if (stopping || checking !== undefined) return
    checking = tick()
      .catch(fatal)
      .finally(() => {
        checking = undefined
      })
  }, pollIntervalMs)

  return {
    stop() {
      disableDispatch()
      stopPromise ??= (async () => {
        try {
          await checking
          await processing
          if (!failed) {
            const ownership = lockResultSchema.parse(
              await client.query('select pg_advisory_unlock($1) as locked', [
                workerLock,
              ]),
            )
            if (!ownership.rows[0]?.locked) {
              throw new Error('Job worker ownership lock was lost.')
            }
          }
        } catch (error) {
          fatal(error)
          throw error
        } finally {
          release()
        }
      })()
      return stopPromise
    },
  }
}
