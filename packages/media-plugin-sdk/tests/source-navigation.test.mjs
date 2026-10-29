import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MediaPluginManifestSchema,
  StoredPersonalStateSchema,
  isMediaProviderPlugin,
} from '../dist/index.js'

test('source navigation templates survive manifest validation and stored readers must be callable', () => {
  const manifest = {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['film'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
    secrets: [],
    sourceNavigation: {
      collectionUrlTemplate: 'https://example.com/collection/{id}',
      tagUrlTemplate: 'https://example.com/tag/{name}',
    },
  }
  assert.deepEqual(
    MediaPluginManifestSchema.parse(manifest).sourceNavigation,
    manifest.sourceNavigation,
  )
  assert.equal(
    isMediaProviderPlugin({ manifest, readStoredCollections: () => [] }),
    true,
  )
  assert.equal(
    isMediaProviderPlugin({ manifest, readStoredCollections: 'not callable' }),
    false,
  )
  assert.equal(isMediaProviderPlugin({ manifest }), true)
  assert.equal(
    isMediaProviderPlugin({
      manifest,
      readStoredPersonalState: () => ({ bookmarked: true }),
    }),
    true,
  )
  assert.equal(
    isMediaProviderPlugin({
      manifest,
      readStoredPersonalState: 'not callable',
    }),
    false,
  )
  assert.deepEqual(
    StoredPersonalStateSchema.parse({
      bookmarked: true,
      bookmarkDate: '2026-01-01',
      unrelated: 'not exposed',
    }),
    { bookmarked: true, bookmarkDate: '2026-01-01' },
  )
  assert.equal(
    StoredPersonalStateSchema.safeParse({ bookmarked: 'true' }).success,
    false,
  )
})
