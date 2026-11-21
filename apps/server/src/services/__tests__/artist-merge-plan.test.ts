import { describe, expect, it } from 'vitest'
import { differentProfiles, unlikeNames } from '@/services/artist-merge-plan'

describe('unlikeNames', () => {
  it('treats spellings of one name as alike', () => {
    expect(unlikeNames('Fixture Beyoncé', ['Fixture Beyonce'])).toEqual([])
    expect(unlikeNames('The Fixture Band', ['Fixture Band, The'])).toEqual([])
    expect(unlikeNames('Fixture Duo', ['Fixture Duo feat. Guest'])).toEqual([])
    expect(unlikeNames('Fixture & Sons', ['Fixture and Sons'])).toEqual([])
  })

  it('lists the names that are not alike after the name kept', () => {
    expect(
      unlikeNames('Fixture Band', ['Other Band', 'Fixture band', 'Other Band']),
    ).toEqual(['Fixture Band', 'Other Band'])
  })
})

describe('differentProfiles', () => {
  it('names providers with two different profiles', () => {
    expect(
      differentProfiles([
        {
          profiles: [
            { provider: 'spotify', externalId: 'a' },
            { provider: 'musicbrainz', externalId: 'm' },
            { provider: 'lastfm', externalId: 'Fixture Beyoncé' },
          ],
        },
        {
          profiles: [
            { provider: 'spotify', externalId: 'b' },
            { provider: 'musicbrainz', externalId: 'm' },
            { provider: 'lastfm', externalId: 'Fixture Beyonce' },
            { provider: 'discogs', externalId: null },
          ],
        },
      ]),
    ).toEqual(['spotify'])
  })
})
