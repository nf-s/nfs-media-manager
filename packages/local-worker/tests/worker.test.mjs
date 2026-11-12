import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { LOCAL_RESPONSE_BYTES } from '@repo/media-plugin-sdk/local-worker'
import { loadConfig, trustedOrigin } from '../dist/config.js'
import { DispatchExpiredError, isPublicAddress } from '../dist/http.js'
import { JournalStore, readStatus } from '../dist/state.js'
import { LocalWorker } from '../dist/worker.js'

const id = '00000000-0000-4000-8000-000000000001'
const serverTime = 2_000_000_000_000
const task = {
  id,
  url: 'https://provider.example/api?id=1',
  dispatchBefore: serverTime + 5000,
  expiresAt: serverTime + 30000,
}
const permit = {
  serverTime,
  dispatchBefore: task.dispatchBefore,
  expiresAt: task.expiresAt,
}
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status })

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'local-worker-test-'))
  const config = loadConfig({
    LOCAL_WORKER_URL: 'https://app.example',
    LOCAL_WORKER_PROVIDER: 'fixture',
    LOCAL_WORKER_TOKEN: 'cloud-private-token',
    LOCAL_WORKER_ORIGIN: 'https://provider.example',
    LOCAL_WORKER_PATHS: '/api',
    LOCAL_WORKER_QUERY_PARAMETERS: 'id',
    LOCAL_WORKER_CREDENTIALS: '{"X-Api-Key":"FIXTURE_SECRET"}',
    FIXTURE_SECRET: 'provider-private-key',
    LOCAL_WORKER_STATE_DIR: directory,
    ...overrides,
  })
  const store = JournalStore.open(directory, config.binding)
  t.after(() => {
    try {
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  const controller = new AbortController()
  const calls = []
  const uploads = []
  const sleeps = []
  const events = []
  const time = { wall: 1_000_000_000_000, monotonic: 10_000 }
  let polls = 0
  const harness = {
    config,
    store,
    directory,
    controller,
    calls,
    uploads,
    sleeps,
    events,
    time,
    poll: () => json({ serverTime, policy: config.policy, task }),
    start: () => json(permit),
    provider: () => new Response('{"ok":true}'),
    result: () => json({ accepted: true }),
    tick(ms) {
      time.wall += ms
      time.monotonic += ms
    },
    async run(options = {}) {
      const transport = async (url, init) => {
        calls.push({ url, ...init })
        if (url.startsWith(config.policy.origin))
          return harness.provider(url, init)
        assert.equal(init.headers.authorization, `Bearer ${config.token}`)
        assert.equal(init.headers['x-api-key'], undefined)
        assert.equal(init.method, 'POST')
        if (url.endsWith('/poll')) {
          if (++polls > 1 && !options.keepPolling) {
            controller.abort()
            throw new Error('Stopped')
          }
          return harness.poll(url, init)
        }
        if (url.endsWith('/start')) {
          const journal = JSON.parse(
            readFileSync(join(directory, 'journal.json'), 'utf8'),
          )
          assert.equal(
            journal.entries.find((entry) => entry.id === id).state,
            'claimed',
          )
          return harness.start(url, init)
        }
        if (url.endsWith('/result')) {
          uploads.push(JSON.parse(init.body))
          return harness.result(url, init)
        }
        assert.fail(`Unexpected mocked URL: ${url}`)
      }
      await new LocalWorker(config, store, {
        transport,
        clock: () => ({ ...time }),
        sleep: async (ms) => {
          sleeps.push(ms)
          harness.tick(ms)
          if (sleeps.length > 10) throw new Error('Unexpected retry loop')
        },
        report: (event) => events.push(event),
        ...options.runtime,
      }).run(controller.signal)
    },
  }
  return harness
}

test('only explicit tasks fetch, credentials stay local, response headers and body are redacted', async (t) => {
  const h = fixture(t)
  h.provider = (_url, init) => {
    assert.equal(init.method, 'GET')
    assert.deepEqual(init.headers, { 'x-api-key': 'provider-private-key' })
    return new Response('provider-private-key cloud-private-token', {
      headers: {
        'set-cookie': 'secret-cookie',
        location: 'https://other.example',
        'content-type': 'provider-private-key',
        'retry-after': '60',
        'x-untrusted': 'secret',
      },
    })
  }
  await h.run()
  assert.deepEqual(h.uploads[0].headers, {
    'content-type': '[redacted]',
    'retry-after': '60',
  })
  assert.equal(h.uploads[0].body, '[redacted] [redacted]')
  assert.equal(h.calls.filter(({ method }) => method === 'GET').length, 1)
  assert.equal(readStatus(h.directory).acknowledged, 1)
  assert.doesNotMatch(
    readFileSync(join(h.directory, 'journal.json'), 'utf8'),
    /private-token|private-key|https:/,
  )
})

test('offline reconnect is bounded and successful empty polls reset its backoff', async (t) => {
  const h = fixture(t)
  let count = 0
  h.poll = () => {
    count++
    if (count <= 7) throw new Error('Offline')
    if (count === 8)
      return json({ serverTime, policy: h.config.policy, task: null })
    if (count === 9) throw new Error('Offline again')
    h.controller.abort()
    throw new Error('Finished')
  }
  await h.run({ keepPolling: true })
  assert.deepEqual(
    h.sleeps,
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 250, 1000],
  )
  assert.equal(
    h.calls.some(({ method }) => method === 'GET'),
    false,
  )
})

test('repeated empty long polls keep a fixed short idle delay within the heartbeat window', async (t) => {
  const h = fixture(t)
  const pollTimes = []
  h.poll = () => {
    pollTimes.push(h.time.monotonic)
    if (pollTimes.length > 8) {
      h.controller.abort()
      throw new Error('Finished')
    }
    h.tick(20_000)
    return json({ serverTime, policy: h.config.policy, task: null })
  }
  await h.run({ keepPolling: true })
  assert.deepEqual(h.sleeps, Array(8).fill(250))
  assert.ok(h.sleeps.every((milliseconds) => milliseconds < 4000))
  for (let index = 1; index < pollTimes.length; index++) {
    const interval = pollTimes[index] - pollTimes[index - 1]
    assert.equal(interval, 20_250)
    assert.ok(interval < 35_000)
  }
  assert.equal(
    h.calls.every(({ url }) => url.endsWith('/poll')),
    true,
  )
})

test('full start RTT, not long poll time or local clock skew, determines dispatch', async (t) => {
  const h = fixture(t)
  h.poll = () => {
    h.tick(20_000)
    return json({ serverTime, policy: h.config.policy, task })
  }
  h.start = () => {
    h.tick(100)
    return json(permit)
  }
  await h.run()
  assert.equal(h.uploads[0].kind, 'response')
})

for (const mode of ['expired', 'margin', 'sleep', 'backwards', 'expires']) {
  test(`deadline fails closed: ${mode}`, async (t) => {
    const h = fixture(t)
    h.start = () => {
      if (mode === 'expired') h.tick(5100)
      if (mode === 'margin') h.tick(4500)
      if (mode === 'sleep') h.time.wall += 60_000
      if (mode === 'backwards') h.time.wall -= 60_000
      return json(
        mode === 'expires'
          ? { ...permit, expiresAt: serverTime + 400 }
          : permit,
      )
    }
    await h.run()
    assert.equal(h.uploads[0].error, 'expired')
    assert.equal(
      h.calls.some(({ method }) => method === 'GET'),
      false,
    )
  })
}

test('deadline rechecked immediately before provider dispatch', async (t) => {
  const h = fixture(t)
  let reads = 0
  await h.run({
    runtime: {
      clock: () => {
        if (++reads === 4) h.tick(10000)
        return { ...h.time }
      },
    },
  })
  assert.equal(h.uploads[0].error, 'expired')
  assert.equal(
    h.calls.some(({ method }) => method === 'GET'),
    false,
  )
})

for (const failure of ['lost', 'expired', 'malformed']) {
  test(`start ${failure} never retries start or fetch`, async (t) => {
    const h = fixture(t)
    h.start = () => {
      if (failure === 'lost') throw new Error('Offline after start accepted')
      return failure === 'expired' ? json({}, 409) : json({ unexpected: true })
    }
    await h.run()
    assert.equal(
      h.uploads[0].error,
      failure === 'expired' ? 'expired' : 'interrupted',
    )
    assert.equal(h.calls.filter(({ url }) => url.endsWith('/start')).length, 1)
    assert.equal(
      h.calls.some(({ method }) => method === 'GET'),
      false,
    )
  })
}

test('offline mid-fetch persists an error and retries result upload only', async (t) => {
  const h = fixture(t)
  h.provider = () => {
    throw new Error('Offline provider-private-key')
  }
  let attempts = 0
  h.result = () => {
    assert.equal(
      JSON.parse(readFileSync(join(h.directory, 'journal.json'), 'utf8'))
        .entries[0].result.error,
      'network',
    )
    if (++attempts < 3) throw new Error('Offline')
    return json({ accepted: true })
  }
  await h.run()
  assert.equal(h.uploads.length, 3)
  assert.equal(h.calls.filter(({ method }) => method === 'GET').length, 1)
  assert.equal(
    h.events.some((event) => event.includes('provider-private-key')),
    false,
  )
})

for (const status of [401, 403]) {
  for (const phase of ['poll', 'start', 'result']) {
    test(`${phase} ${status} stops without retry`, async (t) => {
      const h = fixture(t)
      h[phase] = () => json({}, status)
      await assert.rejects(h.run(), /authorization rejected/)
      assert.equal(
        h.calls.filter(({ url }) => url.endsWith(`/${phase}`)).length,
        1,
      )
      assert.equal(h.sleeps.length, 0)
      if (phase !== 'poll') assert.equal(readStatus(h.directory).pending, 1)
    })
  }
}

test('result 409 stops, preserves the result, and does not poll again', async (t) => {
  const h = fixture(t)
  h.result = () => json({}, 409)
  await assert.rejects(h.run(), /retained for review/)
  assert.equal(h.store.readResult(id).kind, 'response')
  assert.equal(h.calls.filter(({ url }) => url.endsWith('/poll')).length, 1)
})

for (const status of [401, 403, 429]) {
  for (const failure of ['large', 'broken']) {
    test(`provider ${status} ${failure} body retains safety headers`, async (t) => {
      const h = fixture(t)
      h.provider = () =>
        new Response(
          failure === 'large'
            ? 'x'.repeat(LOCAL_RESPONSE_BYTES + 1)
            : new ReadableStream({
                start(controller) {
                  controller.error(new Error('Offline'))
                },
              }),
          {
            status,
            headers: {
              'retry-after': '120',
              'x-ratelimit-remaining': '0',
              'set-cookie': 'no',
            },
          },
        )
      await h.run()
      assert.equal(h.uploads[0].status, status)
      assert.equal(h.uploads[0].body, '')
      assert.equal(h.uploads[0].headers['retry-after'], '120')
      assert.equal(h.uploads[0].headers['x-ratelimit-remaining'], '0')
      assert.equal(h.uploads[0].headers['set-cookie'], undefined)
      assert.equal(h.calls.filter(({ method }) => method === 'GET').length, 1)
    })
  }
}

test('redirect response is returned without forwarding credentials or following location', async (t) => {
  const h = fixture(t)
  h.provider = () =>
    new Response('', {
      status: 302,
      headers: { location: 'https://attacker.example', 'set-cookie': 'secret' },
    })
  await h.run()
  assert.equal(h.uploads[0].status, 302)
  assert.deepEqual(h.uploads[0].headers, {
    'content-type': 'text/plain;charset=UTF-8',
  })
  assert.equal(h.calls.filter(({ method }) => method === 'GET').length, 1)
})

for (const url of [
  'https://other.example/api',
  'http://provider.example/api',
  'https://provider.example/other',
  'https://provider.example/api?id=1&id=2',
  'https://provider.example/api?unknown=1',
  'https://user:pass@provider.example/api',
  'https://provider.example/api#fragment',
]) {
  test(`rejects task outside local scope: ${url}`, async (t) => {
    const h = fixture(t)
    h.poll = () =>
      json({ serverTime, policy: h.config.policy, task: { ...task, url } })
    await h.run()
    assert.equal(h.uploads[0].error, 'policy')
    assert.equal(
      h.calls.some(({ url }) => url.endsWith('/start')),
      false,
    )
    assert.equal(
      h.calls.some(({ method }) => method === 'GET'),
      false,
    )
  })
}

for (const policy of [
  { origin: 'https://other.example' },
  { paths: ['/api', '/other'] },
  { queryParameters: ['id', 'unknown'] },
  { credentialHeaders: [] },
  { credentialHeaders: ['x-api-key', 'authorization'] },
  { credentialHeaders: ['X-Api-Key', 'x-api-key'] },
]) {
  test(`rejects policy outside local scope: ${JSON.stringify(policy)}`, async (t) => {
    const h = fixture(t)
    h.poll = () =>
      json({ serverTime, policy: { ...h.config.policy, ...policy }, task })
    await h.run()
    assert.equal(h.uploads[0].error, 'policy')
    assert.equal(
      h.calls.some(({ method }) => method === 'GET'),
      false,
    )
  })
}

test('success response has a 2 MiB byte bound, not character bound', async (t) => {
  const h = fixture(t)
  h.provider = () => new Response('é'.repeat(LOCAL_RESPONSE_BYTES / 2 + 1))
  await h.run()
  assert.equal(h.uploads[0].error, 'response-too-large')
})

test('stalled response streams time out within permit expiry', async (t) => {
  const h = fixture(t)
  h.start = () => json({ ...permit, expiresAt: serverTime + 525 })
  h.provider = () => new Response(new ReadableStream({ pull() {} }))
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const began = performance.now()
  await h.run()
  assert.equal(h.uploads[0].error, 'timeout')
  assert.ok(performance.now() - began < 1000)
})

test('uncertain claimed task on restart uploads interrupted without start or fetch', async (t) => {
  const h = fixture(t)
  h.store.claim(id)
  h.poll = () => {
    h.controller.abort()
    throw new Error('Stop')
  }
  await h.run()
  assert.equal(h.uploads[0].error, 'interrupted')
  assert.equal(
    h.calls.some(({ url }) => url.endsWith('/start')),
    false,
  )
  assert.equal(
    h.calls.some(({ method }) => method === 'GET'),
    false,
  )
})

test('pending result replays after restart; missing body becomes interrupted', async (t) => {
  const h = fixture(t)
  h.store.claim(id)
  h.store.record({
    kind: 'response',
    id,
    status: 200,
    headers: {},
    body: 'private response',
  })
  assert.equal(statSync(join(h.directory, `${id}.body`)).mode & 0o777, 0o600)
  assert.doesNotMatch(
    readFileSync(join(h.directory, 'journal.json'), 'utf8'),
    /private response/,
  )
  unlinkSync(join(h.directory, `${id}.body`))
  h.poll = () => {
    h.controller.abort()
    throw new Error('Stop')
  }
  await h.run()
  assert.equal(h.uploads[0].error, 'interrupted')
  assert.equal(
    h.calls.some(({ method }) => method === 'GET'),
    false,
  )
})

test('acknowledged task IDs remain tombstones and duplicate offers never refetch', async (t) => {
  const h = fixture(t)
  h.store.claim(id)
  h.store.record({ kind: 'error', id, error: 'network' })
  h.store.acknowledge(id)
  await h.run()
  assert.equal(h.uploads[0].error, 'interrupted')
  assert.equal(
    h.calls.some(({ method }) => method === 'GET'),
    false,
  )
})

test('private journal and cross-process exclusive lock', (t) => {
  const h = fixture(t)
  assert.equal(statSync(h.directory).mode & 0o777, 0o700)
  assert.equal(statSync(join(h.directory, 'journal.json')).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(h.directory, '.gitignore'), 'utf8'), '*\n')
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { JournalStore } from ${JSON.stringify(new URL('../dist/state.js', import.meta.url).href)}; try { JournalStore.open(process.argv[1],process.argv[2]); process.exit(2) } catch { process.exit(0) }`,
      h.directory,
      h.config.binding,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(child.status, 0, child.stderr)
  assert.equal(readStatus(h.directory).pid, process.pid)
})

test('DNS destination filtering rejects private, loopback, link-local, mapped and special addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])
    assert.equal(isPublicAddress(address), false, address)
  for (const address of ['93.184.216.34', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(address), true, address)
  for (const origin of [
    'http://provider.example',
    'https://127.0.0.1',
    'https://[::1]',
    'https://service.local',
    'https://localhost',
    'https://provider.example/',
    'https://provider.example/path',
  ])
    assert.throws(() => trustedOrigin(origin))
})

test('configuration validates mappings without exposing secret values', () => {
  assert.throws(
    () => loadConfig({ LOCAL_WORKER_TOKEN: 'never-print-this' }),
    (error) => !error.message.includes('never-print-this'),
  )
})

test('actual process crash retains lock and claim; reviewed restart reports interrupted', async (t) => {
  const h = fixture(t)
  h.store.close()
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { JournalStore } from ${JSON.stringify(new URL('../dist/state.js', import.meta.url).href)}; const store = JournalStore.open(process.argv[1],process.argv[2]); store.claim(process.argv[3]); process.exit(0)`,
      h.directory,
      h.config.binding,
      id,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(child.status, 0, child.stderr)
  assert.throws(
    () => JournalStore.open(h.directory, h.config.binding),
    /locked/,
  )
  // The child is confirmed exited; simulate the documented manual lock review.
  rmSync(join(h.directory, 'lock'), { recursive: true })
  const restarted = JournalStore.open(h.directory, h.config.binding)
  h.store = restarted
  const uploads = []
  await new LocalWorker(h.config, restarted, {
    transport: async (url, init) => {
      if (url.endsWith('/result')) {
        uploads.push(JSON.parse(init.body))
        return json({ accepted: true })
      }
      assert.ok(url.endsWith('/poll'))
      h.controller.abort()
      throw new Error('Stopped')
    },
  }).run(h.controller.signal)
  assert.equal(uploads[0].error, 'interrupted')
})

