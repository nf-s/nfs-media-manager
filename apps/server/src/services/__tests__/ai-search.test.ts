import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_AUDIO_MAX_BYTES,
  AiSearchPlanSchema,
  type AiSearchPlan,
  type AiYoutubeInterpretedPlan,
} from '@repo/schemas/ai-search'

const mocks = vi.hoisted(() => ({
  text: vi.fn(),
  transcribe: vi.fn(),
  available: vi.fn(),
  sync: vi.fn(),
  plugins: vi.fn(),
  database: vi.fn(),
}))
vi.mock('@/lib/workers-ai', () => ({
  runAiText: mocks.text,
  runAiTranscription: mocks.transcribe,
  aiAvailable: mocks.available,
}))
vi.mock('@/services/lastfm-scrobbles', () => ({
  getLastfmSyncStatus: mocks.sync,
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: mocks.plugins,
}))
vi.mock('@/lib/db', () => ({ db: { execute: mocks.database } }))

import {
  aiSearchPrompt,
  aiSearchStatus,
  interpretAiSearch,
  parseAiInterpretation,
  parseAiYoutubeInterpretation,
  transcribeAiAudio,
  validateAiPlan,
  validateAiYoutubePlan,
} from '../ai-search'
import { matchYoutubeChannelName } from '../youtube-channel-names'

const now = new Date('2026-11-13T08:00:00Z')
function plan(overrides: Partial<AiSearchPlan> = {}): AiSearchPlan {
  return {
    q: '',
    filters: [],
    ranges: [],
    sortBy: 'dateAdded',
    direction: 'desc',
    limitResults: null,
    listening: null,
    listeningSort: null,
    ...overrides,
  }
}
function interpretation(search: AiSearchPlan | null = plan()) {
  return {
    plan: search,
    explanation: 'Search the selected library.',
    assumptions: [],
  }
}
function completion(value: unknown, finishReason = 'stop') {
  return {
    choices: [
      {
        message: { content: JSON.stringify(value) },
        finish_reason: finishReason,
      },
    ],
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.available.mockReturnValue(true)
  mocks.sync.mockResolvedValue({
    state: 'complete',
    lastCompletedAt: '2026-11-13T00:00:00Z',
  })
})

