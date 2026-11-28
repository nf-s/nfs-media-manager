import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowseFacetQuerySchema,
  compareBrowseFacets,
  trackBrowseFields,
} from '@repo/schemas/browse'
import { formatTagName } from '@repo/schemas/tags'
import { facetFieldLimit } from '../src/compile/facets'
import type { TrackFilterOption } from '../src/source'
import {
  openDeviceStore,
  reason,
  served,
  type DeviceStore,
  type StoreOptions,
  type StoreRow,
} from './device-store'
import {
  tagPayload,
  trackRow,
  type TagOptions,
  type TrackRowPatch,
} from './fixtures'

/** Synthetic rows only: every name, ID and tag below is invented. */

function track(id: string, patch: TrackRowPatch = {}): StoreRow {
  return { entity: 'track', id, payload: trackRow(id, patch) }
}

function tag(id: string, options: TagOptions): StoreRow {
  return { entity: 'tag', id, payload: tagPayload(options) }
}

function tagKey(key: string, ancestorKeys: string[]): StoreRow {
  return {
    entity: 'tag_key',
    id: `album:${key}`,
    payload: { mediaType: 'album', key, ancestorKeys },
  }
}

function providers(names: { id: string; displayName: string }[]): StoreRow {
  return {
    entity: 'meta',
    id: 'providers',
    payload: { kind: 'providers', names },
  }
}

/** The Tracks field list with only these keys. */
function fieldsOf(...keys: string[]) {
  return trackBrowseFields.filter((field) => keys.includes(field.key))
}

let store: DeviceStore | undefined

