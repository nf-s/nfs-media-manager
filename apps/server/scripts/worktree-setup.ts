// `corepack pnpm worktree:setup`: makes a fresh Git worktree of this
// repository ready to work in. See docs/development.md#worktrees.
//
// The first part runs on plain Node (type stripping) before anything is
// installed, so it uses Node built-ins only: it finds the main checkout,
// links the main checkout's ignored working files (`sharedPaths`), installs dependencies from the shared pnpm store and builds the packages
// that typechecks need. It then runs this file again under tsx for the part
// that needs the project's code: the main checkout's env files are made
// visible to the workspace env loader (as links, never copies) and the local
// PostgreSQL server is checked. It never writes an env file of its own, never
// prints a setting and never starts or changes a container or database.
// Safe to run again.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs'
import { connect } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'

type Status = 'ok' | 'missing' | 'note'
type Line = { status: Status; text: string }

const afterInstallFlag = '--after-install'
const envFileNames = ['.env', '.env.local']
const builds = [
  { name: '@repo/schemas', script: 'build' },
  { name: '@repo/media-plugin-sdk', script: 'build' },
  { name: '@repo/server', script: 'build:types' },
]
/**
 * Ignored working files of the main checkout that a worktree shares through
 * a link: release and live-check scripts, private plugins, the Neon project
 * link and the preview launch settings. Data, backups, legacy inputs and
 * per-chat or per-worker state are left out.
 */
const sharedPaths = [
  '.cloudflare',
  '.local-plugins',
  '.neon',
  '.claude/launch.json',
]

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

function pnpm(cwd: string, args: string[]): boolean {
  const result = spawnSync('corepack', ['pnpm', ...args], {
    cwd,
    stdio: 'inherit',
  })
  return result.status === 0
}

function formatLine({ status, text }: Line): string {
  return `  ${status.padEnd(8)} ${text}`
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Links each shared path to the main checkout's; never replaces a file. */
function linkSharedPaths(worktree: string, mainCheckout: string): Line[] {
  const lines: Line[] = []
  const linked: string[] = []
  for (const path of sharedPaths) {
    const target = join(mainCheckout, path)
    const link = join(worktree, path)
    if (!existsSync(target)) continue
    if (exists(link)) {
      if (lstatSync(link).isSymbolicLink() && sameFile(link, target)) {
        lines.push({
          status: 'ok',
          text: `${path}: linked to the main checkout's`,
        })
        linked.push(path)
      } else {
        lines.push({
          status: 'note',
          text: `${path}: this worktree has its own, so it is not linked`,
        })
      }
      continue
    }
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link)
    lines.push({ status: 'ok', text: `${path}: linked to the main checkout's` })
    linked.push(path)
  }
  if (linked.length === 0) return lines
  const untracked = (
    git(worktree, [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      ...linked,
    ]) ?? ''
  )
    .split('\n')
    .filter((line) => line.startsWith('??'))
  for (const line of untracked)
    lines.push({
      status: 'missing',
      text: `${line.slice(3)}: Git does not ignore this link; fix .gitignore`,
    })
  return lines
}

