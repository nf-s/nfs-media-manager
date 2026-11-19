import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isLocalWorkerUrlAllowed,
  LocalWorkerPolicySchema,
  LocalWorkerPollSchema,
  LocalWorkerResultSchema,
} from '../dist/local-worker.js'
import {
  MediaPluginManifestSchema,
  isMediaProviderPlugin,
} from '../dist/index.js'

for (const origin of ['', 'not a URL', 'https://[', 'https://']) {
  test(`malformed origin returns validation failure: ${JSON.stringify(origin)}`, () => {
    const policy = { origin, paths: ['/api'], credentialHeaders: [] }
    const manifest = {
      id: 'fixture',
      displayName: 'Fixture',
      description: '',
      mediaTypes: ['album'],
      secrets: [],
      rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
      localWorker: policy,
    }
    assert.equal(LocalWorkerPolicySchema.safeParse(policy).success, false)
    assert.equal(
      LocalWorkerPollSchema.safeParse({ serverTime: 1, policy, task: null })
        .success,
      false,
    )
    assert.equal(MediaPluginManifestSchema.safeParse(manifest).success, false)
    assert.equal(isMediaProviderPlugin({ manifest }), false)
  })
}

test('origin remains restricted to an exact HTTPS origin', () => {
  for (const origin of [
    'http://example.com',
    'https://example.com/',
    'https://example.com/api',
    'https://user:secret@example.com',
    'https://example.com#fragment',
  ]) {
    assert.equal(
      LocalWorkerPolicySchema.safeParse({
        origin,
        paths: ['/api'],
        credentialHeaders: [],
      }).success,
      false,
    )
  }
  assert.equal(
    LocalWorkerPolicySchema.safeParse({
      origin: 'https://example.com',
      paths: ['/api'],
      credentialHeaders: [],
    }).success,
    true,
  )
})

test('local-only execution requires a worker policy and cannot declare a switchable mode', () => {
  const manifest = {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['album'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
    localWorkerRequired: true,
  }
  const localWorker = {
    origin: 'https://metadata.fixture.invalid',
    paths: ['/api'],
    credentialHeaders: [],
  }
  assert.equal(MediaPluginManifestSchema.safeParse(manifest).success, false)
  assert.equal(
    MediaPluginManifestSchema.parse({ ...manifest, localWorker })
      .localWorkerRequired,
    true,
  )
  assert.equal(
    MediaPluginManifestSchema.safeParse({
      ...manifest,
      localWorker,
      localWorkerDefaultMode: 'cloud',
    }).success,
    false,
  )
})

test('numeric metadata paths permit only positive identifiers and carry no query', () => {
  const policy = LocalWorkerPolicySchema.parse({
    origin: 'https://metadata.fixture.invalid',
    paths: ['/database/search', '/masters/{id}', '/releases/{id}'],
    queryParameters: ['artist', 'release_title', 'page'],
    credentialHeaders: ['authorization', 'user-agent'],
  })
  const allowed = (path) =>
    isLocalWorkerUrlAllowed(policy.origin + path, policy)
  assert.equal(
    allowed('/database/search?artist=Fixture&release_title=Test&page=1'),
    true,
  )
  assert.equal(allowed('/masters/42'), true)
  assert.equal(allowed('/releases/9007199254740991'), true)
  for (const path of [
    '/database/search?artist=Fixture&artist=Duplicate',
    '/database/search?token=fixture',
    '/masters/0',
    '/masters/0042',
    '/masters/9007199254740992',
    '/masters/%34%32',
    '/masters/42/versions',
    '/masters/42?page=1',
    '/releases/42#fragment',
    '/artists/42',
  ]) {
    assert.equal(allowed(path), false, path)
  }
  assert.equal(
    isLocalWorkerUrlAllowed('https://other.fixture.invalid/masters/42', policy),
    false,
  )
})

test('local worker results allow Discogs quota headers without arbitrary headers', () => {
  const result = {
    kind: 'response',
    id: '00000000-0000-4000-8000-000000000001',
    status: 429,
    body: '',
    headers: {
      'x-discogs-ratelimit': '60',
      'x-discogs-ratelimit-used': '60',
      'x-discogs-ratelimit-remaining': '0',
    },
  }
  assert.equal(LocalWorkerResultSchema.safeParse(result).success, true)
  assert.equal(
    LocalWorkerResultSchema.safeParse({
      ...result,
      headers: { ...result.headers, authorization: 'fixture' },
    }).success,
    false,
  )
})

test('the native capture and projected response share the existing relay byte budget', () => {
  const limit = 2 * 1024 * 1024
  const response = {
    kind: 'response',
    id: '00000000-0000-4000-8000-000000000001',
    status: 200,
    headers: {},
    body: 'x'.repeat(limit - 2),
  }
  const evidence = (text) => ({
    contentType: 'application/json',
    body: { state: 'captured', text },
  })
  assert.equal(
    LocalWorkerResultSchema.safeParse({ ...response, capture: evidence('é') })
      .success,
    true,
  )
  assert.equal(
    LocalWorkerResultSchema.safeParse({ ...response, capture: evidence('éx') })
      .success,
    false,
  )
  assert.equal(LocalWorkerResultSchema.safeParse(response).success, true)
})