async function open(rows: StoreRow[], options: StoreOptions = {}) {
  store = await openDeviceStore(rows, options)
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

async function facets(
  device: DeviceStore,
  input: Record<string, unknown> = {},
): Promise<TrackFilterOption[]> {
  return served(
    await device.source.trackFacets(BrowseFacetQuerySchema.parse(input)),
  )
}

/** One field's rows as [value, count], in response order. */
function counts(
  rows: readonly TrackFilterOption[],
  field: string,
): [string, number][] {
  return rows
    .filter((row) => row.field === field)
    .map((row) => [row.value, row.count])
}

describe('text facets', () => {
  it('counts visible tracks per exact value, case-sensitively', async () => {
    const device = await open(
      [
        track('a', { text: { artist: ['Night Owl'] } }),
        track('b', { text: { artist: ['night owl'] } }),
        track('c', { text: { artist: ['Night Owl', 'Day Owl'] } }),
        track('d', {
          text: { artist: ['Night Owl'] },
          extra: { archived: true },
        }),
        track('e', {
          text: { artist: ['Night Owl'] },
          extra: { redundantPlaceholder: true },
        }),
        track('f', { text: { artist: [''] } }),
      ],
      { trackFields: fieldsOf('artist') },
    )
    expect(await facets(device)).toEqual([
      {
        field: 'artist',
        value: 'Night Owl',
        count: 2,
        label: 'Artists: Night Owl',
      },
      {
        field: 'artist',
        value: 'Day Owl',
        count: 1,
        label: 'Artists: Day Owl',
      },
      {
        field: 'artist',
        value: 'night owl',
        count: 1,
        label: 'Artists: night owl',
      },
    ])
  })

  it('lists a redundant placeholder under the Last.fm source only', async () => {
    const device = await open(
      [
        track('a', { text: { source: ['Album track list'] } }),
        track('b', {
          text: { source: ['Last.fm', 'Album track list'] },
          extra: { redundantPlaceholder: true },
        }),
        track('c', {
          text: { source: ['Last.fm'] },
          extra: { archived: true },
        }),
      ],
      { trackFields: fieldsOf('source') },
    )
    expect(counts(await facets(device), 'source')).toEqual([
      ['Album track list', 1],
      ['Last.fm', 1],
    ])
  })

  it('is not narrowed by filters, search or a creator scope on the request', async () => {
    const device = await open(
      [
        track('a', { text: { artist: ['Ember'] } }),
        track('b', { text: { artist: ['Ember'] } }),
      ],
      { trackFields: fieldsOf('artist') },
    )
    const plain = await facets(device)
    expect(
      await facets(device, {
        creatorId: 'artist-Ember',
        filters: JSON.stringify([{ field: 'artist', value: 'Other' }]),
        includeArchived: 'true',
      }),
    ).toEqual(plain)
    expect(counts(plain, 'artist')).toEqual([['Ember', 2]])
  })

  it('counts every Tracks text field from its stored values', async () => {
    const device = await open([track('a'), track('b')], {
      trackFields: fieldsOf(
        'title',
        'source',
        'spotifyMatch',
        'artist',
        'album',
        'playlist',
        'albumLink',
        'hasTrackTags',
        'musicalKey',
      ),
    })
    const rows = await facets(device)
    expect(rows.map((row) => [row.label, row.count])).toEqual([
      ['Album: Example Album', 2],
      ['Artists: Example Artist', 2],
      ['Has track tags: No', 2],
      ['Key: 8A', 2],
      ['Library album: In library', 2],
      ['Playlists: Example Playlist', 2],
      ['Source: Album track list', 2],
      ['Spotify match: Unmatched', 2],
      ['Title: Track a', 1],
      ['Title: Track b', 1],
    ])
  })
})

describe('typed text', () => {
  const titles = [
    'River Stone',
    'river song',
    'Öresund Bridge',
    'Stone Age',
    '100% Pure',
    '100 Pure',
    'Star*Gazer',
  ]
  const rows = () =>
    titles.map((title, index) =>
      track(`t${index}`, {
        text: { title: [title], artist: [`Artist ${index}`] },
      }),
    )
  const titlesFor = async (q: string) =>
    counts(
      await facets(await open(rows(), { trackFields: fieldsOf('title') }), {
        q,
      }),
      'title',
    ).map(([value]) => value)

  it('matches each word as a case-insensitive substring', async () => {
    expect(await titlesFor('riv')).toEqual(['river song', 'River Stone'])
    await store?.close()
    expect(await titlesFor('STONE riv')).toEqual(['River Stone'])
  })

  it('folds accented capitals as PostgreSQL lower() does', async () => {
    expect(await titlesFor('ÖRE')).toEqual(['Öresund Bridge'])
  })

  it('takes LIKE and GLOB characters literally', async () => {
    expect(await titlesFor('100%')).toEqual(['100% Pure'])
    await store?.close()
    expect(await titlesFor('r*g')).toEqual(['Star*Gazer'])
  })

  it("drops a word found in the field's label, except on Title", async () => {
    const device = await open(
      [
        track('a', { text: { title: ['Title track'], artist: ['Night Owl'] } }),
        track('b', { text: { title: ['Night'], artist: ['Day Owl'] } }),
      ],
      { trackFields: fieldsOf('title', 'artist') },
    )
    const rows = await facets(device, { q: 'artists: night' })
    expect(counts(rows, 'artist')).toEqual([['Night Owl', 1]])
    expect(counts(rows, 'title')).toEqual([])
    expect(counts(await facets(device, { q: 'title' }), 'title')).toEqual([
      ['Title track', 1],
    ])
  })

  it('reads a musical key in any notation as that key', async () => {
    const device = await open(
      [
        track('a', { text: { musicalKey: ['8A'] } }),
        track('b', { text: { musicalKey: ['8B'] } }),
        track('c', { text: { musicalKey: ['8A'] } }),
      ],
      { trackFields: fieldsOf('musicalKey') },
    )
    expect(counts(await facets(device, { q: 'Am' }), 'musicalKey')).toEqual([
      ['8A', 2],
    ])
    expect(counts(await facets(device, { q: '8b' }), 'musicalKey')).toEqual([
      ['8B', 1],
    ])
    expect(counts(await facets(device, { q: '8' }), 'musicalKey')).toEqual([
      ['8A', 2],
      ['8B', 1],
    ])
  })

  it('matches a provider by ID or by display name and labels it by name', async () => {
    const device = await open(
      [
        providers([
          { id: 'discogs', displayName: 'Discogs' },
          { id: 'plugin-gram', displayName: 'Gramophone Archive' },
        ]),
        track('a', { text: { provider: ['discogs'] } }),
        track('b', { text: { provider: ['plugin-gram'] } }),
        track('c', { text: { provider: ['unlisted'] } }),
      ],
      { trackFields: fieldsOf('provider') },
    )
    expect((await facets(device)).map((row) => row.label)).toEqual([
      'Provider: Discogs',
      'Provider: Gramophone Archive',
      'Provider: unlisted',
    ])
    const values = async (q: string) =>
      counts(await facets(device, { q }), 'provider').map(([value]) => value)
    expect(await values('gramo')).toEqual(['plugin-gram'])
    expect(await values('archive plugin')).toEqual(['plugin-gram'])
    expect(await values('unl')).toEqual(['unlisted'])
  })
})

describe('order and limits', () => {
  it('keeps the exact match within the limit before higher counts', async () => {
    const device = await open(
      [
        track('a', { text: { title: ['NIGHT'] } }),
        track('b', { text: { title: ['Night Light'] } }),
        track('c', { text: { title: ['Night Light'] } }),
      ],
      { trackFields: fieldsOf('title') },
    )
    const titles = async (q: string) =>
      counts(await facets(device, { q, limitPerField: 1 }), 'title')
    expect(await titles('night')).toEqual([['NIGHT', 1]])
    expect(await titles('nigh')).toEqual([['Night Light', 2]])
  })

  it('breaks equal counts by code point within the limit and by label in the response', async () => {
    const device = await open(
      ['é', 'b', 'e', 'B'].map((title, index) =>
        track(`t${index}`, { text: { title: [title] } }),
      ),
      { trackFields: fieldsOf('title') },
    )
    const labels = async (limitPerField: number) =>
      (await facets(device, { limitPerField })).map((row) => row.label)
    expect(await labels(2)).toEqual(['Title: b', 'Title: B'])
    expect(await labels(4)).toEqual([
      'Title: b',
      'Title: B',
      'Title: e',
      'Title: é',
    ])
  })

  it('orders the whole response by count, then label across fields', async () => {
    const device = await open(
      [
        track('a', { text: { title: ['Alpha'], artist: ['Zed'] } }),
        track('b', { text: { title: ['Beta'], artist: ['Zed'] } }),
      ],
      { trackFields: fieldsOf('title', 'artist') },
    )
    const rows = await facets(device)
    expect(rows.map((row) => row.label)).toEqual([
      'Artists: Zed',
      'Title: Alpha',
      'Title: Beta',
    ])
    expect([...rows].sort(compareBrowseFacets)).toEqual(rows)
  })

  it('limits each field by limitPerField and by 1000 over all fields', async () => {
    expect(facetFieldLimit(25, 1)).toBe(25)
    expect(facetFieldLimit(50, 14)).toBe(50)
    expect(facetFieldLimit(50, 40)).toBe(25)
    expect(facetFieldLimit(50, 1001)).toBe(1)
    const device = await open(
      ['One', 'Two', 'Three'].map((title, index) =>
        track(`t${index}`, { text: { title: [title], artist: ['Same'] } }),
      ),
      { trackFields: fieldsOf('title', 'artist') },
    )
    const rows = await facets(device, { limitPerField: 2 })
    expect(counts(rows, 'title')).toHaveLength(2)
    expect(counts(rows, 'artist')).toEqual([['Same', 3]])
  })
})

describe('tag facets', () => {
  /**
   * Album tags: rock, with indie rock and post-rock beneath it, and jazz.
   * Artist tags: drone, beneath electronic (a key with no tag row). Track
   * d's own indie rock tag is from Sonovault, so indie rock and rock are not
   * inherited by tracks with tags of their own (track e).
   */
  const tagRows = () => [
    tag('tag-rock', { name: 'Rock' }),
    tag('tag-indie', { name: 'Indie Rock' }),
    tag('tag-post', { name: 'Post-Rock' }),
    tag('tag-jazz', { name: 'Jazz' }),
    tagKey('indie rock', ['rock']),
    tagKey('post-rock', ['rock']),
    tagKey('drone', ['electronic']),
  ]
  const tracks = () => [
    track('a', {
      extra: {
        albumTagIds: ['tag-indie'],
        albumReleaseTagCount: 2,
        artistTagLabelKeys: ['drone'],
      },
    }),
    track('b', {
      extra: {
        albumTagIds: ['tag-rock'],
        albumReleaseTagCount: 1,
        artistTagLabelKeys: ['drone'],
      },
    }),
    track('c', {
      extra: {
        hasOwnTags: true,
        ownTagIds: ['tag-post'],
        albumTagIds: ['tag-rock'],
        albumReleaseTagCount: 1,
        artistTagLabelKeys: [],
      },
    }),
    track('d', {
      extra: {
        hasOwnTags: true,
        ownTagIds: ['tag-indie'],
        ownSonovaultTagIds: ['tag-indie'],
        albumTagIds: ['tag-post'],
        albumReleaseTagCount: 1,
        artistTagLabelKeys: ['drone'],
      },
    }),
    track('e', {
      extra: {
        hasOwnTags: true,
        ownTagIds: ['tag-jazz'],
        albumTagIds: ['tag-indie'],
        albumReleaseTagCount: 1,
        artistTagLabelKeys: ['drone'],
      },
    }),
    // Its own post-rock tag is also its album's: counted once.
    track('f', {
      extra: {
        hasOwnTags: true,
        ownTagIds: ['tag-post'],
        albumTagIds: ['tag-post'],
        albumReleaseTagCount: 1,
        artistTagLabelKeys: [],
      },
    }),
    track('archived', {
      extra: { albumTagIds: ['tag-rock'], archived: true },
    }),
    // Not counted, but its Sonovault tags stop tracks with tags of their
    // own inheriting post-rock and jazz, so every Auto count is decided.
    track('archived-sonovault', {
      extra: {
        archived: true,
        hasOwnTags: true,
        ownTagIds: ['tag-post', 'tag-jazz'],
        ownSonovaultTagIds: ['tag-post', 'tag-jazz'],
        albumTagIds: [],
        artistTagLabelKeys: [],
      },
    }),
    track('placeholder', {
      extra: { albumTagIds: ['tag-rock'], redundantPlaceholder: true },
    }),
  ]
  const fields = fieldsOf('genre', 'trackTag', 'albumTag', 'artistTag')

  const byField = async (input: Record<string, unknown> = {}) => {
    const device = await open([...tagRows(), ...tracks()], {
      trackFields: fields,
    })
    const rows = await facets(device, input)
    await device.close()
    store = undefined
    return Object.fromEntries(
      ['genre', 'trackTag', 'albumTag', 'artistTag'].map((field) => [
        field,
        Object.fromEntries(counts(rows, field)),
      ]),
    )
  }

  it('counts each level with every visible ancestor', async () => {
    const result = await byField()
    expect(result.albumTag).toEqual({
      rock: 6,
      'indie rock': 2,
      'post-rock': 2,
    })
    expect(result.trackTag).toEqual({
      rock: 3,
      'indie rock': 1,
      'post-rock': 2,
      jazz: 1,
    })
    expect(result.artistTag).toEqual({ drone: 4, electronic: 4 })
  })

  it('counts Tags at Auto as the Auto filter matches', async () => {
    expect((await byField()).genre).toEqual({
      // a and b inherit it; c, d and f have it themselves; e does not inherit it.
      rock: 5,
      'indie rock': 2,
      // c's own tag and f once; d has tags of its own and does not inherit it.
      'post-rock': 2,
      jazz: 1,
      // b, d and e: artist tags count on albums with too few release tags.
      drone: 3,
      electronic: 3,
    })
  })

  it('falls through at Auto when only a track outside the library can decide inheritance', async () => {
    // Without the archived track's Sonovault tags, d (tags of its own)
    // inherits post-rock, which a track outside the library may hold.
    const device = await open(
      [
        ...tagRows(),
        ...tracks().filter((row) => row.id !== 'archived-sonovault'),
      ],
      { trackFields: fields },
    )
    const read = (input: Record<string, unknown>) =>
      device.source.trackFacets(BrowseFacetQuerySchema.parse(input))
    expect(reason(await read({}))).toBe('sonovault-tags')
    expect(reason(await read({ q: 'post' }))).toBe('sonovault-tags')
    // Other locations, and keys with no tag row (drone), are decided.
    expect(reason(await read({ tagLevels: 'track,album,artist' }))).toBe(null)
    expect(reason(await read({ q: 'drone' }))).toBe(null)
  })

  it('counts Tags at each location', async () => {
    const at = async (tagLevels: string) => (await byField({ tagLevels })).genre
    expect(await at('track')).toEqual({
      rock: 3,
      'indie rock': 1,
      'post-rock': 2,
      jazz: 1,
    })
    expect(await at('album')).toEqual({
      rock: 6,
      'indie rock': 2,
      'post-rock': 2,
    })
    expect(await at('artist')).toEqual({ drone: 4, electronic: 4 })
    expect(await at('track,album')).toEqual({
      rock: 6,
      'indie rock': 3,
      'post-rock': 3,
      jazz: 1,
    })
    expect(await at('track,artist')).toEqual({
      rock: 3,
      'indie rock': 1,
      'post-rock': 2,
      jazz: 1,
      drone: 4,
      electronic: 4,
    })
    expect(await at('album,artist')).toEqual({
      rock: 6,
      'indie rock': 2,
      'post-rock': 2,
      drone: 4,
      electronic: 4,
    })
    expect(await at('track,album,artist')).toEqual({
      rock: 6,
      'indie rock': 3,
      'post-rock': 3,
      jazz: 1,
      drone: 4,
      electronic: 4,
    })
  })

  it('labels tag keys by display name and gives visible subtags', async () => {
    const device = await open([...tagRows(), ...tracks()], {
      trackFields: fieldsOf('albumTag'),
    })
    expect(await facets(device)).toEqual([
      {
        field: 'albumTag',
        value: 'rock',
        count: 6,
        subtags: 2,
        label: `Album tags: ${formatTagName('rock')}`,
      },
      {
        field: 'albumTag',
        value: 'indie rock',
        count: 2,
        label: 'Album tags: Indie Rock',
      },
      {
        field: 'albumTag',
        value: 'post-rock',
        count: 2,
        label: `Album tags: ${formatTagName('post-rock')}`,
      },
    ])
  })

  it('matches typed words against tag keys, dropping words in the field label', async () => {
    const rock = await byField({ q: 'ROC' })
    expect(rock.albumTag).toEqual({ rock: 6, 'indie rock': 2, 'post-rock': 2 })
    expect(rock.artistTag).toEqual({})
    const album = await byField({ q: 'album elec' })
    expect(album.albumTag).toEqual({})
    expect(album.artistTag).toEqual({})
    const tags = await byField({ q: 'tags: elec' })
    expect(tags.artistTag).toEqual({ electronic: 4 })
    expect(tags.genre).toEqual({ electronic: 3 })
  })

  it('leaves out hidden tags and hidden ancestors, and lists an alias under its own key', async () => {
    const device = await open(
      [
        tag('tag-rock', { name: 'Rock' }),
        tag('tag-grunge', { name: 'Grunge', hidden: true }),
        tag('tag-shoegaze', { name: 'Shoegaze' }),
        tag('tag-dream', { name: 'Dream', hidden: true }),
        tag('tag-alias', { name: 'Rock Music', aliasTargetId: 'tag-rock' }),
        tagKey('grunge', ['rock']),
        tagKey('shoegaze', ['dream', 'rock']),
        track('a', {
          extra: {
            albumTagIds: ['tag-grunge'],
            artistTagLabelKeys: [],
          },
        }),
        track('b', {
          extra: {
            albumTagIds: ['tag-shoegaze'],
            artistTagLabelKeys: [],
          },
        }),
        track('c', {
          extra: { albumTagIds: ['tag-alias'], artistTagLabelKeys: [] },
        }),
      ],
      { trackFields: fieldsOf('albumTag') },
    )
    const rows = await facets(device)
    expect(rows.map((row) => [row.value, row.count, row.subtags])).toEqual([
      ['rock', 1, 1],
      ['rock music', 1, undefined],
      ['shoegaze', 1, undefined],
    ])
  })
})

describe('falling through', () => {
  it('leaves other catalog scopes to the API', async () => {
    const device = await open([track('a')])
    expect(
      reason(
        await device.source.trackFacets(
          BrowseFacetQuerySchema.parse({ libraryScope: 'all' }),
        ),
      ),
    ).toBe('catalog-scope')
  })

  it('leaves a text field it has no values for to the API', async () => {
    const device = await open([track('a')], {
      trackFields: [
        ...fieldsOf('title'),
        { key: 'mood', label: 'Mood', type: 'text', filterable: true },
      ],
    })
    expect(
      reason(await device.source.trackFacets(BrowseFacetQuerySchema.parse({}))),
    ).toBe('unknown-field')
    await device.close()
    const unfiltered = await open([track('a')], {
      trackFields: [
        ...fieldsOf('title'),
        { key: 'mood', label: 'Mood', type: 'text', filterable: false },
      ],
    })
    expect(counts(await facets(unfiltered), 'title')).toEqual([['Track a', 1]])
  })

  it('waits for the provider names before suggesting providers', async () => {
    const device = await open([track('a')], {
      trackFields: fieldsOf('provider'),
    })
    expect(
      reason(await device.source.trackFacets(BrowseFacetQuerySchema.parse({}))),
    ).toBe('not-ready')
  })

  it('answers nothing before the first fill', async () => {
    const device = await open([track('a')], { ready: false })
    expect(
      reason(await device.source.trackFacets(BrowseFacetQuerySchema.parse({}))),
    ).toBe('not-ready')
  })
})
