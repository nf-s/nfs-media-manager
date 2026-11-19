import { describe, expect, it } from 'vitest'
import {
  AiMixInterpretedPlanSchema,
  AiMixPlanSchema,
  AiSubscriptionInterpretedPlanSchema,
  AiSubscriptionPlanSchema,
  AiSearchInputSchema,
  aiMixBrowseQuery,
  aiSubscriptionBrowseQuery,
  type AiMixPlan,
  type AiSubscriptionPlan,
} from '../src/ai-search'
import { ArtistDetailSchema, ArtistMixQuerySchema } from '../src/creators'
import {
  SPOTIFY_PODCAST_SYNC_TASK,
  SUBSCRIPTION_SYNC_TASKS,
  SubscriptionDaySchema,
  SubscriptionFacetQuerySchema,
  SubscriptionItemParamsSchema,
  SubscriptionItemPatchSchema,
  SubscriptionItemQuerySchema,
  SubscriptionItemSchema,
  SubscriptionLibraryQuerySchema,
  SubscriptionSourceIdSchema,
  SubscriptionSourceQuerySchema,
  SubscriptionSourceSchema,
  SubscriptionSyncParamsSchema,
  getSubscriptionBrowseValues,
  mixBrowseFields,
  subscriptionBrowseFields,
  subscriptionBrowseFieldsFor,
  subscriptionItemUrl,
  subscriptionLibraryOf,
  subscriptionLibraryTypes,
  subscriptionSourceUrl,
} from '../src/subscriptions'

const CHANNEL = 'UCabcdefghijklmnopqrstuv'
const VIDEO = 'abcdefghijk'
const SHOW = 'ShowFixture00000000001'
const EPISODE = 'EpisodeFixture00000001'
const MIX_SHOW = 'nts.synthetic-show'
const MIX = 'nts.synthetic-show-2026-03-01'

const shared = {
  sourceTitle: 'Synthetic Source',
  sourceThumbnailUrl: null,
  title: 'Synthetic item',
  description: '',
  tags: ['fixture'],
  publishedAt: '2026-03-01T00:00:00.000Z',
  publishedPrecision: 'day',
  durationSec: 1800,
}

describe('subscription identifiers', () => {
  it('accepts each provider’s own ID format', () => {
    expect(SubscriptionSourceIdSchema.safeParse(CHANNEL).success).toBe(true)
    expect(SubscriptionSourceIdSchema.safeParse(SHOW).success).toBe(true)
    for (const id of [VIDEO, EPISODE])
      expect(SubscriptionItemParamsSchema.safeParse({ id }).success).toBe(true)
    for (const id of ['', 'short', `${EPISODE}x`, 'Episode-Fixture-000001'])
      expect(SubscriptionItemParamsSchema.safeParse({ id }).success).toBe(false)
  })

  it('ties each item ID to its type', () => {
    expect(
      SubscriptionItemSchema.parse({
        type: 'spotify',
        id: EPISODE,
        sourceId: SHOW,
        ...shared,
        url: subscriptionItemUrl('spotify', EPISODE),
        artworkUrl: null,
      }),
    ).toMatchObject({ type: 'spotify', id: EPISODE })
    expect(
      SubscriptionItemSchema.safeParse({
        type: 'youtube',
        id: EPISODE,
        sourceId: SHOW,
        ...shared,
        url: subscriptionItemUrl('youtube', EPISODE),
        viewCount: null,
        likeCount: null,
        commentCount: null,
        live: 'none',
      }).success,
    ).toBe(false)
    expect(subscriptionItemUrl('spotify', EPISODE)).toBe(
      `https://open.spotify.com/episode/${EPISODE}`,
    )
    expect(subscriptionSourceUrl('youtube', CHANNEL)).toBe(
      `https://www.youtube.com/channel/${CHANNEL}`,
    )
  })

  it('accepts only the two providers in sync paths', () => {
    expect(SubscriptionSyncParamsSchema.parse({ provider: 'spotify' })).toEqual(
      { provider: 'spotify' },
    )
    expect(
      SubscriptionSyncParamsSchema.safeParse({ provider: 'lastfm' }).success,
    ).toBe(false)
    expect(SUBSCRIPTION_SYNC_TASKS).toEqual([
      'youtube-subscription-sync',
      SPOTIFY_PODCAST_SYNC_TASK,
    ])
  })
})