/** Plain Node, before dependencies exist. */
function setUp(): number {
  const worktree = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  const commonDirectory = git(process.cwd(), [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  if (!worktree || !commonDirectory || basename(commonDirectory) !== '.git') {
    console.error(
      '[worktree] Run this inside a Git worktree of this repository.',
    )
    return 1
  }
  const mainCheckout = dirname(commonDirectory)
  if (sameFile(worktree, mainCheckout)) {
    console.error(
      '[worktree] Refusing: this is the main checkout. Run it in a worktree.',
    )
    return 1
  }

  const lines: Line[] = [
    { status: 'ok', text: 'Main checkout found' },
    ...linkSharedPaths(worktree, mainCheckout),
  ]

  console.info('[worktree] Installing dependencies from the shared pnpm store')
  const installed = pnpm(worktree, [
    'install',
    '--frozen-lockfile',
    '--prefer-offline',
  ])
  lines.push(
    installed
      ? { status: 'ok', text: 'Dependencies installed' }
      : { status: 'missing', text: 'Dependencies: pnpm install failed' },
  )

  let built = installed
  for (const { name, script } of builds) {
    if (!built) {
      lines.push({ status: 'missing', text: `${name} ${script}: not run` })
      continue
    }
    console.info(`[worktree] ${name} ${script}`)
    built = pnpm(worktree, ['--filter', name, script])
    lines.push(
      built
        ? { status: 'ok', text: `Built ${name} (${script})` }
        : { status: 'missing', text: `${name} ${script} failed` },
    )
  }

  const tsx = join(worktree, 'apps/server/node_modules/.bin/tsx')
  if (installed && existsSync(tsx)) {
    const check = spawnSync(
      tsx,
      [
        join(worktree, 'apps/server/scripts/worktree-setup.ts'),
        afterInstallFlag,
        mainCheckout,
      ],
      { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const reported = check.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .flatMap(([status, text]): Line[] =>
        (status === 'ok' || status === 'missing' || status === 'note') && text
          ? [{ status, text }]
          : [],
      )
    lines.push(...reported)
    if (check.status !== 0 && !reported.some((l) => l.status === 'missing'))
      lines.push({ status: 'missing', text: 'Environment check failed' })
  } else {
    lines.push({
      status: 'missing',
      text: 'Environment files and database: not checked (no install)',
    })
  }

  const missing = lines.filter((line) => line.status === 'missing').length
  console.info('\nWorktree set-up')
  for (const line of lines) console.info(formatLine(line))
  console.info(
    missing === 0
      ? 'Ready.'
      : `Not ready: ${missing} missing. Fix them and run corepack pnpm worktree:setup again.`,
  )
  return missing === 0 ? 0 : 1
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port, timeout: 3000 })
    const finish = (result: boolean) => {
      socket.destroy()
      done(result)
    }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** How to start the local database, from Docker's read-only listing. */
function startAdvice(port: number): string {
  const listing = spawnSync(
    'docker',
    ['ps', '--all', '--filter', `publish=${port}`, '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  )
  if (listing.status !== 0)
    return `Docker is not running: start Docker Desktop (open -a Docker), then the PostgreSQL container for port ${port}`
  const names = listing.stdout.trim().split('\n').filter(Boolean)
  if (names.length > 0) return `Start it with: docker start ${names.join(' ')}`
  return `Start the local PostgreSQL container for port ${port} (docker ps --all lists the containers)`
}

/** Under tsx, after the install: env files and the database server. */
async function checkEnvironment(mainCheckout: string): Promise<number> {
  const { findWorkspaceFilePath, readWorkspaceEnv } =
    await import('../src/lib/load-workspace-env')
  const { isLocalDatabaseHost, workspaceDatabaseConnection } =
    await import('./preview/preview-database')
  const worktree = resolve(process.cwd())
  const serverDirectory = join(worktree, 'apps/server')
  const lines: Line[] = []

  for (const name of envFileNames) {
    const mainFile = join(mainCheckout, name)
    const worktreeFile = join(worktree, name)
    if (!existsSync(mainFile)) {
      lines.push(
        name === '.env'
          ? {
              status: 'missing',
              text: '.env: the main checkout has none (see docs/getting-started.md)',
            }
          : { status: 'note', text: `${name}: the main checkout has none` },
      )
      continue
    }
    const found = findWorkspaceFilePath(serverDirectory, name)
    if (found && sameFile(found, mainFile)) {
      lines.push({
        status: 'ok',
        text:
          found === worktreeFile
            ? `${name}: linked to the main checkout's`
            : `${name}: the env loader finds the main checkout's`,
      })
      continue
    }
    if (found === worktreeFile) {
      lines.push({
        status: 'missing',
        text: `${name}: this worktree has its own, which replaces the main checkout's. Remove it unless that is intended`,
      })
      continue
    }
    if (found) {
      lines.push({
        status: 'missing',
        text: `${name}: one in a folder above this worktree is used instead of the main checkout's`,
      })
      continue
    }
    if (exists(worktreeFile)) {
      lines.push({
        status: 'missing',
        text: `${name}: a broken link in this worktree; remove it and run again`,
      })
      continue
    }
    symlinkSync(mainFile, worktreeFile)
    lines.push({ status: 'ok', text: `${name}: linked to the main checkout's` })
  }

  const database = workspaceDatabaseConnection(
    readWorkspaceEnv(serverDirectory),
  )
  if (!isLocalDatabaseHost(database.host)) {
    lines.push({
      status: 'note',
      text: 'Database: the settings name a server that is not local; not checked',
    })
  } else if (await reachable(database.host, database.port)) {
    lines.push({
      status: 'ok',
      text: `Database: the local PostgreSQL on port ${database.port} answers`,
    })
  } else {
    lines.push({
      status: 'missing',
      text: `Database: nothing answers on ${database.host}:${database.port}. ${startAdvice(database.port)}`,
    })
  }

  for (const { status, text } of lines) console.info(`${status}\t${text}`)
  return lines.some((line) => line.status === 'missing') ? 1 : 0
}

const afterInstall = process.argv.indexOf(afterInstallFlag)
const mainCheckout = process.argv[afterInstall + 1]
if (afterInstall === -1) {
  process.exitCode = setUp()
} else if (mainCheckout) {
  void checkEnvironment(mainCheckout).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    },
  )
} else {
  console.error(`[worktree] ${afterInstallFlag} needs the main checkout`)
  process.exitCode = 1
}
