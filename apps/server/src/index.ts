import { serve } from '@hono/node-server'
import app from '@/app'
import { env } from '@/env'
import { db } from '@/lib/db'
import { startJobWorker } from '@/services/job-worker'

function fatal(error: unknown): never {
  console.error('Server stopped because job worker ownership is unsafe.', error)
  process.exit(1)
}

async function main(): Promise<void> {
  // Install signal handlers before startup so a shutdown during recovery also
  // waits for ownership initialization and closes its dedicated connection.
  const worker = startJobWorker({ onFatal: fatal })
  let server: ReturnType<typeof serve> | undefined = undefined
  let shutdownPromise: Promise<void> | undefined

  function shutdown(): void {
    shutdownPromise ??= (async () => {
      const activeWorker = await worker
      const drained = activeWorker.stop()
      const closed = new Promise<void>((resolve, reject) => {
        if (!server) return resolve()
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await Promise.all([drained, closed])
      await db.$client.end()
    })().catch(fatal)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  await worker
  if (shutdownPromise !== undefined) return
  server = serve(
    {
      fetch: app.fetch,
      port: env.PORT,
    },
    () => {
      console.info(`Server is running on http://localhost:${env.PORT}`)
    },
  )
  server.on('error', fatal)
}

void main().catch(fatal)