describe('subscription item query', () => {
  it('defaults to the Subscriptions library, every field, descending and no sort', () => {
    expect(SubscriptionItemQuerySchema.parse({})).toEqual({
      library: 'subscriptions',
      fields: 'all',
      filters: [],
      ranges: [],
      direction: 'desc',
      page: 1,
      size: 24,
    })
  })

  it('accepts UTC days only as YYYY-MM-DD', () => {
    expect(SubscriptionDaySchema.safeParse('2026-02-28').success).toBe(true)
    for (const value of ['2026-1-1', '2026-13-40', 'yesterday', ''])
      expect(SubscriptionDaySchema.safeParse(value).success).toBe(false)
  })

  it('reads JSON filters and ranges from URL values', () => {
    const filters = [
      { field: 'source', value: 'Synthetic Source', mode: 'any' },
      { field: 'type', value: 'Podcast', mode: 'required' },
      { field: 'tag', value: 'fixture', mode: 'exclude' },
      { field: 'title', value: 'Synthetic item' },
    ]
    const ranges = [
      { field: 'publishedAt', min: 0, max: 1 },
      { field: 'durationSec', min: 60, includeMissing: true },
      { field: 'viewCount', max: 10 },
    ]
    expect(
      SubscriptionItemQuerySchema.parse({
        q: ' orbit ',
        fields: 'title',
        filters: JSON.stringify(filters),
        ranges: JSON.stringify(ranges),
        sortBy: 'commentCount',
        direction: 'asc',
        page: '2',
        size: '100',
      }),
    ).toEqual({
      library: 'subscriptions',
      q: 'orbit',
      fields: 'title',
      filters: [
        filters[0],
        filters[1],
        { field: 'genre', value: 'fixture', mode: 'exclude' },
        filters[3],
      ],
      ranges: [
        { ...ranges[0], includeMissing: false },
        ranges[1],
        { ...ranges[2], includeMissing: false },
      ],
      sortBy: 'commentCount',
      direction: 'asc',
      page: 2,
      size: 100,
    })
  })

  it.each([
    { filters: JSON.stringify([{ field: 'description', value: 'x' }]) },
    { filters: JSON.stringify([{ field: 'artist', value: 'x' }]) },
    { filters: 'not json' },
    { ranges: JSON.stringify([{ field: 'title', min: 1 }]) },
    { ranges: JSON.stringify([{ field: 'scrobbles', min: 1 }]) },
    { ranges: JSON.stringify([{ field: 'viewCount', min: 2, max: 1 }]) },
    { sortBy: 'type' },
    { sortBy: 'dateAdded' },
    { q: 'x'.repeat(201) },
    { size: '101' },
  ])('rejects $filters$ranges$sortBy outside the allowed fields', (input) => {
    expect(SubscriptionItemQuerySchema.safeParse(input).success).toBe(false)
  })

  it('describes every filter and range field with a browse field', () => {
    const keys = subscriptionBrowseFields.map((field) => field.key)
    for (const key of ['title', 'source', 'type', 'genre', 'publishedAt'])
      expect(keys).toContain(key)
    expect(
      subscriptionBrowseFields.find((field) => field.key === 'source')?.label,
    ).toBe('Channel')
    expect(
      subscriptionBrowseFields.find((field) => field.key === 'description')
        ?.filterable,
    ).toBe(false)
  })

  it('gives podcast episodes no counts', () => {
    expect(
      getSubscriptionBrowseValues({
        type: 'spotify',
        id: EPISODE,
        sourceId: SHOW,
        ...shared,
        publishedPrecision: 'day',
        url: subscriptionItemUrl('spotify', EPISODE),
        artworkUrl: null,
        watchedAt: null,
      }),
    ).toMatchObject({
      type: 'Podcast',
      source: 'Synthetic Source',
      genre: ['fixture'],
      publishedAt: Date.parse('2026-03-01T00:00:00.000Z'),
      viewCount: null,
      watched: 'No',
      watchedAt: null,
    })
  })

  it('reads the watched date as Watched Yes or No and a date range in epoch milliseconds', () => {
    const item = SubscriptionItemSchema.parse({
      type: 'spotify',
      id: EPISODE,
      sourceId: SHOW,
      ...shared,
      url: subscriptionItemUrl('spotify', EPISODE),
      artworkUrl: null,
      watchedAt: '2026-09-21T18:30:00.000Z',
    })
    expect(getSubscriptionBrowseValues(item)).toMatchObject({
      watched: 'Yes',
      watchedAt: Date.parse('2026-09-21T18:30:00.000Z'),
    })
    expect(
      SubscriptionItemSchema.parse({ ...item, watchedAt: undefined }).watchedAt,
    ).toBeNull()
    expect(
      subscriptionBrowseFields
        .filter((field) => field.key.startsWith('watched'))
        .map(({ key, label, type }) => ({ key, label, type })),
    ).toEqual([
      { key: 'watched', label: 'Watched', type: 'text' },
      { key: 'watchedAt', label: 'Watched', type: 'date' },
    ])
    expect(
      SubscriptionItemQuerySchema.parse({
        filters: JSON.stringify([{ field: 'watched', value: 'No' }]),
        ranges: JSON.stringify([{ field: 'watchedAt', min: 0 }]),
        sortBy: 'watchedAt',
      }),
    ).toMatchObject({
      filters: [{ field: 'watched', value: 'No' }],
      ranges: [{ field: 'watchedAt', min: 0 }],
      sortBy: 'watchedAt',
    })
  })

  it('sets or clears the watched date and nothing else', () => {
    const watchedAt = '2026-09-21T18:30:00.000Z'
    expect(SubscriptionItemPatchSchema.parse({ watchedAt })).toEqual({
      watchedAt,
    })
    expect(SubscriptionItemPatchSchema.parse({ watchedAt: null })).toEqual({
      watchedAt: null,
    })
    for (const input of [
      {},
      { watchedAt: '2026-09-21' },
      { watchedAt, title: 'Changed' },
    ])
      expect(SubscriptionItemPatchSchema.safeParse(input).success).toBe(false)
  })
})

