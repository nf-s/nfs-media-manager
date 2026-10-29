import { describe, expect, it } from 'vitest'
import { MediaPluginManifestSchema } from '@repo/media-plugin-sdk'
import {
  collectionSourceLinks,
  expandSourceTemplate,
  sourceLink,
  tagSourceUrl,
  storedItemSourceLink,
  storedTmdbTagSourceUrl,
} from './source-navigation'

const manifest = MediaPluginManifestSchema.parse({
  id: 'fixture',
  displayName: 'Fixture provider',
  description: '',
  mediaTypes: ['film'],
  rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
  secrets: [],
  sourceNavigation: {
    collectionUrlTemplate: 'https://example.com/collections?id={id}',
    tagUrlTemplate: 'https://example.com/tags?name={name}',
  },
})

describe('metadata source navigation', () => {
  it('prefers the original piano tag over the saved DjaDja release-group link', () => {
    const source = {
      provider: 'musicbrainz',
      source: 'musicbrainz',
      sourceId: null,
      rawName: 'piano',
      kind: 'general',
    }
    const savedLinks = [
      {
        provider: 'musicbrainz',
        url: 'https://musicbrainz.org/release-group/fb8011c9-6074-4aba-a737-0887ec3f5e42',
      },
    ]
    const link =
      sourceLink(
        'musicbrainz',
        'MusicBrainz',
        source.rawName,
        tagSourceUrl(source),
      ) ?? storedItemSourceLink(source, savedLinks, [], {}, 'MusicBrainz')?.link
    expect(link).toMatchObject({
      provider: 'musicbrainz',
      name: 'piano',
      url: 'https://musicbrainz.org/tag/piano',
    })
  })

  it.each(['general', 'tag', 'genre'])(
    'links MusicBrainz %s provenance by raw name, not merged name or source ID',
    (kind) => {
      const source = {
        provider: 'musicbrainz',
        source: null,
        sourceId: '26af3760-750a-4b5e-a699-78c87697585a',
        rawName: '  Arena   Rock  ',
        name: 'Merged rock tags',
        kind,
      }
      expect(tagSourceUrl(source)).toBe(
        'https://musicbrainz.org/tag/arena%20rock',
      )
      expect(source.rawName).toBe('  Arena   Rock  ')
      expect(tagSourceUrl({ ...source, source: 'unknown' })).toBe(
        'https://musicbrainz.org/tag/arena%20rock',
      )
      expect(
        tagSourceUrl(
          { ...source, provider: 'fixture', source: 'musicbrainz' },
          manifest,
        ),
      ).toBe('https://musicbrainz.org/tag/arena%20rock')
    },
  )

  it.each([
    ['  Cafe\u0301\tPIANO  ', 'caf%C3%A9%20piano'],
    ['R&B / Piano?#%+', 'r%26b%20%2F%20piano%3F%23%25%2B'],
    ['\u{1f3b9}', '%F0%9F%8E%B9'],
    ['//evil.example/../piano', '%2F%2Fevil.example%2F..%2Fpiano'],
    ['%2e%2e', '%252e%252e'],
  ])(
    'normalizes and safely encodes MusicBrainz raw name %s',
    (rawName, encoded) => {
      expect(
        tagSourceUrl({
          provider: 'musicbrainz',
          source: null,
          rawName,
          kind: 'general',
        }),
      ).toBe(`https://musicbrainz.org/tag/${encoded}`)
    },
  )

  it.each([
    '',
    ' \t\n ',
    '.',
    '..',
    'piano,rock',
    'piano\u0000',
    '\ud800',
    '\udc00',
  ])(
    'leaves invalid MusicBrainz raw name %j without a direct tag URL',
    (rawName) => {
      expect(
        tagSourceUrl(
          { provider: 'musicbrainz', source: null, rawName, kind: 'general' },
          manifest,
        ),
      ).toBeUndefined()
    },
  )

  it('does not infer MusicBrainz provenance or override a different upstream', () => {
    const source = {
      provider: 'musicbrainz',
      source: 'discogs',
      rawName: 'piano',
      kind: 'general',
    }
    expect(tagSourceUrl(source)).toBeUndefined()
    expect(
      tagSourceUrl({ ...source, source: null, provider: null }),
    ).toBeUndefined()
    expect(
      tagSourceUrl({ ...source, source: null, kind: 'collection' }),
    ).toBeUndefined()
    expect(
      tagSourceUrl({ ...source, source: null, provider: 'fixture' }, manifest),
    ).toBe('https://example.com/tags?name=piano')
  })

  it('recovers a legacy Discogs style from structured data instead of using its genre kind or album link', () => {
    const source = {
      provider: 'discogs',
      source: 'discogs',
      rawName: 'Arena Rock',
      kind: 'genre',
    }
    expect(tagSourceUrl(source)).toBeUndefined()
    expect(
      tagSourceUrl(source, undefined, [{ master: { styles: ['Arena Rock'] } }]),
    ).toBe('https://www.discogs.com/search?style=Arena+Rock')
    expect(source.kind).toBe('genre')
  })

  it.each([
    ['Electronic', 'genre', 'genre=Electronic'],
    ['Pop', 'genre', 'genre=Pop'],
    ['Alt-Pop', 'style', 'style=Alt-Pop'],
    ['Dance-pop', 'style', 'style=Dance-pop'],
  ])('links the stored AUDACITY %s tag directly', (rawName, kind, query) => {
    expect(
      tagSourceUrl(
        { provider: 'discogs', source: 'discogs', rawName, kind },
        undefined,
        [
          {
            master: {
              id: 4358199,
              genres: ['Electronic', 'Pop'],
              styles: ['Dance-pop', 'Alt-Pop'],
            },
          },
        ],
      ),
    ).toBe(`https://www.discogs.com/search?${query}`)
  })

  it.each([
    { styles: ['Arena Rock'] },
    { release: { styles: ['Arena Rock'] } },
    { mainRelease: { styles: ['Arena Rock'] } },
    { discogs: { master: { styles: ['Arena Rock'] } } },
  ])(
    'uses supported raw snapshot shapes without guessing the category',
    (payload) => {
      expect(
        tagSourceUrl(
          {
            provider: 'discogs',
            source: null,
            rawName: ' arena   ROCK ',
            kind: 'genre',
          },
          undefined,
          [payload],
        ),
      ).toBe('https://www.discogs.com/search?style=Arena+Rock')
    },
  )

  it('retains both proven classifications in a field-based query', () => {
    expect(
      tagSourceUrl(
        { provider: 'discogs', source: null, rawName: 'Shared', kind: 'genre' },
        undefined,
        [{ master: { genres: ['Shared'], styles: ['Shared'] } }],
      ),
    ).toBe('https://www.discogs.com/search?genre=Shared&style=Shared')
  })

  it('uses explicit styles but does not assume legacy genre means Discogs genre', () => {
    const source = {
      provider: 'discogs',
      source: null,
      rawName: 'Arena Rock',
      kind: 'style',
    }
    expect(tagSourceUrl(source)).toBe(
      'https://www.discogs.com/search?style=Arena+Rock',
    )
    expect(tagSourceUrl({ ...source, kind: 'genre' })).toBeUndefined()
    expect(
      tagSourceUrl({ ...source, kind: 'collection' }, undefined, [
        { styles: ['Arena Rock'] },
      ]),
    ).toBeUndefined()
    expect(
      tagSourceUrl({ ...source, source: 'tmdb' }, undefined, [
        { styles: ['Arena Rock'] },
      ]),
    ).toBeUndefined()
  })

  it.each([
    null,
    { styles: 'Arena Rock' },
    { genres: [{ name: 'Arena Rock' }] },
    { tags: ['Arena Rock'] },
    { notes: 'Arena Rock' },
    { artists: [{ styles: ['Arena Rock'] }] },
    { master: { styles: ['Hard Rock'] } },
  ])(
    'does not infer classification from unrelated or malformed data %j',
    (payload) => {
      expect(
        tagSourceUrl(
          {
            provider: 'discogs',
            source: null,
            rawName: 'Arena Rock',
            kind: 'genre',
          },
          undefined,
          [payload],
        ),
      ).toBeUndefined()
    },
  )

  it('encodes Discogs query values without splitting punctuation, and validates entries independently', () => {
    const rawName = 'Funk / Soul & R&B?#%+'
    const url = tagSourceUrl(
      { provider: 'discogs', source: null, rawName, kind: 'genre' },
      undefined,
      [{ genres: [null, 10, rawName], styles: 'invalid' }],
    )
    expect(url).toBe(
      'https://www.discogs.com/search?genre=Funk+%2F+Soul+%26+R%26B%3F%23%25%2B',
    )
    for (const invalid of ['', ' \t ', '\ud800', 'Rock\u0000'])
      expect(
        tagSourceUrl({
          provider: 'discogs',
          source: null,
          rawName: invalid,
          kind: 'style',
        }),
      ).toBeUndefined()
  })

  it('recovers genuine genre and keyword IDs from exact historical names, not aggregator IDs', () => {
    const genre = {
      provider: 'tmdb',
      source: null,
      rawName: 'Drama',
      kind: 'genre',
      sourceId: null,
    }
    expect(
      storedTmdbTagSourceUrl(genre, [
        { genres: [{ id: 18, name: 'Drama' }], keywords: 'old-invalid-shape' },
      ]),
    ).toBe('https://www.themoviedb.org/genre/18-drama/movie')
    const keyword = {
      provider: 'mdblist',
      source: 'tmdb',
      sourceId: 'mdblist:555',
      rawName: 'tmdb.history-of-spain',
      kind: 'keyword',
    }
    expect(
      storedTmdbTagSourceUrl(keyword, [
        { keywords: { keywords: [{ id: 9716, name: 'History of Spain' }] } },
      ]),
    ).toBe('https://www.themoviedb.org/keyword/9716/movie')
    expect(
      storedTmdbTagSourceUrl(keyword, [
        { genres: [{ id: 9716, name: 'History of Spain' }] },
      ]),
    ).toBeUndefined()
    expect(
      storedTmdbTagSourceUrl(
        { ...keyword, source: 'unknown', rawName: 'history-of-spain' },
        [{ keywords: { keywords: [{ id: 9716, name: 'History of Spain' }] } }],
      ),
    ).toBeUndefined()
    expect(
      storedTmdbTagSourceUrl(genre, [
        { genres: [{ id: 18, name: 'Drama' }] },
        { genres: [{ id: 19, name: 'Drama' }] },
      ]),
    ).toBeUndefined()
    expect(
      storedTmdbTagSourceUrl(genre, [
        {
          genres: [
            { id: 'mdblist:18', name: 'Drama' },
            { id: 18, name: 'Historical Drama' },
          ],
        },
      ]),
    ).toBeUndefined()
  })
  it('links RYM provenance to the actual stored page without inventing genre URLs', () => {
    const url =
      'https://rateyourmusic.com/music-review/cyarbrough/marina-herlop/dja-dja/302502412'
    const source = {
      provider: 'retired-provider',
      source: 'rym',
      rawName: 'Avant-Folk',
      kind: 'genre',
      sourceId: null,
    }
    expect(tagSourceUrl(source)).toBeUndefined()
    expect(
      storedItemSourceLink(
        source,
        [{ provider: 'retired-provider', url }],
        [],
        {},
        'Retired provider',
      ),
    ).toMatchObject({
      kind: 'item',
      link: { provider: 'rym', providerLabel: 'Rate Your Music', url },
    })
  })

  it('links aggregator origins through genuine stored film IDs without promoting opaque tag IDs', () => {
    const source = {
      source: 'unknown',
      provider: 'mdblist',
      rawName: 'unrecognized-token',
    }
    expect(
      storedItemSourceLink(
        source,
        [],
        [],
        { ids: { imdb: 'tt0111161' } },
        'MDBList',
      ),
    ).toMatchObject({
      kind: 'provider-item',
      link: { provider: 'mdblist', url: 'https://mdblist.com/movie/tt0111161' },
    })
    expect(
      storedItemSourceLink(
        { ...source, source: 'tmdb' },
        [],
        [],
        { ids: { tmdb: 278 } },
        'MDBList',
      ),
    ).toMatchObject({
      kind: 'item',
      link: { provider: 'tmdb', url: 'https://www.themoviedb.org/movie/278' },
    })
    expect(
      storedItemSourceLink(source, [], [], { id: 555 }, 'MDBList'),
    ).toBeUndefined()
    expect(
      storedItemSourceLink(
        source,
        [{ provider: 'mdblist', url: 'javascript:alert(1)' }],
        [],
        {},
        'MDBList',
      ),
    ).toBeUndefined()
    const transported = [
      {
        provider: 'mdblist',
        url: 'https://www.metacritic.com/movie/it-was-just-an-accident',
      },
    ]
    expect(
      storedItemSourceLink(
        source,
        transported,
        [],
        { ids: { imdb: 'tt0111161' } },
        'MDBList',
      ),
    ).toMatchObject({
      link: { provider: 'mdblist', url: 'https://mdblist.com/movie/tt0111161' },
    })
    expect(
      storedItemSourceLink(source, transported, [], {}, 'MDBList'),
    ).toBeUndefined()
    expect(
      storedItemSourceLink(
        { ...source, source: 'tmdb' },
        [{ provider: 'mdblist', url: 'https://www.themoviedb.org/movie/278' }],
        [],
        {},
        'MDBList',
      ),
    ).toMatchObject({
      link: { provider: 'tmdb', url: 'https://www.themoviedb.org/movie/278' },
    })
    expect(
      storedItemSourceLink(
        source,
        [
          {
            provider: 'mdblist',
            url: 'https://mdblist.com.attacker.example/movie/tt0111161',
          },
        ],
        [],
        {},
        'MDBList',
      ),
    ).toBeUndefined()
    expect(
      tagSourceUrl({
        ...source,
        kind: 'keyword',
        rawName: 'imdb.history-of-spain',
        sourceId: 'mdblist:555',
      }),
    ).toBe('https://www.imdb.com/search/title/?keywords=history-of-spain')
  })
  it('resolves existing collection IDs without provider-specific knowledge and ignores malformed entries', () => {
    expect(
      collectionSourceLinks(
        {
          'plugin.fixture.details': {
            collections: [
              { id: 12, name: 'Festival', size: 42, spoiler: false },
              { id: 12, name: 'Festival' },
              { id: 0, name: 'Invalid' },
              { name: 'Name only' },
              { id: 13, name: 'Unsafe', url: 'javascript:alert(1)' },
              null,
            ],
          },
        },
        [manifest],
      ),
    ).toEqual([
      {
        provider: 'fixture',
        providerLabel: 'Fixture provider',
        name: 'Festival',
        url: 'https://example.com/collections?id=12',
      },
    ])
    expect(collectionSourceLinks(null, [manifest])).toEqual([])
    expect(
      collectionSourceLinks(
        { 'plugin.fixture.details': { collections: [] } },
        [],
      ),
    ).toEqual([])
  })

  it('validates stored links and encodes template values without allowing host/scheme substitution', () => {
    expect(
      expandSourceTemplate('https://example.com/tags?name={name}', {
        name: 'art & film/#',
      }),
    ).toBe('https://example.com/tags?name=art%20%26%20film%2F%23')
    for (const template of [
      'javascript:{name}',
      'https://{name}/tags',
      'https://user:secret@example.com/{name}',
      'https://example.com/{unknown}',
      'https://example.com/{id}',
    ])
      expect(
        expandSourceTemplate(template, { name: 'evil.example' }),
      ).toBeUndefined()
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://user:password@example.com',
      'not a url',
    ])
      expect(sourceLink('fixture', 'Fixture', 'Tag', url)).toBeNull()
  })

  it('uses genuine upstream IDs, never aggregator IDs, and leaves unsupported tags unlinked', () => {
    const base = {
      source: 'tmdb',
      provider: 'mdblist',
      sourceId: 'mdblist:42',
      rawName: 'tmdb.art-history',
      kind: 'keyword',
    }
    expect(tagSourceUrl(base)).toBeUndefined()
    expect(tagSourceUrl({ ...base, sourceId: '42' })).toBe(
      'https://www.themoviedb.org/keyword/42/movie',
    )
    expect(tagSourceUrl({ ...base, source: 'unknown' })).toBeUndefined()
    expect(
      tagSourceUrl({ ...base, source: 'imdb', rawName: 'imdb.art-history' }),
    ).toBe('https://www.imdb.com/search/title/?keywords=art-history')
    expect(
      tagSourceUrl(
        {
          ...base,
          provider: 'fixture',
          source: null,
          rawName: 'art & history',
        },
        manifest,
      ),
    ).toBe('https://example.com/tags?name=art%20%26%20history')
    expect(tagSourceUrl({ ...base, source: 'tmdb' }, manifest)).toBeUndefined()
  })
})
