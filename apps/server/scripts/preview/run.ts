// `corepack pnpm preview`: the app for interface checks on a disposable
// database with the synthetic preview library. It creates a new database on
// the local PostgreSQL server, writes its own settings file outside the
// checkout, migrates and seeds, starts the API without the job worker and the
// web app on their own ports, and on exit stops both, drops the database and
// deletes the settings. The local `.env` and `.env.local` are read only for
// the PostgreSQL connection and are never changed.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { z } from 'zod'
import { readWorkspaceEnv, workspaceEnvFileKey } from '@/lib/load-workspace-env'
import {
  isLocalDatabaseHost,
  previewDatabasePattern,
  previewDatabasePrefix,
  workspaceDatabaseConnection,
} from './preview-database'
import { defaultPreviewPorts } from './preview-ports'

const serverDirectory = process.cwd()
const webDirectory = resolve(serverDirectory, '../web')
if (!existsSync(join(serverDirectory, 'scripts/preview/run.ts')))
  throw new Error('Run the preview from apps/server: corepack pnpm preview')

const tsx = join(serverDirectory, 'node_modules/.bin/tsx')
const PortSchema = z.coerce.number().int().min(1024).max(65535)

type Connection = {
  host: string
  port: number
  user: string
  password: string
}
type Running = { name: string; child: ChildProcess; log: string }

const children: Running[] = []
let database: string | undefined
let connection: Connection | undefined
let directory: string | undefined
let stopping: Promise<void> | undefined

function say(message: string): void {
  console.info(`[preview] ${message}`)
}

function readPorts() {
  const defaults = defaultPreviewPorts(resolve(serverDirectory, '../..'))
  const { values } = parseArgs({
    options: {
      'web-port': { type: 'string' },
      'api-port': { type: 'string' },
    },
  })
  return {
    web: PortSchema.parse(
      values['web-port'] ?? process.env.PREVIEW_WEB_PORT ?? defaults.web,
    ),
    api: PortSchema.parse(
      values['api-port'] ?? process.env.PREVIEW_API_PORT ?? defaults.api,
    ),
  }
}

/** The local PostgreSQL server from the workspace settings; nothing else. */
function localConnection(local: Record<string, string>): Connection {
  const result = workspaceDatabaseConnection(local)
  if (!isLocalDatabaseHost(result.host))
    throw new Error('Refusing: the preview runs only on a local PostgreSQL')
  return result
}

function assertPortFree(port: number): Promise<void> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', () =>
      reject(
        new Error(
          `Port ${port} is in use. Choose others with --web-port and --api-port.`,
        ),
      ),
    )
    probe.listen(port, () => probe.close(() => resolvePort()))
  })
}

async function withAdmin<T>(
  target: Connection,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ ...target, database: 'postgres' })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

/** Drops databases left by an earlier preview that was killed; never one in use. */
async function removeLeftoverDatabases(target: Connection): Promise<void> {
  const NamesSchema = z.array(z.object({ datname: z.string() }))
  await withAdmin(target, async (client) => {
    const names = NamesSchema.parse(
      (
        await client.query(
          `select datname from pg_database d
           where starts_with(datname, $1)
             and not exists (
               select 1 from pg_stat_activity a where a.datname = d.datname
             )`,
          [previewDatabasePrefix],
        )
      ).rows,
    )
    for (const { datname } of names) {
      if (!previewDatabasePattern.test(datname)) continue
      await client
        .query(`drop database if exists "${datname}"`)
        .then(() => say(`Removed leftover database ${datname}`))
        .catch(() => undefined)
    }
  })
}

function previewSettings(
  target: Connection,
  name: string,
  ports: { web: number; api: number },
): string {
  const web = `http://127.0.0.1:${ports.web}`
  const api = `http://127.0.0.1:${ports.api}`
  const secret = () => randomBytes(32).toString('hex')
  const values: Record<string, string> = {
    APP_URL: web,
    WEB_PORT: String(ports.web),
    INTERNAL_FRONTEND_URL: web,
    AUTH_BASE_URL: api,
    INTERNAL_BACKEND_URL: api,
    PORT: String(ports.api),
    TRUSTED_ORIGINS: `${web},${api}`,
    DEV_USE_INTERNAL_BACKEND_URL_IN_FRONTEND: 'false',
    DATABASE_HOST: target.host,
    DATABASE_PORT: String(target.port),
    DATABASE_USER: target.user,
    DATABASE_PASSWORD: target.password,
    DATABASE_NAME: name,
    DATABASE_SSL: 'disable',
    BETTER_AUTH_SECRET: secret(),
    MEDIA_ENCRYPTION_KEY: secret(),
    INITIAL_USER_EMAIL: 'preview@example.invalid',
    INITIAL_USER_NAME: 'Preview',
    INITIAL_USER_PASSWORD: secret(),
    MEDIA_PLUGIN_PATHS: '',
    SCRAPING_ENABLED: 'false',
  }
  return Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n')
}