describe('AI subscription plan', () => {
  const plan: AiSubscriptionPlan = {
    q: 'orbit',
    fields: 'all',
    types: ['spotify'],
    publishedFrom: '2026-01-01',
    publishedTo: '2026-01-31',
    durationMinSec: 1201,
    durationMaxSec: null,
    sortBy: 'relevance',
    direction: 'desc',
    sources: [
      { id: SHOW, type: 'spotify', title: 'Synthetic Source' },
      { id: CHANNEL, type: 'youtube', title: 'Other Source' },
    ],
  }

  it('is a library of the AI search input', () => {
    expect(
      AiSearchInputSchema.parse({ mediaType: 'subscription', text: 'x' }),
    ).toEqual({ mediaType: 'subscription', text: 'x' })
    expect(AiSubscriptionPlanSchema.parse(plan)).toEqual(plan)
    const { sources, ...interpreted } = plan
    expect(sources).toHaveLength(2)
    expect(
      AiSubscriptionInterpretedPlanSchema.safeParse({
        ...interpreted,
        sourceNames: ['Synthetic Source'],
      }).success,
    ).toBe(true)
  })

  it('becomes the browse filters and inclusive UTC ranges of the page', () => {
    expect(aiSubscriptionBrowseQuery(plan)).toEqual({
      q: 'orbit',
      fields: 'all',
      filters: [
        { field: 'source', value: 'Synthetic Source', mode: 'any' },
        { field: 'source', value: 'Other Source', mode: 'any' },
        { field: 'type', value: 'Podcast', mode: 'required' },
      ],
      ranges: [
        {
          field: 'publishedAt',
          min: Date.parse('2026-01-01T00:00:00.000Z'),
          max: Date.parse('2026-01-31T23:59:59.999Z'),
          includeMissing: false,
        },
        { field: 'durationSec', min: 1201, includeMissing: false },
      ],
      sortBy: 'relevance',
      direction: 'desc',
    })
    // Both types, or none, is no type filter.
    expect(
      aiSubscriptionBrowseQuery({
        ...plan,
        types: ['youtube', 'spotify'],
        sources: [],
        publishedFrom: null,
        publishedTo: null,
        durationMinSec: null,
      }),
    ).toMatchObject({ filters: [], ranges: [] })
  })

  it.each([
    { sourceNames: [], channelNames: [] },
    { sourceNames: [], types: ['film'] },
    { sourceNames: [], sortBy: 'scrobbles' },
    { sourceNames: [], durationMinSec: -1 },
    { sourceNames: [], publishedFrom: '2026-13-01' },
  ])('rejects plans outside the contract', (overrides) => {
    const { sources, ...rest } = plan
    expect(sources).toHaveLength(2)
    expect(
      AiSubscriptionInterpretedPlanSchema.safeParse({ ...rest, ...overrides })
        .success,
    ).toBe(false)
  })
})

