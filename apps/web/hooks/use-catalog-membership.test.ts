import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CatalogMembershipInput } from '@repo/schemas/manual-add'
import { catalogMembershipQuery } from './use-catalog-membership'

test('duplicate catalog identities preserve the observed recording in the request and query key', () => {
  const track = {
    mediaType: 'track',
    externalId: 'AAAAAAAAAAAAAAAAAAAAAA',
  } satisfies CatalogMembershipInput['items'][number]
  const observed = {
    ...track,
    recording: {
      title: 'Fixture recording',
      artists: ['Fixture artist'],
      spotifyAlbumId: 'BBBBBBBBBBBBBBBBBBBBBB',
      albumName: 'Fixture release',
    },
  }
  const observedQuery = catalogMembershipQuery([observed])
  assert.deepEqual(observedQuery.catalog, [observed])
  assert.deepEqual(catalogMembershipQuery([track, observed]), observedQuery)
  assert.deepEqual(catalogMembershipQuery([observed, track]), observedQuery)
  assert.notDeepEqual(
    catalogMembershipQuery([track]).queryKey,
    observedQuery.queryKey,
  )
})