describe('AI search interpretation', () => {
  it('keeps recent and earlier listening as separate ANDed periods', async () => {
    const expected = plan({
      listening: {
        match: 'all',
        rules: [
          {
            period: { kind: 'dates', from: '2021-11-13', to: '2026-11-13' },
            max: 10,
          },
          { period: { kind: 'dates', to: '2021-11-12' }, min: 100 },
        ],
      },
    })
    mocks.text.mockResolvedValue(
      completion({
        ...interpretation(expected),
        assumptions: [
          'Not much means at most 10 track scrobbles; a lot means at least 100.',
        ],
      }),
    )
    const response = await interpretAiSearch(
      {
        mediaType: 'album',
        text: 'Albums I used to play a lot but barely played in the last five years',
      },
      now,
    )
    expect(response.plan).toEqual(expected)
    expect(response.assumptions).toHaveLength(1)
    expect(response.warnings).toContainEqual(
      expect.stringContaining('track scrobbles'),
    )
    expect(mocks.sync).toHaveBeenCalledOnce()
  })

  it('combines required rock tags, RYM threshold and little all-time listening', async () => {
    const expected = plan({
      filters: [{ field: 'genre', value: 'Rock', mode: 'required' }],
      ranges: [{ field: 'ratingRymValue', min: 3.5, includeMissing: false }],
      listening: {
        match: 'all',
        rules: [{ period: { kind: 'all' }, min: 1, max: 10 }],
      },
      sortBy: 'ratingRymValue',
    })
    mocks.text.mockResolvedValue({ response: interpretation(expected) })
    const result = await interpretAiSearch(
      {
        mediaType: 'album',
        text: 'Rock albums I have only listened to a little with a high Rate Your Music score',
      },
      now,
    )
    expect(result.plan).toEqual(expected)
    expect(result.warnings).toContainEqual(
      expect.stringContaining('stored metadata'),
    )
  })

  it('sends only static field definitions and the submitted text to the model', async () => {
    mocks.plugins.mockResolvedValue([
      { manifest: { name: 'synthetic-unshared-plugin' } },
    ])
    mocks.database.mockResolvedValue([{ title: 'Synthetic Unshared Album' }])
    mocks.text.mockResolvedValue(completion(interpretation()))
    await interpretAiSearch(
      { mediaType: 'album', text: '  Show albums  ' },
      now,
    )
    expect(mocks.text).toHaveBeenCalledExactlyOnceWith([
      {
        role: 'system',
        content: expect.stringContaining('Today is 2026-11-13'),
      },
      { role: 'user', content: 'Show albums' },
    ])
    const sent = JSON.stringify(mocks.text.mock.calls)
    expect(sent).not.toContain('synthetic-unshared-plugin')
    expect(sent).not.toContain('Synthetic Unshared Album')
    expect(mocks.plugins).not.toHaveBeenCalled()
    expect(mocks.database).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('returns clarification without querying history when no plan is supported', async () => {
    mocks.text.mockResolvedValue({
      response: JSON.stringify({
        plan: null,
        explanation: 'Choose a supported rating source.',
        assumptions: [],
      }),
    })
    expect(
      await interpretAiSearch(
        { mediaType: 'album', text: 'Find albums using an unavailable score' },
        now,
      ),
    ).toEqual({
      plan: null,
      explanation: 'Choose a supported rating source.',
      assumptions: [],
      warnings: [],
    })
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('does not apply a listening plan without a completed history sync', async () => {
    mocks.sync.mockResolvedValue({ state: 'running', lastCompletedAt: null })
    mocks.text.mockResolvedValue(
      completion(
        interpretation(
          plan({
            listening: {
              match: 'all',
              rules: [{ period: { kind: 'all' }, max: 0 }],
            },
          }),
        ),
      ),
    )
    const result = await interpretAiSearch(
      { mediaType: 'album', text: 'Unplayed albums' },
      now,
    )
    expect(result.plan).toBeNull()
    expect(result.explanation).toContain('Complete the Last.fm history sync')
    expect(result.warnings).toContainEqual(
      expect.stringContaining('missing data'),
    )
  })

  it('warns when a previous completed history is stale', async () => {
    mocks.sync.mockResolvedValue({
      state: 'failed',
      lastCompletedAt: '2026-10-01T00:00:00Z',
    })
    const expected = plan({
      sortBy: 'listeningScrobbles',
      listeningSort: { kind: 'rolling', amount: 2, unit: 'years' },
    })
    mocks.text.mockResolvedValue(completion(interpretation(expected)))
    const result = await interpretAiSearch(
      { mediaType: 'album', text: 'Most played over two years' },
      now,
    )
    expect(result.plan).toEqual(expected)
    expect(result.warnings).toContainEqual(
      expect.stringContaining('out of date'),
    )
  })

  it('requires completed history when sorting only by the last listen', async () => {
    mocks.sync.mockResolvedValue({ state: 'running', lastCompletedAt: null })
    mocks.text.mockResolvedValue(
      completion(interpretation(plan({ sortBy: 'lastListenedAt' }))),
    )
    const result = await interpretAiSearch(
      { mediaType: 'album', text: 'Most recently played albums' },
      now,
    )
    expect(result.plan).toBeNull()
    expect(mocks.sync).toHaveBeenCalledOnce()
    expect(result.warnings).toContainEqual(
      expect.stringContaining('missing data'),
    )
  })

  it('warns about stale history when sorting only by the last listen', async () => {
    mocks.sync.mockResolvedValue({
      state: 'complete',
      lastCompletedAt: '2026-10-01T00:00:00Z',
    })
    const expected = plan({ sortBy: 'lastListenedAt' })
    mocks.text.mockResolvedValue(completion(interpretation(expected)))
    const result = await interpretAiSearch(
      { mediaType: 'album', text: 'Most recently played albums' },
      now,
    )
    expect(result.plan).toEqual(expected)
    expect(result.warnings).toContainEqual(
      expect.stringContaining('out of date'),
    )
  })

  it('reports unavailable AI without invoking inference', () => {
    mocks.available.mockReturnValue(false)
    expect(aiSearchStatus()).toEqual({
      available: false,
      reason: 'Cloudflare AI is not configured.',
    })
    expect(mocks.text).not.toHaveBeenCalled()
  })

  it.each([
    { choices: [] },
    { response: '{unfinished' },
    { response: '```json\n{}\n```' },
    { response: { ...interpretation(), sql: 'select 1' } },
    completion(interpretation(), 'length'),
    completion(interpretation(), 'tool_calls'),
    { choices: [{ message: { content: null } }] },
    { response: { ...interpretation(), plan: { ...plan(), sql: 'select 1' } } },
    {
      response: {
        ...interpretation(),
        plan: {
          ...plan(),
          ranges: [{ field: 'ratingRymValue', min: 4, max: 3 }],
        },
      },
    },
  ])('rejects malformed, truncated and injected model responses', (output) => {
    expect(() => parseAiInterpretation(output)).toThrow('unsupported search')
  })

  it.each([
    plan({ sortBy: 'unknownMetric' }),
    plan({ sortBy: 'scrobbles' }),
    plan({ sortBy: 'scrobblesLast1y' }),
    plan({ sortBy: 'scrobblesLast5y' }),
    plan({ filters: [{ field: 'ratingRymValue', value: 'high' }] }),
    plan({
      filters: [
        { field: 'genre', value: 'Rock' },
        { field: 'genre', value: ' rock ', mode: 'exclude' },
      ],
    }),
    plan({
      ranges: [{ field: 'ratingRymValue', min: 6, includeMissing: false }],
    }),
    plan({
      ranges: [{ field: 'ratingRymVotes', min: -1, includeMissing: false }],
    }),
    plan({ ranges: [{ field: 'scrobbles', max: 10, includeMissing: false }] }),
    plan({
      ranges: [{ field: 'releaseDate', max: 1e20, includeMissing: false }],
    }),
    plan({
      ranges: [
        { field: 'ratingRymVotes', min: 1, includeMissing: false },
        { field: 'ratingRymVotes', max: 10, includeMissing: false },
      ],
    }),
    plan({ sortBy: 'listeningScrobbles' }),
    plan({ listeningSort: { kind: 'all' } }),
    plan({ listening: { match: 'all', rules: [] } }),
  ])(
    'rejects unsupported or inconsistent plans before reading data',
    (search) => {
      expect(() => validateAiPlan(search, 'album')).toThrow(
        'unsupported search',
      )
      expect(mocks.sync).not.toHaveBeenCalled()
    },
  )

  it('rejects album ratings and listening in film plans', () => {
    expect(() =>
      validateAiPlan(plan({ sortBy: 'ratingRymValue' }), 'film'),
    ).toThrow('unsupported search')
    expect(() =>
      validateAiPlan(
        plan({
          sortBy: 'releaseDate',
          listening: {
            match: 'all',
            rules: [{ period: { kind: 'all' }, max: 10 }],
          },
        }),
        'film',
      ),
    ).toThrow('unsupported search')
  })

  it('enforces the ten-point personal rating scale including its endpoint', () => {
    const personalRating = (maximum: number) =>
      plan({
        sortBy: 'ratingImdbPersonal',
        ranges: [
          {
            field: 'ratingImdbPersonal',
            min: 8,
            max: maximum,
            includeMissing: false,
          },
        ],
      })
    expect(() => validateAiPlan(personalRating(10), 'film')).not.toThrow()
    expect(() => validateAiPlan(personalRating(11), 'film')).toThrow(
      'unsupported search',
    )
  })

  it('rejects invalid listening ranges at the model boundary', () => {
    expect(
      AiSearchPlanSchema.safeParse(
        plan({
          listening: {
            match: 'all',
            rules: [
              {
                period: { kind: 'dates', from: '2026-11-13', to: '2021-11-13' },
                min: 20,
                max: 10,
              },
            ],
          },
        }),
      ).success,
    ).toBe(false)
  })
})

describe('AI track search', () => {
  it('states the track sort default and forbids listening rules and caps in the prompt', () => {
    const prompt = aiSearchPrompt('track', now)
    expect(prompt).toContain('read-only track library search')
    expect(prompt).toContain('Use dateAdded desc by default')
    expect(prompt).toContain(
      'Track plans MUST have listening:null, listeningSort:null and limitResults:null',
    )
    expect(prompt).toContain('"key":"albumLink"')
    expect(prompt).not.toContain('ratingRymValue')
  })

  it('accepts track filters and sorts by linked track scrobbles after a completed sync', async () => {
    const expected = plan({
      filters: [{ field: 'playlist', value: 'Road trip', mode: 'required' }],
      ranges: [{ field: 'scrobbles', min: 1, max: 10, includeMissing: false }],
      sortBy: 'scrobbles',
    })
    mocks.text.mockResolvedValue(completion(interpretation(expected)))
    const result = await interpretAiSearch(
      {
        mediaType: 'track',
        text: 'Road trip tracks I have only played a little, most played first',
      },
      now,
    )
    expect(result.plan).toEqual(expected)
    expect(result.warnings).toContainEqual(
      expect.stringContaining('linked to library tracks'),
    )
    expect(mocks.sync).toHaveBeenCalledOnce()
    expect(mocks.text.mock.calls[0]?.[0]?.[0]?.content).toContain(
      'read-only track library search',
    )
  })

  it('does not read listening history for a track plan without listening fields', async () => {
    const expected = plan({
      filters: [{ field: 'albumLink', value: 'Not in library' }],
    })
    mocks.text.mockResolvedValue(completion(interpretation(expected)))
    const result = await interpretAiSearch(
      { mediaType: 'track', text: 'Tracks whose album is not in the library' },
      now,
    )
    expect(result).toMatchObject({ plan: expected, warnings: [] })
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('does not apply a track scrobble plan without a completed history sync', async () => {
    mocks.sync.mockResolvedValue({ state: 'running', lastCompletedAt: null })
    mocks.text.mockResolvedValue(
      completion(
        interpretation(
          plan({
            ranges: [{ field: 'scrobbles', max: 0, includeMissing: false }],
          }),
        ),
      ),
    )
    const result = await interpretAiSearch(
      { mediaType: 'track', text: 'Tracks I have never played' },
      now,
    )
    expect(result.plan).toBeNull()
    expect(result.explanation).toContain('Complete the Last.fm history sync')
  })

  it.each([
    plan({
      listening: { match: 'all', rules: [{ period: { kind: 'all' }, max: 0 }] },
    }),
    plan({ listeningSort: { kind: 'all' } }),
    plan({ sortBy: 'listeningScrobbles', listeningSort: { kind: 'all' } }),
    plan({ limitResults: 10 }),
    plan({ sortBy: 'scrobblesLast1y' }),
    plan({ sortBy: 'ratingRymValue' }),
    plan({ filters: [{ field: 'country', value: 'Japan' }] }),
    plan({
      ranges: [{ field: 'scrobblesLast5y', min: 1, includeMissing: false }],
    }),
  ])(
    'rejects listening rules, caps and unsupported fields on tracks',
    (search) => {
      expect(() => validateAiPlan(search, 'track')).toThrow(
        'unsupported search',
      )
    },
  )
})

const channelId = (letter: string) => `UC${letter.repeat(22)}`
const channelRows = [
  { id: channelId('a'), title: 'Synthetic Science', handle: '@synthsci' },
  { id: channelId('b'), title: 'Synthetic Science Shorts', handle: null },
  { id: channelId('c'), title: 'Example Cooking', handle: '@examplekitchen' },
  { id: channelId('d'), title: 'Woodwork Example', handle: '@woodwork' },
]
function youtubePlan(
  overrides: Partial<AiYoutubeInterpretedPlan> = {},
): AiYoutubeInterpretedPlan {
  return {
    q: '',
    fields: 'all',
    channelNames: [],
    duration: null,
    publishedFrom: null,
    publishedTo: null,
    sortBy: 'publishedAt',
    sortDirection: 'desc',
    ...overrides,
  }
}

function youtubeInterpretation(search: AiYoutubeInterpretedPlan) {
  return { ...interpretation(null), plan: search }
}

describe('AI YouTube search', () => {
  beforeEach(() => {
    mocks.database.mockResolvedValue({ rows: channelRows })
  })

  it('resolves named channels on the server and returns their ids', async () => {
    mocks.text.mockResolvedValue(
      completion(
        youtubeInterpretation(
          youtubePlan({
            q: 'bread -sourdough',
            channelNames: ['example cooking', '@WOODWORK', 'Example Cooking'],
            duration: 'long',
            publishedFrom: '2026-10-01',
            publishedTo: '2026-10-31',
            sortBy: 'relevance',
          }),
        ),
      ),
    )
    const result = await interpretAiSearch(
      {
        mediaType: 'youtube',
        text: 'Long bread videos without sourdough from Example Cooking and @woodwork last month',
      },
      now,
    )
    expect(result).toEqual({
      plan: {
        q: 'bread -sourdough',
        fields: 'all',
        channels: [
          { id: channelId('c'), title: 'Example Cooking' },
          { id: channelId('d'), title: 'Woodwork Example' },
        ],
        duration: 'long',
        publishedFrom: '2026-10-01',
        publishedTo: '2026-10-31',
        sortBy: 'relevance',
        sortDirection: 'desc',
      },
      explanation: 'Search the selected library.',
      assumptions: [],
      warnings: [],
    })
    expect(mocks.database).toHaveBeenCalledOnce()
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('never sends stored channel names to the model', async () => {
    mocks.text.mockResolvedValue(
      completion(
        youtubeInterpretation(youtubePlan({ channelNames: ['woodwork'] })),
      ),
    )
    await interpretAiSearch(
      { mediaType: 'youtube', text: 'Videos from woodwork' },
      now,
    )
    const sent = JSON.stringify(mocks.text.mock.calls)
    expect(sent).toContain('read-only search of stored videos')
    expect(sent).toContain('a bare word also matches')
    for (const channel of channelRows) {
      expect(sent).not.toContain(channel.title)
      expect(sent).not.toContain(channel.id)
    }
  })

  it('does not read channels when the request names none', async () => {
    mocks.text.mockResolvedValue(
      completion(youtubeInterpretation(youtubePlan({ duration: 'short' }))),
    )
    const result = await interpretAiSearch(
      { mediaType: 'youtube', text: 'Short videos' },
      now,
    )
    expect(result.plan).toMatchObject({ channels: [], duration: 'short' })
    expect(mocks.database).not.toHaveBeenCalled()
  })

  it('returns ambiguous and missing channels as warnings without a partial filter', async () => {
    mocks.text.mockResolvedValue(
      completion(
        youtubeInterpretation(
          youtubePlan({
            channelNames: ['Example Cooking', 'synthetic', 'Unknown Channel'],
          }),
        ),
      ),
    )
    const result = await interpretAiSearch(
      {
        mediaType: 'youtube',
        text: 'Videos from Example Cooking, Synthetic and Unknown Channel',
      },
      now,
    )
    expect(result.plan).toBeNull()
    expect(result.explanation).toContain('subscribed channel')
    expect(result.warnings).toEqual([
      '"synthetic" matches several subscribed channels: Synthetic Science, Synthetic Science Shorts.',
      'No subscribed channel matches "Unknown Channel".',
    ])
  })

  it('passes a clarification through without reading channels', async () => {
    mocks.text.mockResolvedValue(
      completion({
        plan: null,
        explanation: 'Likes are not stored. Choose views instead?',
        assumptions: [],
      }),
    )
    expect(
      await interpretAiSearch(
        { mediaType: 'youtube', text: 'Most liked videos' },
        now,
      ),
    ).toEqual({
      plan: null,
      explanation: 'Likes are not stored. Choose views instead?',
      assumptions: [],
      warnings: [],
    })
    expect(mocks.database).not.toHaveBeenCalled()
  })

  it.each([
    youtubePlan({ sortBy: 'relevance' }),
    youtubePlan({ q: 'bread', sortBy: 'relevance', sortDirection: 'asc' }),
    youtubePlan({ fields: 'title' }),
    youtubePlan({ publishedFrom: '2026-10-31', publishedTo: '2026-10-01' }),
  ])('rejects YouTube plans the Videos page cannot apply', (search) => {
    expect(() => validateAiYoutubePlan(search)).toThrow('unsupported search')
  })

  it.each([
    { ...youtubePlan(), channelId: [channelId('a')] },
    { ...youtubePlan(), sortBy: 'likeCount' },
    { ...youtubePlan(), duration: 'feature' },
    { ...youtubePlan(), publishedFrom: '2026-13-01' },
    { ...youtubePlan(), filters: [] },
  ])('rejects unsupported YouTube fields at the model boundary', (search) => {
    expect(() =>
      parseAiYoutubeInterpretation(
        completion({ ...interpretation(), plan: search }),
      ),
    ).toThrow('unsupported search')
  })

  it('matches exact titles and handles before unique substrings', () => {
    expect(matchYoutubeChannelName('synthetic science', channelRows)).toEqual({
      status: 'matched',
      channel: channelRows[0],
    })
    expect(matchYoutubeChannelName('@SynthSci', channelRows)).toEqual({
      status: 'matched',
      channel: channelRows[0],
    })
    expect(matchYoutubeChannelName('kitchen', channelRows)).toEqual({
      status: 'matched',
      channel: channelRows[2],
    })
    expect(matchYoutubeChannelName('shorts', channelRows)).toEqual({
      status: 'matched',
      channel: channelRows[1],
    })
    expect(matchYoutubeChannelName('example', channelRows).status).toBe(
      'ambiguous',
    )
    expect(matchYoutubeChannelName('@', channelRows).status).toBe('missing')
    expect(matchYoutubeChannelName('missing', channelRows).status).toBe(
      'missing',
    )
  })
})

describe('AI transcription', () => {
  const recording = {
    audio: Buffer.from('synthetic-audio').toString('base64'),
    mimeType: 'audio/webm;codecs=opus',
  }

  it('returns editable trimmed text and does not execute a search', async () => {
    mocks.transcribe.mockResolvedValue({
      text: '  Show rock albums  ',
      segments: [],
    })
    expect(await transcribeAiAudio(recording)).toEqual({
      text: 'Show rock albums',
    })
    expect(mocks.transcribe).toHaveBeenCalledExactlyOnceWith(recording.audio)
    expect(mocks.text).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it.each([{ text: '' }, { text: '   ' }, { text: 'x'.repeat(2001) }, {}])(
    'rejects empty or unusable transcription',
    async (result) => {
      mocks.transcribe.mockResolvedValue(result)
      await expect(transcribeAiAudio(recording)).rejects.toThrow(
        'No usable speech',
      )
    },
  )

  it.each([
    { ...recording, audio: 'not base64' },
    { ...recording, audio: 'YQ=' },
    { ...recording, audio: 'YR==' },
    { ...recording, audio: '' },
    { ...recording, mimeType: 'text/plain' },
  ])('rejects invalid input before paying for transcription', async (input) => {
    await expect(transcribeAiAudio(input)).rejects.toThrow()
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })

  it('rejects oversized decoded audio even when encoded length fits the cap', async () => {
    await expect(
      transcribeAiAudio({
        ...recording,
        audio: Buffer.alloc(AI_AUDIO_MAX_BYTES + 1).toString('base64'),
      }),
    ).rejects.toThrow('Invalid audio recording')
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })

  it('accepts a recording at the size limit without recursive validation', async () => {
    mocks.transcribe.mockResolvedValue({ text: 'Show albums' })
    const audio = Buffer.alloc(AI_AUDIO_MAX_BYTES).toString('base64')
    await expect(transcribeAiAudio({ ...recording, audio })).resolves.toEqual({
      text: 'Show albums',
    })
    expect(mocks.transcribe).toHaveBeenCalledOnce()
  })
})
