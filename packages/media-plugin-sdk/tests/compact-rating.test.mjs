import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MediaPluginManifestSchema } from '../dist/index.js'

test('compact rating opt-in survives runtime manifest validation', () => {
  const manifest = {
    id: 'fixture',
    displayName: 'Fixture',
    description: '',
    mediaTypes: ['film'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
    secrets: [],
    browseFields: [
      {
        key: 'plugin.fixture.rating',
        label: 'Fixture rating',
        type: 'number',
        filterable: true,
        rating: { provider: 'fixture', scale: 100, compact: true },
      },
    ],
  }
  assert.equal(
    MediaPluginManifestSchema.parse(manifest).browseFields[0].rating.compact,
    true,
  )
  assert.equal(
    MediaPluginManifestSchema.safeParse({
      ...manifest,
      browseFields: [
        {
          ...manifest.browseFields[0],
          rating: { provider: 'fixture', scale: 100, compact: 'true' },
        },
      ],
    }).success,
    false,
  )
})