describe('Mixes library', () => {
  const mix = {
    type: 'nts',
    id: MIX,
    sourceId: MIX_SHOW,
    ...shared,
    url: 'https://www.nts.live/shows/synthetic-show/episodes/2026-03-01',
    artworkUrl: 'https://media.example/synthetic.jpg',
    artists: ['Synthetic DJ', 'Second Guest'],
    audioUrl: 'https://audio.example/synthetic.mp3',
  }

  it('puts station rows in Mixes and provider rows in Subscriptions', () => {
    expect(subscriptionLibraryTypes).toEqual({
      subscriptions: ['youtube', 'spotify'],
      mixes: ['rinse', 'nts', 'lotradio'],
    })
    for (const type of subscriptionLibraryTypes.mixes)
      expect(subscriptionLibraryOf(type)).toBe('mixes')
    for (const type of subscriptionLibraryTypes.subscriptions)
      expect(subscriptionLibraryOf(type)).toBe('subscriptions')
    expect(SubscriptionItemParamsSchema.safeParse({ id: MIX }).success).toBe(
      true,
    )
    expect(SubscriptionSourceIdSchema.safeParse(MIX_SHOW).success).toBe(true)
    expect(
      SubscriptionItemParamsSchema.safeParse({ id: 'bbc.show-1' }).success,
    ).toBe(false)
  })

  it('maps a mix with its stored addresses, billed artists and no library artists by default', () => {
    expect(SubscriptionItemSchema.parse(mix)).toEqual({
      ...mix,
      watchedAt: null,
      libraryArtists: [],
    })
    expect(
      SubscriptionItemSchema.safeParse({ ...mix, type: 'youtube' }).success,
    ).toBe(false)
    expect(subscriptionItemUrl('nts', MIX, mix.url)).toBe(mix.url)
    expect(subscriptionItemUrl('rinse', 'rinse.x', null)).toBe(
      'https://www.rinse.fm',
    )
    expect(subscriptionItemUrl('youtube', VIDEO, 'https://other.example')).toBe(
      `https://www.youtube.com/watch?v=${VIDEO}`,
    )
    expect(
      SubscriptionSourceSchema.parse({
        type: 'lotradio',
        id: 'lotradio.synthetic',
        title: 'Synthetic Show',
        description: null,
        thumbnailUrl: null,
        url: subscriptionSourceUrl('lotradio', 'lotradio.synthetic', null),
        storedItems: 1,
        latestItemAt: null,
        historyComplete: true,
        itemTotal: null,
      }),
    ).toMatchObject({ url: 'https://www.thelotradio.com' })
  })

  it('reads a mix as its station label and billed artists, without counts', () => {
    expect(
      getSubscriptionBrowseValues(SubscriptionItemSchema.parse(mix)),
    ).toMatchObject({
      type: 'NTS',
      source: 'Synthetic Source',
      artist: ['Synthetic DJ', 'Second Guest'],
      genre: ['fixture'],
      viewCount: null,
      watched: 'No',
    })
  })

  it('names the shared fields as Mixes and has artists but no counts', () => {
    expect(subscriptionBrowseFieldsFor('mixes')).toBe(mixBrowseFields)
    expect(subscriptionBrowseFieldsFor('subscriptions')).toBe(
      subscriptionBrowseFields,
    )
    expect(
      Object.fromEntries(
        mixBrowseFields.map((field) => [`${field.key}`, field.label]),
      ),
    ).toEqual({
      title: 'Title',
      source: 'Show',
      type: 'Station',
      artist: 'Artist',
      genre: 'Tags',
      description: 'Description',
      publishedAt: 'Broadcast',
      durationSec: 'Duration',
      watched: 'Listened',
      watchedAt: 'Listened',
    })
  })

  it('accepts the Mixes filters, ranges and sorts', () => {
    expect(
      SubscriptionItemQuerySchema.parse({
        library: 'mixes',
        filters: JSON.stringify([
          { field: 'artist', value: 'Synthetic DJ', mode: 'required' },
          { field: 'type', value: 'NTS' },
          { field: 'genre', value: 'house', mode: 'exclude' },
          { field: 'watched', value: 'No' },
        ]),
        ranges: JSON.stringify([
          { field: 'publishedAt', min: 0 },
          { field: 'durationSec', max: 3600, includeMissing: true },
          { field: 'watchedAt', min: 0 },
        ]),
        sortBy: 'durationSec',
      }),
    ).toMatchObject({
      library: 'mixes',
      filters: [
        { field: 'artist', value: 'Synthetic DJ', mode: 'required' },
        { field: 'type', value: 'NTS' },
        { field: 'genre', value: 'house', mode: 'exclude' },
        { field: 'watched', value: 'No' },
      ],
      sortBy: 'durationSec',
    })
  })

  it.each([
    { library: 'films' },
    { library: 'mixes', ranges: JSON.stringify([{ field: 'viewCount' }]) },
    {
      library: 'mixes',
      ranges: JSON.stringify([{ field: 'commentCount', min: 1 }]),
    },
    { library: 'mixes', sortBy: 'likeCount' },
    {
      library: 'subscriptions',
      filters: JSON.stringify([{ field: 'artist', value: 'x' }]),
    },
  ])(
    'rejects fields outside the library: $library $ranges$sortBy$filters',
    (input) => {
      expect(SubscriptionItemQuerySchema.safeParse(input).success).toBe(false)
    },
  )

  it('scopes sources, facets and fields to one library', () => {
    expect(SubscriptionSourceQuerySchema.parse({})).toEqual({
      library: 'subscriptions',
    })
    expect(
      SubscriptionSourceQuerySchema.parse({ library: 'mixes', type: 'nts' }),
    ).toEqual({ library: 'mixes', type: 'nts' })
    expect(
      SubscriptionSourceQuerySchema.safeParse({ type: 'nts' }).success,
    ).toBe(false)
    expect(
      SubscriptionSourceQuerySchema.safeParse({
        library: 'mixes',
        type: 'youtube',
      }).success,
    ).toBe(false)
    expect(SubscriptionFacetQuerySchema.parse({ q: 'house' })).toEqual({
      q: 'house',
      limitPerField: 25,
      library: 'subscriptions',
    })
    expect(
      SubscriptionFacetQuerySchema.parse({ library: 'mixes' }).library,
    ).toBe('mixes')
    expect(
      SubscriptionLibraryQuerySchema.safeParse({ library: 'x' }).success,
    ).toBe(false)
  })

  it('pages an artist’s mixes newest first by default', () => {
    expect(ArtistMixQuerySchema.parse({})).toEqual({
      page: 1,
      size: 24,
      sortBy: 'publishedAt',
      direction: 'desc',
    })
    for (const sortBy of ['title', 'source', 'durationSec', 'watchedAt'])
      expect(ArtistMixQuerySchema.safeParse({ sortBy }).success).toBe(true)
    for (const sortBy of ['relevance', 'viewCount', 'name'])
      expect(ArtistMixQuerySchema.safeParse({ sortBy }).success).toBe(false)
    expect(ArtistDetailSchema.shape.mixCount.parse(undefined)).toBe(0)
  })
})

