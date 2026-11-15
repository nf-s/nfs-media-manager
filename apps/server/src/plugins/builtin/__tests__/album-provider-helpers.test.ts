import { describe, expect, it, vi } from 'vitest'
import { requestAlbumJson } from '../album-provider-helpers'

describe('album response diagnostics', () => {
  it('records the lookup and JSON null before the helper rejects it', async () => {
    const recordDiagnostic = vi.fn()
    const url = new URL('https://example.test/release-group/')
    url.searchParams.set('query', 'releasegroup:Example AND artist:Sample')
    await expect(
      requestAlbumJson(
        {
          request: async () => Response.json(null),
          secrets: {},
          recordDiagnostic,
        },
        'MusicBrainz',
        url,
      ),
    ).rejects.toThrow('MusicBrainz returned a non-object payload.')
    expect(recordDiagnostic).toHaveBeenCalledExactlyOnceWith({
      stage: 'musicbrainz.response',
      evidence: {
        path: '/release-group/',
        query: { query: 'releasegroup:Example AND artist:Sample' },
        status: 200,
        response: null,
      },
    })
  })

  it('redacts secrets and bounds response evidence without changing the payload', async () => {
    const recordDiagnostic = vi.fn()
    const secret = 'synthetic-provider-secret'
    const url = new URL('https://example.test/2.0/')
    url.username = 'omitted-url-user'
    url.password = 'omitted-url-password'
    url.searchParams.set('api_key', 'omitted-query-key')
    url.searchParams.set('username', 'omitted-query-user')
    url.searchParams.set('method', 'album.getInfo')
    const payload = {
      authentication: 'redacted-response-value',
      message: `Response echoed ${secret}`,
      candidates: Array.from({ length: 25 }, () => ({ title: 'Example' })),
    }
    await expect(
      requestAlbumJson(
        {
          request: async () => Response.json(payload),
          secrets: { apiKey: ` ${secret} ` },
          recordDiagnostic,
        },
        'Last.fm',
        url,
      ),
    ).resolves.toEqual(payload)
    expect(recordDiagnostic).toHaveBeenCalledExactlyOnceWith({
      stage: 'last.fm.response',
      evidence: {
        path: '/2.0/',
        query: { method: 'album.getInfo' },
        status: 200,
        response: {
          authentication: '[REDACTED]',
          message: 'Response echoed [REDACTED]',
          candidates: [...payload.candidates.slice(0, 20), '[truncated]'],
        },
      },
    })
    expect(JSON.stringify(recordDiagnostic.mock.calls)).not.toContain(secret)
  })

  it('keeps the response usable when the optional recorder throws', async () => {
    const recordDiagnostic = vi.fn(() => {
      throw new Error('Recorder unavailable')
    })
    const url = new URL('https://example.test/release-group/')
    const context = {
      request: async () => Response.json({ title: 'Example' }),
      secrets: {},
    }
    await expect(
      requestAlbumJson(context, 'MusicBrainz', url),
    ).resolves.toEqual({
      title: 'Example',
    })
    await expect(
      requestAlbumJson({ ...context, recordDiagnostic }, 'MusicBrainz', url),
    ).resolves.toEqual({ title: 'Example' })
    expect(recordDiagnostic).toHaveBeenCalledOnce()
  })
})
