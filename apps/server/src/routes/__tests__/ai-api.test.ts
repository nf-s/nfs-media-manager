import { afterEach, describe, expect, it, vi } from 'vitest'

const search = vi.fn()
const transcribe = vi.fn()
const status = vi.fn()

function mockAppSession(authenticated: boolean) {
  vi.doMock('@/env', () => ({
    env: { TRUSTED_ORIGINS: ['http://localhost:3000'], NODE_ENV: 'test' },
  }))
  vi.doMock('@/lib/db', () => ({ db: {} }))
  vi.doMock('@/lib/auth', () => ({
    auth: {
      api: {
        getSession: vi.fn().mockResolvedValue(
          authenticated
            ? {
                user: {
                  id: 'user-1',
                  email: 'admin@example.com',
                  name: 'Admin',
                },
                session: { id: 'session-1', userId: 'user-1' },
              }
            : null,
        ),
      },
      handler: vi.fn(),
    },
  }))
  vi.doMock('@/services/ai-search', () => ({
    interpretAiSearch: search,
    transcribeAiAudio: transcribe,
    aiSearchStatus: status,
  }))
}

function jsonRequest(
  body: unknown,
  origin = 'http://localhost:3000',
): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  }
}

describe('AI API', () => {
  afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
  })

  it('requires owner authentication for status, search and transcription', async () => {
    mockAppSession(false)
    const { default: app } = await import('@/app')
    expect((await app.request('/api/v1/ai/status')).status).toBe(401)
    expect(
      (
        await app.request(
          '/api/v1/ai/search',
          jsonRequest({ mediaType: 'album', text: 'Rock albums' }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await app.request(
          '/api/v1/ai/transcribe',
          jsonRequest({ audio: 'YQ==', mimeType: 'audio/webm' }),
        )
      ).status,
    ).toBe(401)
    expect(status).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('rejects cross-origin inference requests before invoking a service', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    for (const path of ['search', 'transcribe']) {
      expect(
        (
          await app.request(
            `/api/v1/ai/${path}`,
            jsonRequest({}, 'https://untrusted.example'),
          )
        ).status,
      ).toBe(403)
    }
    expect(search).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('rejects an authenticated account that is not the configured owner', async () => {
    mockAppSession(true)
    vi.doMock('@/env', () => ({
      env: {
        TRUSTED_ORIGINS: ['http://localhost:3000'],
        NODE_ENV: 'test',
        OWNER_EMAIL: 'owner@example.com',
      },
    }))
    const { default: app } = await import('@/app')
    expect(
      (
        await app.request(
          '/api/v1/ai/search',
          jsonRequest({ mediaType: 'album', text: 'Rock albums' }),
        )
      ).status,
    ).toBe(403)
    expect(search).not.toHaveBeenCalled()
  })

  it('returns only availability status with no-store headers', async () => {
    mockAppSession(true)
    status.mockReturnValue({
      available: false,
      reason: 'Cloudflare AI is not configured.',
    })
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/ai/status')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toMatchObject({
      data: { available: false, reason: 'Cloudflare AI is not configured.' },
    })
  })

  it('validates and forwards typed search text without including extra request data', async () => {
    mockAppSession(true)
    const result = {
      plan: null,
      explanation: 'Choose a supported rating source.',
      assumptions: [],
      warnings: [],
    }
    search.mockResolvedValue(result)
    const { default: app } = await import('@/app')
    const response = await app.request(
      '/api/v1/ai/search',
      jsonRequest({ mediaType: 'album', text: '  Show rock albums  ' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: result })
    expect(search).toHaveBeenCalledExactlyOnceWith({
      mediaType: 'album',
      text: 'Show rock albums',
    })
  })

  it('forwards track and Subscriptions requests and returns their plans', async () => {
    mockAppSession(true)
    const trackResult = {
      plan: {
        q: '',
        filters: [{ field: 'playlist', value: 'Road trip', mode: 'required' }],
        ranges: [],
        sortBy: 'dateAdded',
        direction: 'desc',
        limitResults: null,
        listening: null,
        listeningSort: null,
      },
      explanation: 'Tracks in the Road trip playlist.',
      assumptions: [],
      warnings: [],
    }
    const subscriptionResult = {
      plan: {
        q: 'bread',
        fields: 'all',
        types: [],
        publishedFrom: null,
        publishedTo: null,
        durationMinSec: null,
        durationMaxSec: null,
        sortBy: 'relevance',
        direction: 'desc',
        sources: [
          {
            id: `UC${'c'.repeat(22)}`,
            type: 'youtube',
            title: 'Example Cooking',
          },
        ],
      },
      explanation: 'Bread videos from one channel.',
      assumptions: [],
      warnings: [],
    }
    search
      .mockResolvedValueOnce(trackResult)
      .mockResolvedValueOnce(subscriptionResult)
    const { default: app } = await import('@/app')
    const tracks = await app.request(
      '/api/v1/ai/search',
      jsonRequest({ mediaType: 'track', text: 'Road trip tracks' }),
    )
    const videos = await app.request(
      '/api/v1/ai/search',
      jsonRequest({
        mediaType: 'subscription',
        text: 'Bread videos from Example Cooking',
      }),
    )
    expect(tracks.status).toBe(200)
    expect(await tracks.json()).toMatchObject({ data: trackResult })
    expect(videos.status).toBe(200)
    expect(await videos.json()).toMatchObject({ data: subscriptionResult })
    expect(search.mock.calls).toEqual([
      [{ mediaType: 'track', text: 'Road trip tracks' }],
      [
        {
          mediaType: 'subscription',
          text: 'Bread videos from Example Cooking',
        },
      ],
    ])
  })

  it.each([
    { mediaType: 'book', text: 'Albums' },
    { mediaType: 'youtube', text: 'Videos' },
    { mediaType: 'playlist', text: 'Playlists' },
    { mediaType: 'album', text: ' ' },
    { mediaType: 'album', text: 'x'.repeat(2001) },
    { mediaType: 'album', text: 'Albums', sql: 'select 1' },
  ])('rejects invalid search payloads before inference', async (body) => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    expect(
      (await app.request('/api/v1/ai/search', jsonRequest(body))).status,
    ).toBe(422)
    expect(search).not.toHaveBeenCalled()
  })

  it('enforces search body size before JSON validation', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    expect(
      (
        await app.request(
          '/api/v1/ai/search',
          jsonRequest({ mediaType: 'album', text: 'x'.repeat(17000) }),
        )
      ).status,
    ).toBe(413)
    expect(search).not.toHaveBeenCalled()
  })

  it('forwards recording data and returns editable text without running search', async () => {
    mockAppSession(true)
    transcribe.mockResolvedValue({ text: 'Show rock albums' })
    const { default: app } = await import('@/app')
    const input = { audio: 'YQ==', mimeType: 'audio/webm;codecs=opus' }
    const response = await app.request(
      '/api/v1/ai/transcribe',
      jsonRequest(input),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { text: 'Show rock albums' },
    })
    expect(transcribe).toHaveBeenCalledExactlyOnceWith(input)
    expect(search).not.toHaveBeenCalled()
  })

  it.each([
    { audio: 'invalid data', mimeType: 'audio/webm' },
    { audio: 'YQ==', mimeType: 'text/plain' },
    {
      audio: 'YQ==',
      mimeType: 'audio/webm',
      url: 'https://untrusted.example/audio',
    },
  ])('rejects invalid audio requests before transcription', async (body) => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    expect(
      (await app.request('/api/v1/ai/transcribe', jsonRequest(body))).status,
    ).toBe(422)
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('enforces the encoded recording body limit', async () => {
    mockAppSession(true)
    const { default: app } = await import('@/app')
    const { AI_AUDIO_MAX_BYTES } = await import('@repo/schemas/ai-search')
    const audio = 'a'.repeat(4 * Math.ceil(AI_AUDIO_MAX_BYTES / 3) + 2048)
    expect(
      (
        await app.request(
          '/api/v1/ai/transcribe',
          jsonRequest({ audio, mimeType: 'audio/webm' }),
        )
      ).status,
    ).toBe(413)
    expect(transcribe).not.toHaveBeenCalled()
  })
})
