import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LocalWorkerPolicySchema,
  LocalWorkerPollSchema,
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
