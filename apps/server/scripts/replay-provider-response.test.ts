import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderResponseCapture } from '@repo/schemas/provider-response'
import { describe, expect, it } from 'vitest'
import {
  parseReplayArguments,
  recordedArtistLookupByName,
  selectProviderReplayCaptures,
  validateReplayContext,
  writePrivateJson,
} from './replay-provider-response'

const scope = {
  jobId: 'fixture-job',
  jobItemId: 'fixture-item',
  artistId: null,
  attempt: 2,
}
const jobArguments = [
  '--job',
  scope.jobId,
  '--item',
  scope.jobItemId,
  '--attempt',
  '2',
]
const output = ['--output', 'private.json']
const response = {
  status: 200,
  receivedAt: null,
  contentType: null,
  body: { state: 'unavailable', reason: 'empty' },
} satisfies ProviderResponseCapture['response']
const request = { method: 'GET', url: null }
const media = {
  phase: 'media',
  ordinal: 1,
  request,
  response,
} satisfies ProviderResponseCapture
const artist = { ...media, phase: 'artist' } satisfies ProviderResponseCapture

describe('job-scoped provider response replay CLI', () => {
  it('requires an exact attempt and target and exports only to an explicit file', () => {
    expect(
      parseReplayArguments(['replay', ...jobArguments, ...output]),
    ).toMatchObject({
      action: 'replay',
      scope,
      output: 'private.json',
    })
    expect(() => parseReplayArguments(['replay', ...jobArguments])).toThrow()
    expect(() =>
      parseReplayArguments([
        'export',
        ...jobArguments,
        ...output,
        '--context',
        'lookup.json',
      ]),
    ).toThrow()
    expect(() =>
      parseReplayArguments([
        'export',
        '--job',
        scope.jobId,
        '--attempt',
        '2',
        ...output,
      ]),
    ).toThrow()
  })

  it('keeps incomplete archives available for export but blocks exact replay', () => {
    const rows = [
      { artistId: null, capture: media },
      { artistId: null, capture: { ...media, ordinal: 3 } },
    ]
    expect(selectProviderReplayCaptures(scope, rows, true)).toEqual(rows)
    expect(() => selectProviderReplayCaptures(scope, rows)).toThrow(/gaps/)
  })

  it('isolates an artist phase, and refuses a mismatched context scope or item', () => {
    const rows = [
      { artistId: 'fixture-artist', capture: artist },
      { artistId: null, capture: { ...media, ordinal: 2 } },
    ]
    const artistScope = { ...scope, artistId: 'fixture-artist' }
    expect(selectProviderReplayCaptures(artistScope, rows)).toEqual(
      rows.slice(0, 1),
    )
    const provider = 'fixture-provider'
    const context = {
      version: 1,
      scope,
      provider,
      inputs: [
        {
          phase: 'artist',
          bootstrap: true,
          context: {
            artist: { id: 'fixture-artist', name: 'Synthetic Artist' },
            providerArtistId: null,
          },
        },
        {
          phase: 'media',
          context: {
            mediaItemId: 'fixture-media',
            mediaType: 'album',
            media: { title: 'Synthetic Album', artists: ['Synthetic Artist'] },
            existingReferences: [],
          },
        },
      ],
    }
    expect(
      validateReplayContext(context, scope, provider, 'fixture-media', rows),
    ).toEqual(context)
    expect(() =>
      validateReplayContext(
        context,
        { ...scope, attempt: 3 },
        provider,
        'fixture-media',
        rows,
      ),
    ).toThrow(/another attempt/)
    expect(() =>
      validateReplayContext(context, scope, provider, 'other-media', rows),
    ).toThrow(/recorded targets/)
  })

  it('distinguishes recorded artist name lookups from current direct identifiers', () => {
    const artistId = 'fixture-artist'
    const spotifyTrack = {
      ...artist,
      request: {
        method: 'GET',
        url: 'https://api.spotify.com/v1/tracks/1111111111abcdefghijkl',
      },
    }
    expect(
      recordedArtistLookupByName(
        'spotify',
        [{ artistId, capture: spotifyTrack }],
        artistId,
      ),
    ).toBe(true)
    expect(
      recordedArtistLookupByName(
        'spotify',
        [{ artistId, capture: spotifyTrack }],
        'some-other-artist',
      ),
    ).toBe(false)
    const lastfmLookup = {
      ...artist,
      request: { method: 'GET', url: 'https://ws.audioscrobbler.com/2.0/' },
      response: {
        ...response,
        body: {
          state: 'captured',
          text: '{"results":{"artistmatches":{"artist":[]}}}',
        },
      },
    } satisfies ProviderResponseCapture
    expect(
      recordedArtistLookupByName(
        'lastfm',
        [
          {
            artistId,
            capture: lastfmLookup,
          },
        ],
        artistId,
      ),
    ).toBe(true)
    expect(
      recordedArtistLookupByName(
        'lastfm',
        [
          {
            artistId,
            capture: {
              ...lastfmLookup,
              response: {
                ...response,
                body: {
                  state: 'captured',
                  text: '{"artist":{"name":"Fixture"}}',
                },
              },
            },
          },
        ],
        artistId,
      ),
    ).toBe(false)
  })

  it('writes owner-only JSON and refuses to overwrite an earlier export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fixture-provider-export-'))
    try {
      const path = join(directory, 'report.json')
      await writePrivateJson(path, { marker: 'original' })
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      await expect(
        writePrivateJson(path, { marker: 'replacement' }),
      ).rejects.toMatchObject({ code: 'EEXIST' })
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        marker: 'original',
      })
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
