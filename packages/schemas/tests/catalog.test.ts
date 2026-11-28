import { describe, expect, it } from 'vitest'
import {
  discoveryOperations,
  memberScope,
  type CatalogScopeQuery,
} from '../src/catalog'

describe('catalog scopes', () => {
  it('reads library members unless another scope or a selection is named', () => {
    expect(memberScope({})).toBe(true)
    expect(memberScope({ libraryScope: 'library' })).toBe(true)
    expect(memberScope({ libraryScope: 'all' })).toBe(false)
    expect(
      memberScope({
        discoverySources: 'artist-albums',
        discoverySourceScope: 'selection',
      }),
    ).toBe(false)
    expect(memberScope({ discoverySources: 'artist-albums' })).toBe(true)
  })

  it('leaves listening operations out of a Tracks selection', () => {
    const query: CatalogScopeQuery = {
      discoverySources: 'scrobble,artist-albums,scrobble',
      discoverySourceScope: 'selection',
    }
    expect(discoveryOperations(query)).toEqual(['scrobble', 'artist-albums'])
    expect(discoveryOperations(query, 'track')).toEqual(['artist-albums'])
    expect(
      memberScope(
        { discoverySources: 'scrobble', discoverySourceScope: 'selection' },
        'track',
      ),
    ).toBe(true)
  })
})
