import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { readStatus } from '../dist/state.js'

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const mockHttp = fileURLToPath(
  new URL('./fixtures/mock-http.mjs', import.meta.url),
)

function environment(t) {
  const directory = mkdtempSync(join(tmpdir(), 'local-worker-cli-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(
    join(directory, '.env'),
    [
      'LOCAL_WORKER_URL=https://app.example',
      'LOCAL_WORKER_PROVIDER=fixture',
      'LOCAL_WORKER_TOKEN=synthetic-private-token',
      'LOCAL_WORKER_ORIGIN=https://provider.example',
      'LOCAL_WORKER_PATHS=/api',
      'LOCAL_WORKER_STATE_DIR=private-state',
    ].join('\n'),
    { mode: 0o600 },
  )
  return {
    directory,
    options: {
      cwd: directory,
      env: { PATH: process.env.PATH, DOTENV_CONFIG_QUIET: 'true' },
    },
  }
}

test('CLI status loads default cwd .env, is local-only and exposes no secrets', (t) => {
  const { options } = environment(t)
  const child = spawnSync(
    process.execPath,
    ['--import', mockHttp, cli, 'status'],
    { ...options, encoding: 'utf8' },
  )
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), {
    locked: false,
    pending: 0,
    acknowledged: 0,
  })
  assert.doesNotMatch(
    child.stdout + child.stderr,
    /synthetic-private-token|mock-poll/,
  )
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(
    `CLI ${signal} notifies offline once and releases the lock`,
    { timeout: 10000 },
    async (t) => {
      const { directory, options } = environment(t)
      const child = spawn(
        process.execPath,
        ['--import', mockHttp, cli, 'start'],
        options,
      )
      const closed = once(child, 'close')
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
      })
      let stdout = ''
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (stdout.includes('mock-poll-ready') && !child.killed)
          child.kill(signal)
      })
      const [code, terminatingSignal] = await closed
      assert.equal(code, 0, stderr)
      assert.equal(terminatingSignal, null)
      assert.equal(stdout.match(/mock-offline\n/g)?.length, 1)
      assert.equal(readStatus(join(directory, 'private-state')).locked, false)
      assert.doesNotMatch(stdout + stderr, /synthetic-private-token/)
    },
  )
}

for (const signals of [
  ['SIGINT', 'SIGINT'],
  ['SIGTERM', 'SIGTERM'],
  ['SIGHUP', 'SIGHUP'],
  ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGINT'],
]) {
  test(
    `CLI cleanup survives repeated signals: ${signals.join(', ')}`,
    { timeout: 10000 },
    async (t) => {
      const { directory, options } = environment(t)
      const child = spawn(
        process.execPath,
        ['--import', mockHttp, cli, 'start'],
        {
          ...options,
          env: { ...options.env, MOCK_OFFLINE_DELAY_MS: '300' },
        },
      )
      const closed = once(child, 'close')
      const timers = []
      t.after(() => {
        for (const timer of timers) clearTimeout(timer)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
      })
      let stdout = ''
      let stderr = ''
      let stopped = false
      let repeated = false
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (stdout.includes('mock-poll-ready') && !stopped) {
          stopped = true
          child.kill(signals[0])
        }
        if (stdout.includes('mock-offline\n') && !repeated) {
          repeated = true
          for (const [index, signal] of signals.slice(1).entries()) {
            timers.push(setTimeout(() => child.kill(signal), 20 * (index + 1)))
          }
        }
      })
      const [code, terminatingSignal] = await closed
      assert.equal(terminatingSignal, null, stderr)
      assert.equal(code, 0, stderr)
      assert.equal(stdout.match(/mock-offline\n/g)?.length, 1)
      assert.equal(stdout.match(/mock-offline-acknowledged/g)?.length, 1)
      assert.equal(readStatus(join(directory, 'private-state')).locked, false)
    },
  )
}

test(
  'root pnpm worker:local completes cleanup after process-group Ctrl+C',
  { timeout: 20000 },
  async (t) => {
    const { directory, options } = environment(t)
    const state = join(directory, 'private-state')
    const child = spawn('corepack', ['pnpm', 'worker:local'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      detached: true,
      env: {
        ...options.env,
        HOME: process.env.HOME,
        NODE_OPTIONS: `--import=${mockHttp}`,
        MOCK_OFFLINE_DELAY_MS: '300',
        LOCAL_WORKER_URL: 'https://app.example',
        LOCAL_WORKER_PROVIDER: 'fixture',
        LOCAL_WORKER_TOKEN: 'synthetic-private-token',
        LOCAL_WORKER_ORIGIN: 'https://provider.example',
        LOCAL_WORKER_PATHS: '/api',
        LOCAL_WORKER_QUERY_PARAMETERS: '',
        LOCAL_WORKER_CREDENTIALS: '{}',
        LOCAL_WORKER_STATE_DIR: state,
      },
    })
    const closed = once(child, 'close')
    let finished = false
    t.after(() => {
      if (!finished && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    })
    let stdout = ''
    let stderr = ''
    let stopped = false
    let parentExitedBeforeAcknowledgement = false
    child.on('exit', () => {
      parentExitedBeforeAcknowledgement = !stdout.includes(
        'mock-offline-acknowledged',
      )
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.includes('mock-poll-ready') && !stopped) {
        stopped = true
        process.kill(-child.pid, 'SIGINT')
      }
    })
    const [code, signal] = await closed
    finished = true
    assert.ok(stopped, stdout + stderr)
    assert.equal(stdout.match(/mock-offline\n/g)?.length, 1, stdout + stderr)
    assert.equal(
      stdout.match(/mock-offline-acknowledged/g)?.length,
      1,
      stdout + stderr,
    )
    assert.equal(readStatus(state).locked, false)
    assert.equal(code, 0, stderr)
    assert.equal(signal, null)
    assert.equal(parentExitedBeforeAcknowledgement, false)
  },
)
