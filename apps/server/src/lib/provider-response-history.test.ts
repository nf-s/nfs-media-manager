import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import {
  createProviderResponseRecorder,
  createProviderResponseReplay,
  replayProviderResponses,
  type ProviderResponseCapture,
} from './provider-response-history'

const fixtureTime = '2026-01-01T00:00:00.000Z'
const fixtureUrl = 'https://archive.example.test/releases?page=1'

function fixture() {
  const archive: ProviderResponseCapture[] = []
  const begin = createProviderResponseRecorder(
    async (response) => {
      archive.push(response)
    },
    ['fixture-api-secret'],
  )
  const record = begin('media')
  return {
    archive,
    async capture(
      body: ProviderResponseCapture['response']['body'],
      request: Parameters<MediaPluginTestContext['request']> = [fixtureUrl],
      native = false,
      status = 200,
      contentType = 'application/json',
    ) {
      await record(...request)?.(
        { status, receivedAt: fixtureTime, contentType, body },
        native,
      )
    },
  }
}

describe('provider response archive', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps validated native boolean token capabilities byte-for-byte', async () => {
    const { capture, archive } = fixture()
    const text =
      '{ "canRefreshToken": true, "metadata": [{ "canRefreshToken": false }, { "canRefreshToken": true }] }'
    await capture(
      { state: 'captured', text, redacted: true },
      [fixtureUrl],
      true,
    )
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      text,
      redacted: true,
    })
  })

  it('does not treat non-boolean token fields or duplicate credential values as capabilities', async () => {
    const { capture, archive } = fixture()
    const text =
      '{"canRefreshToken":"opaque-fixture","canRefreshToken":true,"metadata":[{"canRefreshToken":{"value":1}},{"canRefreshToken":"true"},{"canRefreshToken":1},{"accessToken":true},{"accessToken":"secret-value"},{"canRefreshToken":false}]}'
    await capture({ state: 'captured', text }, [fixtureUrl], true)
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      text: '{"canRefreshToken":true,"metadata":[{},{},{},{},{},{"canRefreshToken":false}]}',
      redacted: true,
    })
  })

  it('retains conservative redaction for unstructured token fields', async () => {
    const { capture, archive } = fixture()
    await capture(
      { state: 'captured', text: 'canRefreshToken=true' },
      [fixtureUrl],
      true,
      200,
      'text/plain',
    )
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      text: 'canRefreshToken=[REDACTED]',
      redacted: true,
    })
  })

  it('records full paginated evidence and maps previously ignored fields offline', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('Network disabled')
    })
    vi.stubGlobal('fetch', fetch)
    const { capture, archive } = fixture()
    const longNote = 'x'.repeat(70_000)
    const rawPage = JSON.stringify(
      { items: [{ name: 'Fixture', newMetric: 47, longNote }] },
      null,
      2,
    )
    await capture({ state: 'captured', text: rawPage }, [
      fixtureUrl + '&apikey=fixture-api-secret',
    ])
    const nextPage = 'https://archive.example.test/releases?page=2'
    await capture(
      { state: 'captured', text: '{"items":[{"name":"Later","newMetric":9}]}' },
      [nextPage],
    )
    expect(archive[0]?.request.url).toBe(
      'https://archive.example.test/releases',
    )
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      redacted: false,
      text: rawPage,
    })
    const newMapping = await replayProviderResponses(
      archive,
      async (request) => {
        const pages = await Promise.all([
          request(fixtureUrl + '&apikey=offline-placeholder').then((reply) =>
            reply.json(),
          ),
          request(nextPage).then((reply) => reply.json()),
        ])
        return pages.flatMap((page) =>
          page.items.map((row: { newMetric: number }) => row.newMetric),
        )
      },
    )
    expect(newMapping).toEqual([47, 9])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('omits auth/account traffic and removes uploaders, private collage names, paths and credentials', async () => {
    const { capture, archive } = fixture()
    await capture(
      { state: 'captured', text: '{"access_token":"never-store"}' },
      ['https://accounts.spotify.com/api/token', { method: 'POST' }],
    )
    await capture({ state: 'captured', text: '{"account":true}' }, [
      'https://api.example.test/users/current',
    ])
    await capture({
      state: 'captured',
      text: JSON.stringify({
        uploader: { name: 'fixture-uploader' },
        filepath: '/home/example/library/album',
        note: '/Volumes/example/library',
        collages: [
          {
            name: 'fixture-personal-collage',
            private: true,
            url: 'https://provider.example.test/media/2',
          },
        ],
        authEcho: 'fixture-api-secret',
        api_key: 'fixture-api-secret',
        unknown: { safe: 'kept' },
      }),
    })
    expect(archive).toHaveLength(1)
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      redacted: true,
      text: JSON.stringify({
        note: '[REDACTED]',
        collages: [
          { private: true, url: 'https://provider.example.test/media/2' },
        ],
        authEcho: '[REDACTED]',
        unknown: { safe: 'kept' },
      }),
    })
  })

  it('preserves public collection labels and only removes explicitly private labels', async () => {
    const { capture, archive } = fixture()
    await capture(
      {
        state: 'captured',
        text: JSON.stringify({
          collages: [
            {
              id: 1,
              name: 'Public catalogue collection',
              collageName: 'Community name',
            },
            {
              id: 2,
              name: 'fixture-personal-name',
              visibility: 'private',
              unknown: 7,
            },
          ],
          personalCollections: [
            { id: 3, title: 'fixture-personal-title', score: 42 },
          ],
        }),
      },
      [fixtureUrl],
      true,
    )
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      text: JSON.stringify({
        collages: [
          {
            id: 1,
            name: 'Public catalogue collection',
            collageName: 'Community name',
          },
          { id: 2, visibility: 'private', unknown: 7 },
        ],
        personalCollections: [{ id: 3, score: 42 }],
      }),
      redacted: true,
    })
  })

  it('preserves integer and decimal lexemes next to a removed credential', async () => {
    const { capture, archive } = fixture()
    await capture({
      state: 'captured',
      text: '{"access_token":"fixture-hidden","future":{"identifier":900719925474099312345,"precision":1.111100000000000111}}',
    })
    expect(archive[0]?.response.body).toEqual({
      state: 'captured',
      text: '{"future":{"identifier":900719925474099312345,"precision":1.111100000000000111}}',
      redacted: true,
    })
  })

  it('archives markup only after an explicit parser-aware filter succeeds', async () => {
    const raw =
      '<form><input name="token" value="fixture-token"></form><p>Fixture</p>'
    const archive: ProviderResponseCapture[] = []
    const output = '<p>Fixture</p>'
    const filter = vi.fn(() => ({ contentType: 'text/html', text: output }))
    const recorder = createProviderResponseRecorder(
      async (entry) => {
        archive.push(entry)
      },
      ['fixture-token'],
      filter,
    )
    await recorder('media')(fixtureUrl)?.({
      status: 200,
      contentType: 'text/html',
      receivedAt: fixtureTime,
      body: { state: 'captured', text: raw },
    })
    expect(filter).toHaveBeenCalledWith({
      contentType: 'text/html',
      text: raw,
      sensitiveValues: ['fixture-token'],
    })
    const response = await replayProviderResponses(archive, (request) =>
      request(fixtureUrl),
    )
    await expect(response.text()).resolves.toBe(output)
    const { capture, archive: unknownOrigin } = fixture()
    await capture(
      { state: 'captured', text: raw },
      [fixtureUrl],
      false,
      200,
      'text/html',
    )
    expect(unknownOrigin[0]?.response.body).toEqual({
      state: 'unavailable',
      reason: 'unsupported-format',
    })
  })

  it('rejects changed request identity and unused or discontinuous evidence', async () => {
    const { capture, archive } = fixture()
    await capture({ state: 'captured', text: '{}' })
    const replay = createProviderResponseReplay(archive)
    await expect(replay.request(fixtureUrl.replace('1', '2'))).rejects.toThrow(
      'differs',
    )
    expect(() => replay.assertComplete()).toThrow('differs')
    await expect(
      replayProviderResponses(archive, async () => 'ignored'),
    ).rejects.toThrow('complete')
    const [entry] = archive
    if (!entry) throw new Error('Missing fixture')
    expect(() =>
      createProviderResponseReplay([{ ...entry, ordinal: 2 }]),
    ).toThrow('incomplete')
  })

  it('requires an explicit offline projector for paired native evidence', async () => {
    const { capture, archive } = fixture()
    await capture(
      { state: 'captured', text: '{"worker":{"native":true}}' },
      [fixtureUrl],
      true,
    )
    await expect(
      createProviderResponseReplay(archive).request(fixtureUrl),
    ).rejects.toThrow('offline projector')
    const response = await replayProviderResponses(
      archive,
      (request) => request(fixtureUrl),
      {
        async projectNativeResponse(entry) {
          expect(entry.response.body).toMatchObject({
            state: 'captured',
            text: '{"worker":{"native":true}}',
          })
          return Response.json({ projected: true })
        },
      },
    )
    await expect(response.json()).resolves.toEqual({ projected: true })
  })
})
