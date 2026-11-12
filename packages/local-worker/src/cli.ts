#!/usr/bin/env node
import 'dotenv/config'
import { resolve } from 'node:path'
import { loadConfig, WorkerError } from './config.js'
import { JournalStore, readStatus } from './state.js'
import { LocalWorker } from './worker.js'

async function main() {
  const command = process.argv[2] ?? 'start'
  if (!['start', 'status'].includes(command) || process.argv.length > 3)
    throw new WorkerError('Usage: media-local-worker [start|status]')
  if (command === 'status') {
    process.stdout.write(
      `${JSON.stringify(readStatus(resolve(process.env.LOCAL_WORKER_STATE_DIR ?? '.local-worker')))}\n`,
    )
    return
  }
  const config = loadConfig()
  const store = JournalStore.open(config.stateDir, config.binding)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
  const worker = new LocalWorker(config, store, {
    report: (event) => process.stdout.write(`${event}\n`),
  })
  try {
    process.stdout.write('Local worker running; waiting for remote tasks\n')
    await worker.run(controller.signal)
  } finally {
    if (controller.signal.aborted) await worker.offline()
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGHUP', stop)
    store.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof WorkerError ? error.message : 'Local worker stopped; inspect configuration and private state before restarting'}\n`,
  )
  process.exitCode = 1
})
