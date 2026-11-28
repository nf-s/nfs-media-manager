import { afterEach, describe, expect, it } from 'vitest'
import { trackBrowseFields } from '@repo/schemas/browse'
import { AlbumQuerySchema } from '@repo/schemas/media'
import { foldText } from '../src/fold'
import {
  FIXED_NOW,
  openDeviceStore,
  pageIds,
  positionsQuery,
  reason,
  served,
  totalCount,
  trackQuery,
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

/** Synthetic rows only: every name, ID and time below is invented. */

const DAY_US = 86_400_000_000
const BASE_US = 1_700_000_000_000_000

function track(id: string, patch: TrackRowPatch = {}): StoreRow {
  return { entity: 'track', id, payload: trackRow(id, patch) }
}

/** A track whose title, title text and title sort agree. */
function titled(
  id: string,
  title: string,
  patch: TrackRowPatch = {},
): StoreRow {
  return track(id, {
    ...patch,
    item: { title, ...patch.item },
    text: { title: [title], ...patch.text },
    sort: { title: foldText(title), ...patch.sort },
  })
}

/** A track added `day` days after the base date. */
function addedOn(day: number, patch: TrackRowPatch = {}) {
  const dateAdded = BASE_US + day * DAY_US
  return {
    ...patch,
    item: {
      dateAdded: new Date(dateAdded / 1000).toISOString(),
      ...patch.item,
    },
    num: { dateAdded, ...patch.num },
  }
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

function plays(nameId: string, times: number[]): StoreRow {
  return { entity: 'scrobble_name', id: nameId, payload: { plays: times } }
}

function seconds(iso: string): number {
  return Date.parse(iso) / 1000
}

const sorted = (ids: string[]) => [...ids].sort()

let store: DeviceStore | undefined

async function open(rows: StoreRow[], options: StoreOptions = {}) {
  store = await openDeviceStore(rows, options)
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

describe('visibility', () => {
  const rows = () => [
    track('normal', addedOn(3, { text: { source: ['Album track list'] } })),
    track('archived', addedOn(2, { extra: { archived: true } })),
    track(
      'placeholder',
      addedOn(1, {
        text: { source: ['Last.fm'], playlist: ['Morning'] },
        extra: { redundantPlaceholder: true },
      }),
    ),
  ]

  it('hides archived tracks and redundant Last.fm placeholders', async () => {
    const device = await open(rows())
    expect(await pageIds(device)).toEqual(['normal'])
    expect(await totalCount(device)).toBe(1)
  })

  it('shows placeholders for a Last.fm source filter that is not an exclude', async () => {
    const device = await open(rows())
    const lastfm = { field: 'source', value: 'LAST.FM' }
    expect(await pageIds(device, { filters: [lastfm] })).toEqual([
      'placeholder',
    ])
    expect(
      await pageIds(device, {
        filters: [{ ...lastfm, mode: 'required' }],
      }),
    ).toEqual(['placeholder'])
    expect(
      await pageIds(device, { filters: [{ ...lastfm, mode: 'exclude' }] }),
    ).toEqual(['normal'])
  })

  it('shows placeholders for a required playlist filter only', async () => {
    const device = await open(rows())
    const playlist = { field: 'playlist', value: 'morning' }
    expect(await pageIds(device, { filters: [playlist] })).toEqual([])
    expect(
      await pageIds(device, { filters: [{ ...playlist, mode: 'required' }] }),
    ).toEqual(['placeholder'])
  })

  it('counts placeholders in unfilteredCount when the query asks for Last.fm rows', async () => {
    const device = await open(rows())
    expect(
      served(
        await device.source.trackCount(
          trackQuery({ filters: [{ field: 'source', value: 'Last.fm' }] }),
        ),
      ),
    ).toEqual({ totalCount: 1, unfilteredCount: 2 })
    expect(
      served(
        await device.source.trackCount(
          trackQuery({
            filters: [{ field: 'artist', value: 'Example Artist' }],
          }),
        ),
      ),
    ).toEqual({ totalCount: 1, unfilteredCount: 1 })
  })
})

describe('filters', () => {
  const rows = () => [
    titled('a', 'Alpha', {
      text: { artist: ['Ann'], playlist: ['Morning'], album: ['Blue'] },
    }),
    titled('b', 'Beta', {
      text: { artist: ['Bob'], playlist: ['Evening'], album: ['Blue'] },
    }),
    titled('c', 'Gamma', {
      text: { artist: ['Ann'], playlist: [], album: ['Red'] },
    }),
    titled('d', 'İstanbul', { text: { artist: ['Cem'], album: [] } }),
  ]
  const ids = async (filters: unknown[]) =>
    sorted(await pageIds(await open(rows()), { filters }))

  it('compares text case-insensitively as PostgreSQL lower() does', async () => {
    expect(await ids([{ field: 'title', value: 'ALPHA' }])).toEqual(['a'])
    expect(await ids([{ field: 'title', value: 'istanbul' }])).toEqual(['d'])
    expect(await ids([{ field: 'title', value: 'İSTANBUL' }])).toEqual(['d'])
    expect(await ids([{ field: 'title', value: 'alph' }])).toEqual([])
  })

  it('ORs any and unset filters across fields', async () => {
    expect(
      await ids([
        { field: 'title', value: 'Alpha' },
        { field: 'artist', value: 'bob', mode: 'any' },
      ]),
    ).toEqual(['a', 'b'])
    expect(
      await ids([
        { field: 'album', value: 'red' },
        { field: 'album', value: 'blue' },
      ]),
    ).toEqual(['a', 'b', 'c'])
  })

  it('ANDs required filters and the any group', async () => {
    expect(
      await ids([
        { field: 'artist', value: 'Ann', mode: 'required' },
        { field: 'album', value: 'Red', mode: 'required' },
      ]),
    ).toEqual(['c'])
    expect(
      await ids([
        { field: 'artist', value: 'Ann', mode: 'required' },
        { field: 'title', value: 'Alpha' },
        { field: 'title', value: 'Gamma' },
      ]),
    ).toEqual(['a', 'c'])
    expect(
      await ids([
        { field: 'artist', value: 'Ann', mode: 'required' },
        { field: 'title', value: 'Beta' },
      ]),
    ).toEqual([])
  })

  it('negates exclude filters', async () => {
    expect(
      await ids([{ field: 'artist', value: 'ann', mode: 'exclude' }]),
    ).toEqual(['b', 'd'])
    expect(
      await ids([
        { field: 'album', value: 'Blue' },
        { field: 'artist', value: 'Bob', mode: 'exclude' },
      ]),
    ).toEqual(['a'])
  })

  it('matches playlist names', async () => {
    expect(await ids([{ field: 'playlist', value: 'EVENING' }])).toEqual(['b'])
  })
})

describe('field kinds', () => {
  const rows = () => [
    track('plain'),
    track('lastfm', { text: { source: ['Last.fm'] } }),
    track('imported', {
      text: { spotifyMatch: ['Spotify playlist / Liked Songs'] },
    }),
    track('tidal', { text: { provider: ['tidal'] } }),
    track('unlinked', { text: { albumLink: ['Not in library'] } }),
    track('tagged', { extra: { hasOwnTags: true } }),
    track('fiveb', { text: { musicalKey: ['5B'] } }),
  ]
  const ids = async (filters: unknown[]) =>
    sorted(await pageIds(await open(rows()), { filters }))
  const everyId = sorted(rows().map((row) => row.id))

  it('matches a source by its label, as toLowerCase compares it', async () => {
    expect(await ids([{ field: 'source', value: 'last.FM' }])).toEqual([
      'lastfm',
    ])
    expect(await ids([{ field: 'source', value: 'Album Track List' }])).toEqual(
      everyId.filter((id) => id !== 'lastfm'),
    )
    expect(await ids([{ field: 'source', value: 'Somewhere' }])).toEqual([])
  })

  it('matches the Spotify match label, including the spotify import alias', async () => {
    expect(
      await ids([{ field: 'spotifyMatch', value: 'spotify import' }]),
    ).toEqual(['imported'])
  })

  it('serves an exclude Provider filter', async () => {
    expect(
      await ids([{ field: 'provider', value: 'TIDAL', mode: 'exclude' }]),
    ).toEqual(everyId.filter((id) => id !== 'tidal'))
  })

  it('matches the library album label and Has track tags', async () => {
    expect(
      await ids([{ field: 'albumLink', value: 'not in library' }]),
    ).toEqual(['unlinked'])
    expect(await ids([{ field: 'hasTrackTags', value: 'YES' }])).toEqual([
      'tagged',
    ])
    expect(await ids([{ field: 'hasTrackTags', value: 'no' }])).toEqual(
      everyId.filter((id) => id !== 'tagged'),
    )
    expect(await ids([{ field: 'hasTrackTags', value: 'maybe' }])).toEqual([])
  })

  it('parses a musical key in any notation', async () => {
    expect(await ids([{ field: 'musicalKey', value: '5b' }])).toEqual(['fiveb'])
    expect(await ids([{ field: 'musicalKey', value: 'A minor' }])).toEqual(
      everyId.filter((id) => id !== 'fiveb'),
    )
    expect(await ids([{ field: 'musicalKey', value: 'not a key' }])).toEqual([])
  })
})

describe('search', () => {
  const rows = () => [
    titled('s1', 'Night Light', {
      text: { artist: ['Echo Band'], album: ['Glass River'] },
    }),
    titled('s2', 'Morning', {
      text: { artist: ['Night Owls'] },
      search: { trackTag: ['Shoegaze'] },
    }),
    titled('s3', 'İzmir Café', { text: { artist: ['Ö Trio'] } }),
    titled('s4', 'Star*Gazer [Live]', {
      text: { provider: ['nightprovider'], musicalKey: ['9A'] },
    }),
  ]
  const ids = async (q: string) =>
    sorted(await pageIds(await open(rows()), { q }))

  it('needs every word in some searched field', async () => {
    expect(await ids('night')).toEqual(['s1', 's2'])
    expect(await ids('NIGHT light')).toEqual(['s1'])
    expect(await ids('echo glass')).toEqual(['s1'])
    expect(await ids('echo morning')).toEqual([])
    expect(await ids('  night   night ')).toEqual(['s1', 's2'])
  })

  it('reads search values that are not filter text', async () => {
    expect(await ids('GAZE')).toEqual(['s2', 's4'])
    expect(await ids('shoe')).toEqual(['s2'])
  })

  it('folds words as PostgreSQL lower() does, short words included', async () => {
    expect(await ids('İZMİR')).toEqual(['s3'])
    expect(await ids('ca')).toEqual(['s3'])
    expect(await ids('É')).toEqual(['s3'])
    expect(await ids('ö')).toEqual(['s3'])
  })

  it('takes pattern characters literally', async () => {
    expect(await ids('r*g')).toEqual(['s4'])
    expect(await ids('r?g')).toEqual([])
    expect(await ids('[live]')).toEqual(['s4'])
  })

  it('leaves out Provider and Key, and matches computed labels', async () => {
    expect(await ids('nightprovider')).toEqual([])
    expect(await ids('9a')).toEqual([])
    expect(await ids('library')).toEqual(['s1', 's2', 's3', 's4'])
  })
})

describe('ranges', () => {
  const rows = () => [
    track('r1', {
      num: { dateAdded: BASE_US, durationSec: 100, bpm: 120.5 },
      extra: {},
    }),
    track('r2', {
      num: { dateAdded: BASE_US + 1, durationSec: 200, bpm: null },
    }),
    track('r3', {
      num: { dateAdded: BASE_US + 1000, durationSec: null, bpm: null },
    }),
  ]
  const ids = async (range: Record<string, unknown>) =>
    sorted(await pageIds(await open(rows()), { ranges: [range] }))
  const baseMs = BASE_US / 1000

  it('compares millisecond date bounds with microsecond values, inclusively', async () => {
    expect(await ids({ field: 'dateAdded', min: baseMs })).toEqual([
      'r1',
      'r2',
      'r3',
    ])
    expect(await ids({ field: 'dateAdded', max: baseMs })).toEqual(['r1'])
    expect(await ids({ field: 'dateAdded', min: baseMs + 1 })).toEqual(['r3'])
    expect(await ids({ field: 'dateAdded', min: baseMs + 0.001 })).toEqual([
      'r2',
      'r3',
    ])
    expect(await ids({ field: 'dateAdded', max: baseMs + 0.0005 })).toEqual([
      'r1',
    ])
  })

  it('treats missing values with includeMissing', async () => {
    expect(await ids({ field: 'durationSec', min: 150 })).toEqual(['r2'])
    expect(
      await ids({ field: 'durationSec', min: 150, includeMissing: true }),
    ).toEqual(['r2', 'r3'])
    expect(await ids({ field: 'durationSec' })).toEqual(['r1', 'r2'])
    expect(await ids({ field: 'durationSec', includeMissing: true })).toEqual([
      'r1',
      'r2',
      'r3',
    ])
    expect(await ids({ field: 'bpm', min: 120.5, max: 120.5 })).toEqual(['r1'])
    expect(await ids({ field: 'bpm', max: 100, includeMissing: true })).toEqual(
      ['r2', 'r3'],
    )
  })

  it('ranges on the track date and sorts on the album date', async () => {
    const device = await open([
      track('trackFirst', {
        num: { releaseDate: 1_000_000_000_000_000 },
        sort: { releaseDate: 2_000_000_000_000_000 },
      }),
      track('albumFirst', {
        num: { releaseDate: 2_000_000_000_000_000 },
        sort: { releaseDate: 1_000_000_000_000_000 },
      }),
    ])
    expect(
      await pageIds(device, {
        ranges: [{ field: 'releaseDate', min: 1_500_000_000_000 }],
      }),
    ).toEqual(['albumFirst'])
    expect(
      await pageIds(device, { sortBy: 'releaseDate', direction: 'asc' }),
    ).toEqual(['albumFirst', 'trackFirst'])
  })
})

describe('tags', () => {
  const tags = () => [
    tag('tag-amb', { name: 'Ambient', identityKeys: ['ambience'] }),
    tag('tag-dark', { name: 'Dark Ambient' }),
    tag('tag-secret', { name: 'Secret Ambient', hidden: true }),
    tag('tag-chill', { name: 'Chill', aliasTargetId: 'tag-amb' }),
    tag('tag-noise', { name: 'Noise', hidden: true }),
    tag('tag-old', { name: 'Old Noise', aliasTargetId: 'tag-noise' }),
    tag('tag-rock', { name: 'Rock' }),
    tagKey('dark ambient', ['ambient']),
    tagKey('secret ambient', ['ambient']),
  ]
  const tracks = (sonovault: boolean) => [
    track('g1', {
      extra: {
        hasOwnTags: true,
        ownTagIds: ['tag-amb'],
        ownSonovaultTagIds: sonovault ? ['tag-amb'] : [],
        albumTagIds: [],
      },
    }),
    track('g2', { extra: { albumTagIds: ['tag-dark'] } }),
    track('g3', { extra: { ownTagIds: ['tag-secret'], albumTagIds: [] } }),
    track('g4', {
      extra: {
        albumId: null,
        albumReleaseTagCount: null,
        albumTagIds: [],
        artistTagKeys: ['ambient'],
      },
    }),
    track('g5', {
      extra: {
        albumTagIds: ['tag-rock'],
        albumReleaseTagCount: 2,
        artistTagKeys: ['ambient'],
      },
    }),
    track('g6', {
      extra: { hasOwnTags: true, ownTagIds: ['tag-chill'], albumTagIds: [] },
    }),
    track('g7', { extra: { ownTagIds: ['tag-noise'], albumTagIds: [] } }),
    track('g8', {
      extra: {
        hasOwnTags: true,
        ownTagIds: ['tag-rock'],
        albumTagIds: ['tag-amb'],
      },
    }),
  ]
  const ids = async (
    filters: unknown[],
    input: Record<string, unknown> = {},
    sonovault = false,
  ) =>
    sorted(
      await pageIds(await open([...tags(), ...tracks(sonovault)]), {
        filters,
        ...input,
      }),
    )
  const genre = (value: string) => [{ field: 'genre', value }]

  it('matches the tag and its visible descendants at Auto', async () => {
    expect(await ids(genre('ambient'), {}, true)).toEqual(['g1', 'g2', 'g4'])
    expect(await ids(genre('  AMBIENT '), {}, true)).toEqual(['g1', 'g2', 'g4'])
  })

  it('stops inheriting a tag Sonovault uses for a track with tags of its own', async () => {
    expect(await ids(genre('ambient'), {}, true)).toEqual(['g1', 'g2', 'g4'])
    expect(await ids(genre('rock'), {}, true)).toEqual(['g5', 'g8'])
  })

  it('falls through at Auto when only a track outside the library can decide inheritance', async () => {
    // No library track holds Ambient from Sonovault, and g8 has tags of its
    // own and inherits Ambient: a track outside the library may hold it.
    const device = await open([...tags(), ...tracks(false)])
    for (const value of ['ambient', 'Ambience', 'chill'])
      expect(
        reason(
          await device.source.trackPage(trackQuery({ filters: genre(value) })),
        ),
        value,
      ).toBe('sonovault-tags')
    // No track with tags of its own inherits Rock without carrying it.
    expect(await ids(genre('rock'))).toEqual(['g5', 'g8'])
    expect(
      reason(
        await device.source.trackCount(
          trackQuery({ filters: genre('ambient'), tagLevels: 'album' }),
        ),
      ),
    ).toBe(null)
    await device.close()
  })

  it('resolves identity keys and aliases, hidden targets included', async () => {
    expect(await ids(genre('Ambience'), {}, true)).toEqual(['g1', 'g2', 'g4'])
    expect(await ids(genre('chill'), {}, true)).toEqual([
      'g1',
      'g2',
      'g4',
      'g6',
    ])
    expect(await ids(genre('old noise'))).toEqual(['g7'])
  })

  it('matches direct carriers of a hidden tag, but not hidden descendants', async () => {
    expect(await ids(genre('noise'))).toEqual(['g7'])
    expect(await ids(genre('secret ambient'))).toEqual(['g3'])
  })

  it('reads the chosen tag levels', async () => {
    const levels = (tagLevels: string) => ids(genre('ambient'), { tagLevels })
    expect(await levels('track')).toEqual(['g1'])
    expect(await levels('album')).toEqual(['g2', 'g8'])
    expect(await levels('artist')).toEqual(['g4', 'g5'])
    expect(await levels('artist,track')).toEqual(['g1', 'g4', 'g5'])
  })

  it('serves the Track, Album and Artist tag fields', async () => {
    expect(await ids([{ field: 'trackTag', value: 'ambient' }])).toEqual(['g1'])
    expect(await ids([{ field: 'albumTag', value: 'ambient' }])).toEqual([
      'g2',
      'g8',
    ])
    expect(await ids([{ field: 'artistTag', value: 'ambient' }])).toEqual([
      'g4',
      'g5',
    ])
  })

  it('keeps raw artist keys whose canonical label is wanted', async () => {
    const device = await open([
      tag('tag-zed', { name: 'Zed' }),
      tag('tag-src', { name: 'SRC', key: 'src', aliasTargetId: 'tag-zed' }),
      tag('tag-src-plain', { name: 'Src', key: 'src' }),
      tag('tag-pop', { name: 'Pop', identityKeys: ['pop music'] }),
      track('zed', { extra: { artistTagKeys: ['zed'] } }),
      track('src', { extra: { artistTagKeys: ['src'] } }),
      track('popmusic', { extra: { artistTagKeys: ['pop music'] } }),
      track('drone', { extra: { artistTagKeys: ['drone'] } }),
    ])
    const artistTag = async (value: string) =>
      sorted(
        await pageIds(device, { filters: [{ field: 'artistTag', value }] }),
      )
    expect(await artistTag('zed')).toEqual(['zed'])
    expect(await artistTag('pop')).toEqual(['popmusic'])
    expect(await artistTag('drone')).toEqual(['drone'])
  })
})

describe('sorting', () => {
  /** A primary value per track; t4 ties t1 and comes first by its position. */
  type Values = [
    string | number | null,
    string | number | null,
    string | number | null,
    string | number | null,
  ]
  const ascending = ['t2', 't4', 't1', 't3']
  const descending = ['t4', 't1', 't2', 't3']
  const text: Values = ['b', 'a', null, 'b']
  const number: Values = [2, 1, null, 2]

  const cases: {
    sortBy: string
    values: Values
    patch: (value: string | number | null) => TrackRowPatch
    tagLevels?: string
  }[] = [
    {
      sortBy: 'title',
      values: text,
      patch: (v) => ({ sort: { title: str(v) } }),
    },
    {
      sortBy: 'artist',
      values: text,
      patch: (v) => ({ sort: { artist: str(v) } }),
    },
    {
      sortBy: 'album',
      values: text,
      patch: (v) => ({ sort: { album: str(v) } }),
    },
    {
      sortBy: 'releaseDate',
      values: number,
      patch: (v) => ({ sort: { releaseDate: num(v) } }),
    },
    {
      sortBy: 'dateAdded',
      values: number,
      patch: (v) => ({ num: { dateAdded: num(v) } }),
    },
    {
      sortBy: 'scrobbles',
      values: number,
      patch: (v) => ({ num: { scrobbles: num(v) } }),
    },
    {
      sortBy: 'lastListenedAt',
      values: number,
      patch: (v) => ({ num: { lastListenedAt: num(v) } }),
    },
    {
      sortBy: 'durationSec',
      values: number,
      patch: (v) => ({ num: { durationSec: num(v) } }),
    },
    { sortBy: 'bpm', values: number, patch: (v) => ({ num: { bpm: num(v) } }) },
    {
      sortBy: 'musicalKey',
      values: number,
      patch: (v) => ({ sort: { musicalKey: num(v) } }),
    },
    {
      sortBy: 'genre',
      values: text,
      patch: (v) => ({ sort: { genre: { auto: str(v) } } }),
    },
    {
      sortBy: 'genre',
      tagLevels: 'album,track',
      values: text,
      patch: (v) => ({ sort: { genre: { 'track,album': str(v) } } }),
    },
    {
      sortBy: 'artistTag',
      values: text,
      patch: (v) => ({ sort: { artistTag: str(v) } }),
    },
    {
      sortBy: 'trackTag',
      values: text,
      patch: (v) => ({ sort: { trackTag: str(v) } }),
    },
    {
      sortBy: 'albumTag',
      values: text,
      patch: (v) => ({ sort: { albumTag: str(v) } }),
    },
    {
      sortBy: 'playlist',
      values: text,
      patch: (v) => ({ sort: { playlist: str(v) } }),
    },
    {
      sortBy: 'source',
      values: text,
      patch: (v) => ({ sort: { source: str(v) } }),
    },
    {
      sortBy: 'provider',
      values: text,
      patch: (v) => ({ sort: { provider: str(v) } }),
    },
    {
      sortBy: 'spotifyMatch',
      values: text,
      patch: (v) => ({ sort: { spotifyMatch: str(v) } }),
    },
    {
      sortBy: 'albumLink',
      values: text,
      patch: (v) => ({ sort: { albumLink: str(v) } }),
    },
    {
      sortBy: 'hasTrackTags',
      values: text,
      patch: (v) => ({ sort: { hasTrackTags: str(v) } }),
    },
  ]

  function str(value: string | number | null): string | null {
    return typeof value === 'number' ? String(value) : value
  }
  function num(value: string | number | null): number | null {
    return typeof value === 'string' ? Number(value) : value
  }

  const rowsFor = (testCase: (typeof cases)[number]) =>
    testCase.values.map((value, index) =>
      track(`t${index + 1}`, {
        ...testCase.patch(value),
        sort: {
          ...testCase.patch(value).sort,
          natural: { position: index === 3 ? 1 : 2 },
        },
      }),
    )

  it.each(cases)(
    'orders $sortBy ($tagLevels) in both directions with nulls last',
    async (testCase) => {
      const device = await open(rowsFor(testCase))
      const order = (direction: string) =>
        pageIds(device, {
          sortBy: testCase.sortBy,
          direction,
          tagLevels: testCase.tagLevels,
        })
      expect(await order('asc')).toEqual(ascending)
      expect(await order('desc')).toEqual(
        testCase.sortBy === 'title' ? ['t3', 't4', 't1', 't2'] : descending,
      )
    },
  )

  it('orders text by code point', async () => {
    const device = await open([
      track('upper', { sort: { artist: 'Zed' } }),
      track('lower', { sort: { artist: 'zed' } }),
      track('accent', { sort: { artist: 'éclair' } }),
      track('astral', { sort: { artist: '\u{1F600}' } }),
      track('bmp', { sort: { artist: '～' } }),
    ])
    expect(
      await pageIds(device, { sortBy: 'artist', direction: 'asc' }),
    ).toEqual(['upper', 'lower', 'accent', 'bmp', 'astral'])
  })

  it('breaks ties by the natural order its primary sort chooses, then the ID', async () => {
    const device = await open([
      track('n1', { sort: { natural: { artist: 'b', year: 2000 } } }),
      track('n2', { sort: { natural: { artist: 'a', year: 2001 } } }),
      track('n3', { sort: { natural: { artist: 'a', year: 2001 } } }),
      track('n0', {
        sort: { natural: { artist: 'a', year: 2001 }, title: 'zz' },
      }),
    ])
    expect(await pageIds(device)).toEqual(['n2', 'n3', 'n0', 'n1'])
    expect(await pageIds(device, { sortBy: 'artist' })).toEqual([
      'n1',
      'n2',
      'n3',
      'n0',
    ])
  })

  it('sorts by the scrobbles in a period, the rolling year by default', async () => {
    const device = await open([
      track('quiet', { extra: { scrobbleNameIds: ['name-quiet'] } }),
      track('busy', { extra: { scrobbleNameIds: ['name-busy'] } }),
      track('old', { extra: { scrobbleNameIds: ['name-old'] } }),
      plays('name-quiet', [seconds('2024-06-01T00:00:00Z')]),
      plays('name-busy', [
        seconds('2024-05-01T00:00:00Z'),
        seconds('2024-06-01T00:00:00Z'),
      ]),
      plays('name-old', [
        seconds('2020-01-01T00:00:00Z'),
        seconds('2020-01-02T00:00:00Z'),
        seconds('2020-01-03T00:00:00Z'),
      ]),
    ])
    const page = served(
      await device.source.trackPage(
        trackQuery({ sortBy: 'listeningScrobbles' }),
      ),
    )
    expect(
      page.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['busy', 2],
      ['quiet', 1],
      ['old', 0],
    ])
    const allTime = served(
      await device.source.trackPage(
        trackQuery({
          sortBy: 'listeningScrobbles',
          listeningSort: { kind: 'all' },
          direction: 'asc',
        }),
      ),
    )
    expect(allTime.items.map((item) => item.id)).toEqual([
      'quiet',
      'busy',
      'old',
    ])
  })
})

describe('paging', () => {
  const rows = () =>
    [1, 2, 3, 4, 5].map((day) => track(`p${day}`, addedOn(day)))

  it('reads size + 1 rows for hasMore and stops at limitResults', async () => {
    const device = await open(rows())
    const page = async (input: Record<string, unknown>) => {
      const result = served(await device.source.trackPage(trackQuery(input)))
      return [result.items.map((item) => item.id), result.hasMore]
    }
    expect(await page({ size: 2 })).toEqual([['p5', 'p4'], true])
    expect(await page({ size: 2, page: 3 })).toEqual([['p1'], false])
    expect(await page({ size: 2, page: 2, limitResults: 3 })).toEqual([
      ['p3'],
      false,
    ])
    expect(await page({ size: 2, page: 1, limitResults: 3 })).toEqual([
      ['p5', 'p4'],
      true,
    ])
    expect(await page({ size: 2, page: 3, limitResults: 3 })).toEqual([
      [],
      false,
    ])
  })

  it('answers the paginated list with capped totals', async () => {
    const device = await open(rows())
    const list = served(
      await device.source.trackList(
        trackQuery({ size: 2, page: 2, limitResults: 3 }),
      ),
    )
    expect(list).toMatchObject({
      page: 2,
      size: 2,
      totalCount: 3,
      pageCount: 2,
    })
    expect(list.items.map((item) => item.id)).toEqual(['p3'])
  })

  it('counts with the cap and the unfiltered total', async () => {
    const device = await open(rows())
    const count = async (input: Record<string, unknown>) =>
      served(await device.source.trackCount(trackQuery(input)))
    expect(await count({ limitResults: 3 })).toEqual({
      totalCount: 3,
      unfilteredCount: 5,
    })
    expect(
      await count({
        limitResults: 2,
        ranges: [{ field: 'dateAdded', min: (BASE_US + 2 * DAY_US) / 1000 }],
      }),
    ).toEqual({ totalCount: 2, unfilteredCount: 5 })
  })

  it('reads positions in order, below limitResults', async () => {
    const device = await open(rows())
    const positions = async (input: Record<string, unknown>) =>
      served(
        await device.source.trackPositions(positionsQuery(input)),
      ).items.map((entry) => [entry.position, entry.item.id])
    expect(await positions({ positions: '4,0,2' })).toEqual([
      [0, 'p5'],
      [2, 'p3'],
      [4, 'p1'],
    ])
    expect(await positions({ positions: '4,0,2', limitResults: 3 })).toEqual([
      [0, 'p5'],
      [2, 'p3'],
    ])
    expect(await positions({ positions: '9' })).toEqual([])
  })
})

describe('listening periods', () => {
  const at = (iso: string) => seconds(iso)
  const rows = (times: number[]) => [
    track('listened', { extra: { scrobbleNameIds: ['name-a', 'name-b'] } }),
    track('shared', { extra: { scrobbleNameIds: ['name-b'] } }),
    track('silent', { extra: { scrobbleNameIds: [] } }),
    plays('name-a', times),
    plays('name-b', [at('2001-01-01T00:00:00Z')]),
  ]
  const countIn = async (
    period: Record<string, unknown>,
    times: number[],
    now: Date,
  ) => {
    const device = await open(rows(times), { now })
    const page = served(
      await device.source.trackPage(trackQuery({ listeningSort: period })),
    )
    await device.close()
    store = undefined
    return Object.fromEntries(
      page.items.map((item) => [item.id, item.listeningScrobbles]),
    )
  }

  it('starts a rolling month on the same day and time, clamped to the month end', async () => {
    const now = new Date('2024-03-31T10:20:30.456Z')
    const counts = await countIn(
      { kind: 'rolling', amount: 1, unit: 'months' },
      [
        at('2024-02-29T10:20:30Z'),
        at('2024-02-29T10:20:31Z'),
        at('2024-03-31T10:20:30Z'),
        at('2024-03-31T10:20:31Z'),
      ],
      now,
    )
    expect(counts).toEqual({ listened: 2, shared: 0, silent: 0 })
  })

  it('starts a rolling year in the same month of the year before', async () => {
    const counts = await countIn(
      { kind: 'rolling', amount: 1, unit: 'years' },
      [at('2023-02-28T23:59:59Z'), at('2023-03-01T00:00:00Z')],
      new Date('2024-02-29T23:59:59.999Z'),
    )
    expect(counts.listened).toBe(1)
  })

  it('ends a date period after its last day', async () => {
    const counts = await countIn(
      { kind: 'dates', from: '2024-01-01', to: '2024-12-31' },
      [
        at('2023-12-31T23:59:59Z'),
        at('2024-01-01T00:00:00Z'),
        at('2024-12-31T23:59:59Z'),
        at('2025-01-01T00:00:00Z'),
      ],
      FIXED_NOW,
    )
    expect(counts.listened).toBe(2)
  })

  it('counts every play of every linked name, for each track linked to it', async () => {
    const counts = await countIn(
      { kind: 'all' },
      [at('2024-01-01T00:00:00Z')],
      FIXED_NOW,
    )
    expect(counts).toEqual({ listened: 2, shared: 1, silent: 0 })
  })

  it('filters with rules, ANDed or ORed, and counts absent plays as zero', async () => {
    const device = await open(rows([at('2024-06-01T00:00:00Z')]))
    const ids = async (listening: Record<string, unknown>) =>
      sorted(await pageIds(device, { listening }))
    const recent = { kind: 'rolling', amount: 30, unit: 'days' }
    expect(
      await ids({ match: 'all', rules: [{ period: recent, min: 1 }] }),
    ).toEqual(['listened'])
    expect(
      await ids({ match: 'all', rules: [{ period: { kind: 'all' }, max: 0 }] }),
    ).toEqual(['silent'])
    expect(
      await ids({
        match: 'any',
        rules: [
          { period: recent, min: 1 },
          { period: { kind: 'all' }, min: 1, max: 1 },
        ],
      }),
    ).toEqual(['listened', 'shared'])
    expect(
      await ids({
        match: 'all',
        rules: [
          { period: recent, min: 1 },
          { period: { kind: 'all' }, min: 1, max: 1 },
        ],
      }),
    ).toEqual([])
  })

  it('counts with the rules only, never the sort period', async () => {
    const device = await open(rows([at('2024-06-01T00:00:00Z')]))
    expect(
      served(
        await device.source.trackCount(
          trackQuery({
            sortBy: 'listeningScrobbles',
            listening: {
              match: 'all',
              rules: [{ period: { kind: 'all' }, min: 1 }],
            },
          }),
        ),
      ),
    ).toEqual({ totalCount: 2, unfilteredCount: 3 })
  })
})

describe('grouped recordings', () => {
  const rows = () => [
    track(
      'v1',
      addedOn(5, {
        num: { scrobbles: 4, lastListenedAt: BASE_US + 50 },
        extra: {
          recording: {
            key: 'rec-1',
            shown: false,
            playable: true,
            linked: true,
            releaseDate: 2_000_000_000_000_000,
          },
          scrobbleNameIds: ['name-a'],
        },
      }),
    ),
    track(
      'v2',
      addedOn(3, {
        extra: {
          recording: { key: 'rec-1', shown: true, playable: false },
          scrobbleNameIds: ['name-b'],
        },
      }),
    ),
    track(
      'v3',
      addedOn(9, {
        extra: {
          recording: {
            key: 'rec-1',
            shown: false,
            playable: true,
            linked: true,
            releaseDate: 1_000_000_000_000_000,
          },
          scrobbleNameIds: ['name-a'],
        },
      }),
    ),
    track('s1', addedOn(4, { extra: { scrobbleNameIds: ['name-s'] } })),
    track(
      'w1',
      addedOn(6, {
        num: { scrobbles: 9 },
        extra: { recording: { key: 'rec-2' }, scrobbleNameIds: ['name-c'] },
      }),
    ),
    track(
      'w2',
      addedOn(7, {
        extra: { recording: { key: 'rec-2' }, scrobbleNameIds: ['name-c'] },
      }),
    ),
    plays('name-a', [
      seconds('2024-01-01T00:00:00Z'),
      seconds('2024-01-02T00:00:00Z'),
      seconds('2024-03-01T00:00:00Z'),
    ]),
    plays('name-b', [
      seconds('2024-01-01T00:00:00Z'),
      seconds('2024-04-01T08:30:00Z'),
    ]),
    plays(
      'name-c',
      [1, 2, 3, 4, 5].map((day) => day * 86_400),
    ),
  ]
  const grouped = (input: Record<string, unknown> = {}) => ({
    groupRecordings: true,
    ...input,
  })
  const withoutV2 = {
    filters: [{ field: 'title', value: 'Track v2', mode: 'exclude' }],
  }

  it('shows one row per recording group, by the group value', async () => {
    const device = await open(rows())
    expect(await pageIds(device, grouped())).toEqual(['w1', 's1', 'v2'])
    expect(await totalCount(device, grouped())).toBe(3)
  })

  it('gives a group its version count, earliest addition and scrobbles', async () => {
    const device = await open(rows())
    const items = served(
      await device.source.trackPage(trackQuery(grouped())),
    ).items
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get('v2')).toMatchObject({
      recordingGroup: { versionCount: 3 },
      scrobbles: 5,
      dateAdded: new Date((BASE_US + 3 * DAY_US) / 1000).toISOString(),
      lastListenedAt: '2024-04-01T08:30:00.000Z',
    })
    expect(byId.get('w1')).toMatchObject({
      recordingGroup: { versionCount: 2 },
      scrobbles: 9,
      dateAdded: new Date((BASE_US + 6 * DAY_US) / 1000).toISOString(),
    })
    expect(byId.get('s1')?.recordingGroup).toBeUndefined()
  })

  it('forms groups and their values from the matching versions only', async () => {
    const device = await open(rows())
    const items = served(
      await device.source.trackPage(trackQuery(grouped(withoutV2))),
    ).items
    expect(items.map((item) => item.id)).toEqual(['w1', 'v3', 's1'])
    expect(items[1]).toMatchObject({
      recordingGroup: { versionCount: 2 },
      scrobbles: 4,
      lastListenedAt: new Date((BASE_US + 50) / 1000).toISOString(),
      dateAdded: new Date((BASE_US + 5 * DAY_US) / 1000).toISOString(),
    })
  })

  it('applies date, scrobble and listening ranges to groups', async () => {
    const device = await open(rows())
    const fifthDay = (BASE_US + 5 * DAY_US) / 1000
    expect(
      await pageIds(
        device,
        grouped({ ranges: [{ field: 'dateAdded', min: fifthDay }] }),
      ),
    ).toEqual(['w1'])
    expect(
      await pageIds(
        device,
        grouped({
          ranges: [{ field: 'scrobbles', min: 5 }],
          sortBy: 'scrobbles',
        }),
      ),
    ).toEqual(['w1', 'v2'])
    expect(
      await pageIds(
        device,
        grouped({
          listening: {
            match: 'all',
            rules: [{ period: { kind: 'all' }, min: 4 }],
          },
        }),
      ),
    ).toEqual(['w1', 'v2'])
    expect(
      await totalCount(
        device,
        grouped({ ranges: [{ field: 'dateAdded', min: fifthDay }] }),
      ),
    ).toBe(1)
  })

  it('counts each scrobbled name of a group once in a sort period', async () => {
    const device = await open(rows())
    const items = served(
      await device.source.trackPage(
        trackQuery(
          grouped({
            sortBy: 'listeningScrobbles',
            listeningSort: { kind: 'all' },
          }),
        ),
      ),
    ).items
    expect(items.map((item) => [item.id, item.listeningScrobbles])).toEqual([
      ['v2', 5],
      ['w1', 5],
      ['s1', 0],
    ])
  })

  it('reads grouped positions and the paginated list', async () => {
    const device = await open(rows())
    expect(
      served(
        await device.source.trackPositions(
          positionsQuery(grouped({ positions: '2,0' })),
        ),
      ).items.map((entry) => [entry.position, entry.item.id]),
    ).toEqual([
      [0, 'w1'],
      [2, 'v2'],
    ])
    const list = served(
      await device.source.trackList(trackQuery(grouped({ size: 2 }))),
    )
    expect(list).toMatchObject({ totalCount: 3, pageCount: 2 })
    expect(list.items.map((item) => item.id)).toEqual(['w1', 's1'])
  })

  it('lists the matching versions of a track by their own values', async () => {
    const device = await open(rows())
    const versions = async (id: string, input: Record<string, unknown> = {}) =>
      served(
        await device.source.trackRecordings({ id, query: trackQuery(input) }),
      ).items.map((item) => item.id)
    expect(await versions('v1')).toEqual(['v3', 'v1', 'v2'])
    expect(await versions('v1', withoutV2)).toEqual(['v3', 'v1'])
    expect(await versions('v2', withoutV2)).toEqual([])
    expect(await versions('s1')).toEqual(['s1'])
    expect(
      await versions('v1', {
        ranges: [{ field: 'dateAdded', min: (BASE_US + 4 * DAY_US) / 1000 }],
      }),
    ).toEqual([])
    const page = served(
      await device.source.trackRecordings({
        id: 'v1',
        query: trackQuery({ size: 2 }),
      }),
    )
    expect([page.items.map((item) => item.id), page.hasMore]).toEqual([
      ['v3', 'v1'],
      true,
    ])
    expect(page.items[0]?.recordingGroup).toBeUndefined()
  })
})

describe('reads the device does not serve', () => {
  it('waits for a completed fill and the field list', async () => {
    expect(
      reason(
        await (
          await open([track('a')], { ready: false })
        ).source.trackPage(trackQuery()),
      ),
    ).toBe('not-ready')
    await store?.close()
    expect(
      reason(
        await (
          await open([track('a')], { trackFields: null })
        ).source.trackPage(trackQuery()),
      ),
    ).toBe('not-ready')
  })

  it('reports a failing store', async () => {
    const device = await open([track('a')])
    await device.driver.run("DELETE FROM item_json WHERE entity = 'track'")
    expect(reason(await device.source.trackPage(trackQuery()))).toBe(
      'store-error',
    )
    expect(
      served(await device.source.trackCount(trackQuery())).totalCount,
    ).toBe(1)
    await device.driver.run('DROP TABLE track_name')
    expect(
      reason(
        await device.source.trackPage(
          trackQuery({ sortBy: 'listeningScrobbles' }),
        ),
      ),
    ).toBe('store-error')
  })

  it('leaves catalog scopes other than the library to the API', async () => {
    const device = await open([track('a')])
    const scope = async (input: Record<string, unknown>) =>
      reason(await device.source.trackPage(trackQuery(input)))
    expect(await scope({ libraryScope: 'outside' })).toBe('catalog-scope')
    expect(await scope({ libraryScope: 'all' })).toBe('catalog-scope')
    expect(
      await scope({
        discoverySources: 'spotify-search',
        discoverySourceScope: 'selection',
      }),
    ).toBe('catalog-scope')
    expect(
      await scope({
        discoverySources: 'scrobble',
        discoverySourceScope: 'selection',
      }),
    ).toBeNull()
    expect(await scope({ discoverySources: 'spotify-search' })).toBeNull()
  })

  it('leaves grouped Tracks in a creator scope to the API', async () => {
    const device = await open([track('a')])
    const query = trackQuery({ groupRecordings: 'true', creatorId: 'artist-1' })
    expect(reason(await device.source.trackPage(query))).toBe(
      'grouped-creator-scope',
    )
    expect(
      reason(
        await device.source.trackRecordings({
          id: 'a',
          query: trackQuery({ creatorId: 'artist-1' }),
        }),
      ),
    ).toBe('grouped-creator-scope')
    expect(
      served(
        await device.source.trackCount(
          trackQuery({ creatorId: 'artist-Example Artist' }),
        ),
      ).totalCount,
    ).toBe(1)
  })

  it('serves Provider filters only where the items carry no links', async () => {
    const device = await open([
      track('a', { text: { provider: ['tidal'] } }),
      track('b'),
    ])
    const provider = trackQuery({
      filters: [{ field: 'provider', value: 'Tidal', mode: 'required' }],
    })
    expect(reason(await device.source.trackPage(provider))).toBe(
      'provider-filter',
    )
    expect(reason(await device.source.trackList(provider))).toBe(
      'provider-filter',
    )
    expect(
      reason(await device.source.trackRecordings({ id: 'a', query: provider })),
    ).toBe('provider-filter')
    expect(served(await device.source.trackCount(provider))).toEqual({
      totalCount: 1,
      unfilteredCount: 2,
    })
    expect(
      served(
        await device.source.trackPositions(
          positionsQuery({
            filters: [{ field: 'provider', value: 'tidal' }],
            positions: '0',
          }),
        ),
      ).items.map((entry) => entry.item.id),
    ).toEqual(['a'])
  })

  it('leaves queries the API rejects to it', async () => {
    const device = await open([track('a')])
    const rejected = async (input: Record<string, unknown>) =>
      reason(await device.source.trackPage(trackQuery(input)))
    expect(
      await rejected({ filters: [{ field: 'nothing', value: 'x' }] }),
    ).toBe('invalid-query')
    expect(
      await rejected({ filters: [{ field: 'durationSec', value: '10' }] }),
    ).toBe('invalid-query')
    expect(await rejected({ ranges: [{ field: 'title', min: 1 }] })).toBe(
      'invalid-query',
    )
    expect(
      await rejected({ ranges: [{ field: 'listeningScrobbles', min: 1 }] }),
    ).toBe('invalid-query')
    expect(await rejected({ sortBy: 'nothing' })).toBe('invalid-query')
  })

  it('leaves fields it cannot read to the API', async () => {
    const device = await open([track('a')], {
      trackFields: [
        ...trackBrowseFields,
        { key: 'mood', label: 'Mood', type: 'text', filterable: true },
      ],
    })
    const unknown = async (input: Record<string, unknown>) =>
      reason(await device.source.trackPage(trackQuery(input)))
    expect(await unknown({ filters: [{ field: 'mood', value: 'calm' }] })).toBe(
      'unknown-field',
    )
    expect(await unknown({ sortBy: 'mood' })).toBe('unknown-field')
    expect(await unknown({ q: 'calm' })).toBe('unknown-field')
    expect(await unknown({})).toBeNull()
  })

  it('leaves the Tags sort at Auto in a creator scope or a recordings list to the API', async () => {
    const device = await open([track('a')])
    const creator = { creatorId: 'artist-Example Artist', sortBy: 'genre' }
    expect(reason(await device.source.trackPage(trackQuery(creator)))).toBe(
      'creator-tag-sort',
    )
    expect(
      reason(
        await device.source.trackPage(
          trackQuery({ ...creator, tagLevels: 'album' }),
        ),
      ),
    ).toBeNull()
    expect(
      reason(
        await device.source.trackRecordings({
          id: 'a',
          query: trackQuery({ sortBy: 'genre' }),
        }),
      ),
    ).toBe('creator-tag-sort')
  })

  it('answers other libraries as not ready until they are compiled', async () => {
    const device = await open([track('a')])
    expect(
      reason(await device.source.albumPage(AlbumQuerySchema.parse({}))),
    ).toBe('not-ready')
    expect(served(await device.source.fields('track'))).toEqual(
      trackBrowseFields,
    )
    expect(reason(await device.source.fields('album'))).toBe('not-ready')
  })
})
