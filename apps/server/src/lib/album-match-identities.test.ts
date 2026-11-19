import { describe, expect, it } from 'vitest'
import { createAlbumMatchRejectionPredicate } from './album-match-identities'

describe('album match identity comparison', () => {
  it('keeps provider IDs and reference types separate while honoring URL aliases', () => {
    const rejection = {
      provider: 'fixture-provider',
      sourceProvider: 'fixture-provider',
      referenceType: 'album',
      identifier: '100',
      aliases: [
        {
          referenceType: 'url',
          externalId: 'https://fixture.invalid/albums/100',
        },
      ],
    }
    const rejectedHere = createAlbumMatchRejectionPredicate(
      'fixture-provider',
      [rejection],
    )
    const rejectedElsewhere = createAlbumMatchRejectionPredicate(
      'another-fixture',
      [rejection],
    )
    expect(rejectedHere({ referenceType: 'album', externalId: '100' })).toBe(
      true,
    )
    expect(rejectedHere({ referenceType: 'release', externalId: '100' })).toBe(
      false,
    )
    expect(
      rejectedElsewhere({ referenceType: 'album', externalId: '100' }),
    ).toBe(false)
    expect(
      rejectedElsewhere({
        referenceType: 'url',
        externalId: 'https://fixture.invalid/albums/100?utm_source=fixture',
      }),
    ).toBe(true)
    expect(
      rejectedElsewhere({
        referenceType: 'url',
        externalId: 'https://fixture.invalid/albums/100?edition=200',
      }),
    ).toBe(false)
    expect(
      rejectedElsewhere({
        referenceType: 'url',
        externalId: 'https://fixture.invalid/albums/100#/200',
      }),
    ).toBe(false)
  })

  it('recognizes a legacy release URL through its indexed release variants', () => {
    const isRejected = createAlbumMatchRejectionPredicate('serply', [
      {
        provider: 'google-custom-search',
        sourceProvider: 'legacy-record',
        referenceType: 'rym-url',
        identifier:
          'http://www.rateyourmusic.com/release/album/fixture/record/reviews/2/',
        aliases: [],
      },
    ])
    expect(
      isRejected({
        referenceType: 'rym-url',
        externalId: 'https://rateyourmusic.com/release/album/fixture/record.p/',
      }),
    ).toBe(true)
    expect(
      isRejected({
        referenceType: 'rym-url',
        externalId: 'https://rateyourmusic.com/release/ep/fixture/record/',
      }),
    ).toBe(false)
  })

  it.each(['/music/fixture-record', '/music/fixture-record/fixture-artist'])(
    'rejects Metacritic review tabs for %s without rejecting other releases',
    (path) => {
      const isRejected = createAlbumMatchRejectionPredicate(
        'fixture-provider',
        [
          {
            provider: 'google-custom-search',
            sourceProvider: 'legacy-record',
            referenceType: 'metacritic-url',
            identifier: `http://www.metacritic.com${path}/critic-reviews/`,
            aliases: [],
          },
        ],
      )
      const rejects = (candidate: string) =>
        isRejected({
          referenceType: 'url',
          externalId: `https://metacritic.com${candidate}`,
        })

      expect(rejects(path)).toBe(true)
      expect(rejects(`${path}/user-reviews/?utm_source=fixture`)).toBe(true)
      expect(rejects(`${path}-other/critic-reviews`)).toBe(false)
      expect(rejects(`${path}/other-tab`)).toBe(false)
      expect(rejects(path.replace('/music/', '/movie/'))).toBe(false)
    },
  )
})
