import { afterEach, describe, expect, it, vi } from 'vitest'
import { omdbPlugin } from '@/plugins/builtin/omdb'
import { tmdbPlugin } from '@/plugins/builtin/tmdb'

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  })
}

describe('builtin film scrape plugins', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('scrapes OMDb using an existing IMDb reference', async () => {
    const fetchMock = vi
      .fn<(input: string | URL | Request) => Promise<Response>>()
      .mockResolvedValue(
        createJsonResponse({
          Response: 'True',
          title: 'Alien',
          plot: 'The crew encounters a lethal organism.',
          poster: 'https://images.example/alien.jpg',
          released: '1979-05-25',
          runtime: '117 min',
          boxoffice: '$106,285,522',
          imdbid: 'tt0078748',
          genres: 'Horror, Sci-Fi',
          director: 'Ridley Scott',
          writer: "Dan O'Bannon",
          actors: 'Sigourney Weaver, Tom Skerritt',
        }),
      )

    vi.stubGlobal('fetch', fetchMock)

    const result = await omdbPlugin.scrapeMediaItem?.({
      mediaItemId: 'film_1',
      mediaType: 'film',
      existingReferences: [
        {
          referenceType: 'imdb',
          externalId: 'tt0078748',
          isPrimary: true,
        },
      ],
      secrets: {
        apiKey: 'secret',
      },
      log: vi.fn(async () => undefined),
      request: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)

    const firstCall = fetchMock.mock.calls[0]?.[0]
    expect(String(firstCall)).toContain('apikey=secret')
    expect(String(firstCall)).toContain('i=tt0078748')
    expect(result?.normalized.mediaPatch?.title).toBe('Alien')
    expect(result?.normalized.references).toEqual([
      {
        referenceType: 'imdb',
        externalId: 'tt0078748',
        isPrimary: true,
      },
    ])
  })

  it('scrapes TMDb from an IMDb fallback when no TMDb reference exists', async () => {
    const fetchMock = vi
      .fn<(input: string | URL | Request) => Promise<Response>>()
      .mockResolvedValueOnce(
        createJsonResponse({
          movie_results: [{ id: 603 }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          id: 603,
          title: 'The Matrix',
          original_title: 'The Matrix',
          overview: 'A hacker learns the truth.',
          poster_path: '/matrix.jpg',
          release_date: '1999-03-30',
          runtime: 136,
          budget: 63000000,
          revenue: 467000000,
          genres: [{ name: 'Action' }, { name: 'Science Fiction' }],
          keywords: { keywords: [{ id: 1701, name: 'virtual reality' }] },
        }),
      )

    vi.stubGlobal('fetch', fetchMock)

    const log = vi.fn(async () => undefined)

    const result = await tmdbPlugin.scrapeMediaItem?.({
      mediaItemId: 'film_2',
      mediaType: 'film',
      existingReferences: [
        {
          referenceType: 'imdb',
          externalId: 'tt0133093',
          isPrimary: true,
        },
      ],
      secrets: {
        apiKey: 'secret',
      },
      log,
      request: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/find/tt0133093')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/movie/603')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      'append_to_response=credits%2Ckeywords',
    )
    expect(log).toHaveBeenCalledTimes(2)
    expect(result?.normalized.mediaPatch?.title).toBe('The Matrix')
    expect(result?.normalized.tags).toContainEqual({
      name: 'virtual reality',
      kind: 'keyword',
      source: 'tmdb',
      sourceId: '1701',
      rawName: 'virtual reality',
    })
    expect(result?.normalized.references).toEqual([
      {
        referenceType: 'tmdb',
        externalId: '603',
        isPrimary: true,
      },
    ])
  })
})
