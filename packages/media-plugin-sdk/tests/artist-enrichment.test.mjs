import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PluginArtistResultSchema,
  PluginResultSchema,
  ProviderArtistSearchAmbiguousError,
  isMediaProviderPlugin,
  isProviderArtistSearchAmbiguousError,
} from '../dist/index.js'

const manifest = {
  id: 'fixture',
  displayName: 'Fixture',
  description: '',
  mediaTypes: ['album'],
  secrets: [],
  rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
}
const scrapeArtist = async () => ({ payload: {}, profile: { tags: [] } })
const scrapeMediaItem = async () => ({ payload: {}, normalized: {} })

test('album artist bootstrapping requires a separate opt-in and both hooks', () => {
  assert.equal(isMediaProviderPlugin({ manifest, scrapeArtist }), true)
  assert.equal(isMediaProviderPlugin({ manifest, scrapeArtist: true }), false)
  const optedIn = { ...manifest, bootstrapAlbumArtists: true }
  assert.equal(
    isMediaProviderPlugin({ manifest: optedIn, scrapeArtist }),
    false,
  )
  assert.equal(
    isMediaProviderPlugin({ manifest: optedIn, scrapeArtist, scrapeMediaItem }),
    true,
  )
  assert.equal(
    isMediaProviderPlugin({
      manifest: { ...optedIn, mediaTypes: ['film'] },
      scrapeArtist,
      scrapeMediaItem,
    }),
    false,
  )
})

test('the host validates artist results and does not accept a library ID from a provider', () => {
  const result = PluginArtistResultSchema.parse({
    payload: { id: 'provider-artist' },
    profile: {
      tags: ['Ambient'],
      similarArtists: [{ name: 'Fixture Artist', artistId: 'untrusted-id' }],
    },
  })
  assert.deepEqual(result.profile.similarArtists, [{ name: 'Fixture Artist' }])
  assert.equal(
    PluginArtistResultSchema.safeParse({
      payload: {},
      profile: { url: 'file:///example' },
    }).success,
    false,
  )
})

test('only the branded ambiguity error allows the album lookup to fall back', () => {
  assert.equal(
    isProviderArtistSearchAmbiguousError(
      new ProviderArtistSearchAmbiguousError(),
    ),
    true,
  )
  assert.equal(
    isProviderArtistSearchAmbiguousError(
      Object.assign(new Error('Fixture error'), {
        name: 'ProviderArtistSearchAmbiguousError',
      }),
    ),
    false,
  )
})

test('artist and media plugins contribute relationships without claiming library IDs', () => {
  const relationship = {
    kind: 'similar',
    targetType: 'album',
    name: 'Fixture album',
    externalId: 'album-identity',
    referenceType: 'edition',
    url: 'https://example.test/albums/fixture',
  }
  const supplied = [{ ...relationship, targetId: 'unverified' }]
  assert.deepEqual(
    PluginArtistResultSchema.parse({
      payload: {},
      profile: { relationships: supplied },
    }).profile.relationships,
    [relationship],
  )
  assert.deepEqual(
    PluginResultSchema.parse({
      payload: {},
      normalized: { relationships: supplied },
    }).normalized.relationships,
    [relationship],
  )
  assert.equal(
    PluginArtistResultSchema.safeParse({
      payload: {},
      profile: {
        relationships: [
          { ...relationship, url: 'https://user:secret@example.test/' },
        ],
      },
    }).success,
    false,
  )
})