test('completed result survives reopening the journal and uploads without a provider request', async (t) => {
  const h = fixture(t)
  h.store.claim(id)
  h.store.record({
    kind: 'response',
    id,
    status: 429,
    headers: { 'retry-after': '60' },
    body: 'quota',
  })
  h.store.close()
  const reopened = JournalStore.open(h.directory, h.config.binding)
  h.store = reopened
  const uploads = []
  await new LocalWorker(h.config, reopened, {
    transport: async (url, init) => {
      if (url.endsWith('/result')) {
        uploads.push(JSON.parse(init.body))
        return json({ accepted: true })
      }
      assert.ok(url.endsWith('/poll'))
      h.controller.abort()
      throw new Error('Stopped')
    },
  }).run(h.controller.signal)
  assert.equal(uploads[0].status, 429)
  assert.equal(uploads[0].headers['retry-after'], '60')
  assert.equal(uploads[0].body, 'quota')
})

test('shutdown during provider I/O persists interrupted and does not retry', async (t) => {
  const h = fixture(t)
  h.provider = () => {
    h.controller.abort()
    return Promise.reject(new Error('Aborted'))
  }
  await h.run()
  assert.equal(h.store.readResult(id).error, 'interrupted')
  assert.equal(h.store.pending().length, 1)
  assert.equal(h.uploads.length, 0)
  assert.equal(h.calls.filter(({ method }) => method === 'GET').length, 1)
})

test('transport dispatch callback expires during delayed DNS or laptop sleep', async (t) => {
  const h = fixture(t)
  h.provider = (_url, options) => {
    assert.equal(options.canDispatch(), true)
    h.time.wall += 60_000
    assert.equal(options.canDispatch(), false)
    throw new DispatchExpiredError('Dispatch deadline elapsed')
  }
  await h.run()
  assert.equal(h.uploads[0].error, 'expired')
})

test('offline notification ignores the stopped run signal and never retries errors', async (t) => {
  const h = fixture(t)
  h.controller.abort()
  let calls = 0
  const worker = new LocalWorker(h.config, h.store, {
    transport: async (url, options) => {
      calls++
      assert.ok(url.endsWith('/offline'))
      assert.equal(options.signal.aborted, false)
      assert.equal(options.method, 'POST')
      assert.equal(options.body, '{}')
      assert.equal(options.headers.authorization, `Bearer ${h.config.token}`)
      throw new Error('Offline')
    },
  })
  await worker.offline()
  assert.equal(calls, 1)
})
