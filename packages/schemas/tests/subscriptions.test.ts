import { describe, expect, it } from 'vitest'
import {
  AiSubscriptionInterpretedPlanSchema,
  AiSubscriptionPlanSchema,
  AiSearchInputSchema,
  aiSubscriptionBrowseQuery,
  type AiSubscriptionPlan,
} from '../src/ai-search'
import {
  SPOTIFY_PODCAST_SYNC_TASK,
  SUBSCRIPTION_SYNC_TASKS,
  SubscriptionDaySchema,
  SubscriptionItemParamsSchema,
  SubscriptionItemQuerySchema,
  SubscriptionItemSchema,
  SubscriptionSourceIdSchema,
  SubscriptionSyncParamsSchema,
  getSubscriptionBrowseValues,
  subscriptionBrowseFields,
  subscriptionItemUrl,
  subscriptionSourceUrl,
} from '../src/subscriptions'

const CHANNEL = 'UCabcdefghijklmnopqrstuv'
const VIDEO = 'abcdefghijk'
const SHOW = 'ShowFixture00000000001'
const EPISODE = 'EpisodeFixture00000001'

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
  it('defaults to every field, descending and no sort', () => {
    expect(SubscriptionItemQuerySchema.parse({})).toEqual({
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
      }),
    ).toMatchObject({
      type: 'Podcast',
      source: 'Synthetic Source',
      genre: ['fixture'],
      publishedAt: Date.parse('2026-03-01T00:00:00.000Z'),
      viewCount: null,
    })
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