describe('AI mix plan', () => {
  const plan: AiMixPlan = {
    q: 'warehouse',
    fields: 'all',
    stations: ['nts'],
    filters: [
      { field: 'artist', value: 'Synthetic DJ', mode: 'required' },
      { field: 'genre', value: 'house', mode: 'any' },
    ],
    publishedFrom: '2026-01-01',
    publishedTo: null,
    durationMinSec: 3601,
    durationMaxSec: null,
    sortBy: 'relevance',
    direction: 'desc',
    sources: [{ id: MIX_SHOW, type: 'nts', title: 'Synthetic Show' }],
  }

  it('is a library of the AI search input', () => {
    expect(AiSearchInputSchema.parse({ mediaType: 'mix', text: 'x' })).toEqual({
      mediaType: 'mix',
      text: 'x',
    })
    expect(AiMixPlanSchema.parse(plan)).toEqual(plan)
    const { sources, ...interpreted } = plan
    expect(sources).toHaveLength(1)
    expect(
      AiMixInterpretedPlanSchema.safeParse({
        ...interpreted,
        sourceNames: ['Synthetic Show'],
      }).success,
    ).toBe(true)
  })

  it('becomes the Mixes browse filters with stations, artists and tags', () => {
    expect(aiMixBrowseQuery(plan)).toEqual({
      q: 'warehouse',
      fields: 'all',
      filters: [
        { field: 'source', value: 'Synthetic Show', mode: 'any' },
        { field: 'type', value: 'NTS', mode: 'required' },
        { field: 'artist', value: 'Synthetic DJ', mode: 'required' },
        { field: 'genre', value: 'house', mode: 'any' },
      ],
      ranges: [
        {
          field: 'publishedAt',
          min: Date.parse('2026-01-01T00:00:00.000Z'),
          includeMissing: false,
        },
        { field: 'durationSec', min: 3601, includeMissing: false },
      ],
      sortBy: 'relevance',
      direction: 'desc',
    })
    // Two stations exclude the third, so the any-of group stays the shows'.
    expect(
      aiMixBrowseQuery({
        ...plan,
        stations: ['rinse', 'lotradio'],
        filters: [],
        sources: [],
      }).filters,
    ).toEqual([{ field: 'type', value: 'NTS', mode: 'exclude' }])
    for (const stations of [[], ['rinse', 'nts', 'lotradio']] as const)
      expect(
        aiMixBrowseQuery({
          ...plan,
          stations: [...stations],
          filters: [],
          sources: [],
        }).filters,
      ).toEqual([])
  })

  it.each([
    { stations: ['youtube'] },
    { sortBy: 'viewCount' },
    { filters: [{ field: 'source', value: 'x', mode: 'any' }] },
    { filters: [{ field: 'artist', value: 'x' }] },
    { types: [] },
  ])('rejects mix plans outside the contract: %o', (overrides) => {
    const { sources, ...rest } = plan
    expect(sources).toHaveLength(1)
    expect(
      AiMixInterpretedPlanSchema.safeParse({
        ...rest,
        sourceNames: [],
        ...overrides,
      }).success,
    ).toBe(false)
  })

  it('keeps stations and station shows out of Subscriptions plans', () => {
    expect(
      AiMixPlanSchema.safeParse({
        ...plan,
        sources: [{ id: CHANNEL, type: 'youtube', title: 'Channel' }],
      }).success,
    ).toBe(false)
    expect(
      AiSubscriptionPlanSchema.safeParse({
        q: '',
        fields: 'all',
        types: ['nts'],
        publishedFrom: null,
        publishedTo: null,
        durationMinSec: null,
        durationMaxSec: null,
        sortBy: 'publishedAt',
        direction: 'desc',
        sources: [],
      }).success,
    ).toBe(false)
    expect(
      AiSubscriptionPlanSchema.safeParse({
        q: '',
        fields: 'all',
        types: [],
        publishedFrom: null,
        publishedTo: null,
        durationMinSec: null,
        durationMaxSec: null,
        sortBy: 'publishedAt',
        direction: 'desc',
        sources: [{ id: MIX_SHOW, type: 'nts', title: 'Synthetic Show' }],
      }).success,
    ).toBe(false)
  })
})
