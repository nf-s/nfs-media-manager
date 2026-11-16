import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MediaPluginManifestSchema } from '../dist/index.js'

const manifest = {
  id: 'fixture',
  displayName: 'Fixture',
  description: '',
  mediaTypes: ['film'],
  rateLimit: { maxConcurrent: 1, minTimeMs: 2000 },
  secrets: [],
}

test('a manifest may name its site as an http or https URL', () => {
  assert.equal(MediaPluginManifestSchema.parse(manifest).siteUrl, undefined)
  for (const siteUrl of ['https://example.com', 'http://example.org/films'])
    assert.equal(
      MediaPluginManifestSchema.parse({ ...manifest, siteUrl }).siteUrl,
      siteUrl,
    )
})

test('a site URL with another scheme or no scheme is rejected', () => {
  for (const siteUrl of [
    'javascript:alert(1)',
    'ftp://example.com',
    'example.com',
    '',
  ])
    assert.equal(
      MediaPluginManifestSchema.safeParse({ ...manifest, siteUrl }).success,
      false,
      siteUrl,
    )
})
