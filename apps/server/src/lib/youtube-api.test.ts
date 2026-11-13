import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  YoutubeVideoListSchema,
  youtubeAuthorization,
  youtubeDurationSeconds,
  youtubeJson,
  youtubeRedirectUri,
  youtubeThumbnail,
  youtubeToken,
} from './youtube-api'

const REDIRECT = 'https://media.example.test/api/v1/youtube/callback'

describe('YouTube API helpers', () => {
  it('reads ISO 8601 durations as seconds', () => {
    expect(youtubeDurationSeconds('PT58S')).toBe(58)
    expect(youtubeDurationSeconds('PT12M30S')).toBe(750)
    expect(youtubeDurationSeconds('PT1H2M3S')).toBe(3723)
    expect(youtubeDurationSeconds('P1DT1S')).toBe(86401)
    expect(youtubeDurationSeconds('P1W')).toBe(604800)
    // A stream that has not finished reports no length.
    expect(youtubeDurationSeconds('P0D')).toBe(0)
    expect(youtubeDurationSeconds(undefined)).toBe(0)
    expect(youtubeDurationSeconds('12:30')).toBe(0)
  })

  it('accepts only the exact callback URI over HTTPS, or HTTP on this machine', () => {
    expect(youtubeRedirectUri(REDIRECT)).toBe(REDIRECT)
    expect(
      youtubeRedirectUri('http://localhost:3000/api/v1/youtube/callback'),
    ).toBe('http://localhost:3000/api/v1/youtube/callback')
    expect(
      youtubeRedirectUri('http://127.0.0.1:3035/api/v1/youtube/callback'),
    ).toBe('http://127.0.0.1:3035/api/v1/youtube/callback')
    for (const value of [
      'http://media.example.test/api/v1/youtube/callback',
      'https://media.example.test/api/v1/youtube/callback/',
      'https://media.example.test/api/v1/spotify/callback',
      `${REDIRECT}?next=1`,
      `${REDIRECT}#fragment`,
      'https://user:pass@media.example.test/api/v1/youtube/callback',
      'not a url',
    ]) {
      expect(() => youtubeRedirectUri(value)).toThrow()
    }
  })

  it('builds a read-only offline authorization with a fresh state and PKCE challenge', () => {
    const first = youtubeAuthorization('fixture-client', REDIRECT)
    const second = youtubeAuthorization('fixture-client', REDIRECT)
    const url = new URL(first.url)
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'fixture-client',
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      state: first.state,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256')
        .update(first.verifier)
        .digest('base64url'),
    })
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second.state).not.toBe(first.state)
    expect(second.verifier).not.toBe(first.verifier)
    expect(() =>
      youtubeAuthorization('fixture-client', 'http://media.example.test/'),
    ).toThrow()
  })

  it('prefers the smallest thumbnail', () => {
    expect(
      youtubeThumbnail({
        high: { url: 'https://img.example.test/high.jpg' },
        default: { url: 'https://img.example.test/default.jpg' },
      }),
    ).toBe('https://img.example.test/default.jpg')
    expect(
      youtubeThumbnail({ high: { url: 'https://img.example.test/high.jpg' } }),
    ).toBe('https://img.example.test/high.jpg')
    expect(youtubeThumbnail(undefined)).toBeNull()
  })

  it('posts token requests as a form and rejects unusable answers without echoing them', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        access_token: 'fixture-access-token',
        token_type: 'Bearer',
        expires_in: 3599,
      }),
    )
    expect(
      await youtubeToken(request, new URLSearchParams({ grant_type: 'x' })),
    ).toEqual({
      access_token: 'fixture-access-token',
      token_type: 'Bearer',
      expires_in: 3599,
    })
    expect(request).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=x',
      },
    )

    request.mockResolvedValueOnce(
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    )
    await expect(youtubeToken(request, new URLSearchParams())).rejects.toThrow(
      'Google token request failed (HTTP 400)',
    )
    request.mockResolvedValueOnce(
      Response.json({ access_token: 'fixture-secret-value' }),
    )
    await expect(youtubeToken(request, new URLSearchParams())).rejects.toThrow(
      /^Google returned an invalid token response$/,
    )
    request.mockResolvedValueOnce(new Response('<html>'))
    await expect(youtubeToken(request, new URLSearchParams())).rejects.toThrow(
      'Google returned an invalid token response',
    )
  })

  it('sends the access token as a header, never in the URL', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ items: [] }),
    )
    expect(
      await youtubeJson(request, 'fixture-access-token', 'videos', {
        part: 'snippet',
        id: 'a,b',
      }),
    ).toEqual({ items: [] })
    const [url, init] = request.mock.calls[0] ?? []
    expect(String(url)).toBe(
      'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=a%2Cb',
    )
    expect(init).toEqual({
      headers: { Authorization: 'Bearer fixture-access-token' },
    })
  })

  it('keeps videos with hidden counts and unknown broadcast states', () => {
    const parsed = YoutubeVideoListSchema.parse({
      items: [
        {
          id: 'abcdefghijk',
          snippet: {
            channelId: 'UCabcdefghijklmnopqrstuv',
            title: 'Fixture video',
            publishedAt: '2026-01-02T03:04:05Z',
            liveBroadcastContent: 'completed',
          },
          contentDetails: {},
        },
      ],
    })
    expect(parsed.items[0]).toEqual({
      id: 'abcdefghijk',
      snippet: {
        channelId: 'UCabcdefghijklmnopqrstuv',
        title: 'Fixture video',
        description: '',
        publishedAt: '2026-01-02T03:04:05Z',
        tags: [],
        liveBroadcastContent: 'none',
      },
      contentDetails: {},
    })
    expect(YoutubeVideoListSchema.parse({}).items).toEqual([])
  })
})