/**
 * The environment for preview processes: the shell's, without any key the
 * workspace files set, so only the preview settings file supplies them.
 */
function childEnvironment(
  local: Record<string, string>,
  settingsFile: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    ...Object.keys(local),
    'DATABASE_URL',
    'DATABASE_SCHEMA',
    'OWNER_EMAIL',
    'OWNER_USER_ID',
  ])
    delete result[key]
  result[workspaceEnvFileKey] = settingsFile
  result.PATH = [
    join(serverDirectory, 'node_modules/.bin'),
    join(webDirectory, 'node_modules/.bin'),
    process.env.PATH ?? '',
  ].join(delimiter)
  return result
}

function launch(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Running {
  if (!directory) throw new Error('Preview directory missing')
  const log = join(directory, `${name}.log`)
  const output = createWriteStream(log)
  // Its own process group, so stopping it also stops what it started.
  const child = spawn(command, args, {
    cwd,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(output)
  child.stderr?.pipe(output)
  const running = { name, child, log }
  children.push(running)
  return running
}

function tail(running: Running, lines = 40): string {
  try {
    return readFileSync(running.log, 'utf8')
      .split('\n')
      .slice(-lines)
      .join('\n')
  } catch {
    return ''
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode)
  return new Promise((done) => child.once('exit', (code) => done(code)))
}

async function step(
  name: string,
  script: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const started = Date.now()
  const running = launch(name, tsx, [script], serverDirectory, environment)
  const code = await exited(running.child)
  children.splice(children.indexOf(running), 1)
  if (code !== 0) {
    console.error(tail(running))
    throw new Error(`Preview step "${name}" failed`)
  }
  say(`${name} done in ${Math.round((Date.now() - started) / 1000)} s`)
}

async function waitFor(url: string, running: Running, seconds: number) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) break
    const ok = await fetch(url, { redirect: 'manual' })
      .then((response) => response.status < 500)
      .catch(() => false)
    if (ok) return
    await new Promise((done) => setTimeout(done, 500))
  }
  console.error(tail(running))
  throw new Error(`${running.name} did not start`)
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // Already stopped.
  }
}

function stop(code: number): Promise<void> {
  stopping ??= (async () => {
    say('Stopping...')
    for (const { child } of children) signalGroup(child, 'SIGTERM')
    await Promise.race([
      Promise.all(children.map(({ child }) => exited(child))),
      new Promise((done) => setTimeout(done, 10_000)),
    ])
    for (const { child } of children) signalGroup(child, 'SIGKILL')
    if (database && connection) {
      const name = database
      await withAdmin(connection, (client) =>
        client.query(`drop database if exists "${name}" with (force)`),
      )
        .then(() => say(`Dropped database ${name}`))
        .catch((error: unknown) =>
          console.error(`[preview] Could not drop database ${name}`, error),
        )
    }
    if (directory) rmSync(directory, { recursive: true, force: true })
  })().finally(() => process.exit(code))
  return stopping
}

async function main(): Promise<void> {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => void stop(0))

  const ports = readPorts()
  const local = readWorkspaceEnv(serverDirectory)
  const target = localConnection(local)
  await assertPortFree(ports.web)
  await assertPortFree(ports.api)

  connection = target
  directory = mkdtempSync(join(tmpdir(), 'media-preview-'))
  const name = `${previewDatabasePrefix}${randomBytes(4).toString('hex')}`
  const settingsFile = join(directory, 'preview.env')
  writeFileSync(settingsFile, previewSettings(target, name, ports), {
    mode: 0o600,
  })
  const environment = childEnvironment(local, settingsFile)

  await removeLeftoverDatabases(target)
  await withAdmin(target, (client) => client.query(`create database "${name}"`))
  database = name
  say(`Created database ${name}`)

  await step('check', 'scripts/preview/check.ts', environment)
  await step('migrate', 'scripts/migrate.ts', environment)
  await step('account', 'scripts/seed.ts', environment)
  await step('seed', 'scripts/preview/seed.ts', environment)

  const api = launch(
    'api',
    tsx,
    ['scripts/preview/server.ts'],
    serverDirectory,
    environment,
  )
  await waitFor(`http://127.0.0.1:${ports.api}/api/v1/healthcheck`, api, 60)
  const web = launch(
    'web',
    process.execPath,
    ['scripts/dev.mjs'],
    webDirectory,
    environment,
  )
  await waitFor(`http://127.0.0.1:${ports.web}/login`, web, 240)

  for (const running of [api, web])
    void exited(running.child).then(() => {
      if (stopping) return
      console.error(tail(running))
      console.error(`[preview] ${running.name} stopped unexpectedly`)
      void stop(1)
    })

  say('Ready')
  say(`App:     http://127.0.0.1:${ports.web}`)
  say(
    `Sign in: http://127.0.0.1:${ports.api}/preview/sign-in?next=/tracks (signs in the preview account)`,
  )
  say(`Logs:    ${directory}`)
  say('Press Ctrl+C to stop. The database and settings are removed on exit.')
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  void stop(1)
})
