import { describe, expect, it } from 'vitest'
import { ProviderReferenceOverrideSchema } from '../src/common'
import { filmIdentificationStatus } from '../src/browse'

describe('provider identifier edits', () => {
  it('normalizes IMDb title URLs and rejects unrelated URLs or invalid TMDb IDs', () => {
    expect(
      ProviderReferenceOverrideSchema.parse({
        provider: 'imdb',
        referenceType: 'imdb',
        externalId: ' https://www.imdb.com/title/tt1234567/ ',
      }).externalId,
    ).toBe('tt1234567')
    expect(
      ProviderReferenceOverrideSchema.safeParse({
        provider: 'imdb',
        referenceType: 'imdb',
        externalId: 'https://example.test/tt1234567',
      }).success,
    ).toBe(false)
    expect(
      ProviderReferenceOverrideSchema.safeParse({
        provider: 'tmdb',
        referenceType: 'tmdb',
        externalId: 'not-a-number',
      }).success,
    ).toBe(false)
  })
  it('requires usable shared film identifiers, not arbitrary source IDs', () => {
    expect(filmIdentificationStatus([])).toBe('Needs ID')
    expect(
      filmIdentificationStatus([{ referenceType: 'group', externalId: '12' }]),
    ).toBe('Needs ID')
    expect(
      filmIdentificationStatus([{ referenceType: 'imdb', externalId: 'bad' }]),
    ).toBe('Needs ID')
    expect(
      filmIdentificationStatus([{ referenceType: 'tmdb', externalId: '12' }]),
    ).toBe('Identified')
  })
})
