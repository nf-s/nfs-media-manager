import { describe, expect, it, vi } from 'vitest'
import type { MixStation } from '@repo/schemas/subscriptions'
import type { ProviderResponseCapture } from '@repo/schemas/provider-response'
import {
  createProviderResponseRecorder,
  createProviderResponseReplay,
} from './provider-response-history'
import { mixStationCapturePolicy } from './mix-station-archive'
import type { StationRequest } from './mix-station'
import { replayMixStationSteps } from '@/services/mix-station-replay'
import type { ProviderTaskReplayStep } from '@/services/provider-task-replay'

const at = '2026-01-01T00:00:00.000Z'
const action = 'a'.repeat(40)
const lot = 'https://www.thelotradio.com'
const lotIndex = lot + '/the-index'
const chunk = '/_next/static/chunks/archive.js'

function fixture(station: MixStation, replies: readonly Response[]) {
  const captures: ProviderResponseCapture[] = []
  const response = [...replies]
  const capturePolicy = mixStationCapturePolicy(station)
  const begin = createProviderResponseRecorder(
    async (entry) => {
      captures.push(entry)
    },
    [],
    undefined,
    undefined,
    capturePolicy,
  )('task')
  const request = vi.fn<StationRequest>(async (...params) => {
    const next = response.shift()
    if (!next) throw new Error('Unexpected fixture request')
    await begin(...params)?.({
      status: next.status,
      receivedAt: at,
      contentType: next.headers.get('content-type')?.split(';')[0] ?? null,
      body: { state: 'captured', text: await next.clone().text() },
    })
    return next
  })
  return {
    request,
    captures,
    replay: () => createProviderResponseReplay(captures, { capturePolicy }),
  }
}

const shows: ProviderTaskReplayStep = {
  operation: 'listShows',
  args: { at, page: null },
}
const feed: ProviderTaskReplayStep = {
  operation: 'listFeed',
  args: { at, page: null, mode: 'archive', since: null, action: null },
}

describe('station provider archives and offline replay', () => {
  it('retains a full Rinse JSON page and an unknown exact long numeric value', async () => {
    const text = '{ "entries": [], "futureIdentifier": 9007199254740993123 }'
    const recorded = fixture('rinse', [
      new Response(text, { headers: { 'content-type': 'application/json' } }),
    ])
    const expected = await replayMixStationSteps(
      'rinse',
      [shows],
      recorded.request,
    )
    expect(recorded.captures[0]?.response.body).toEqual({
      state: 'captured',
      text,
      redacted: false,
    })
    const replay = recorded.replay()
    await expect(
      replayMixStationSteps('rinse', [shows], replay.requestFor('task')),
    ).resolves.toEqual(expected)
    replay.assertComplete()
    expect(recorded.request).toHaveBeenCalledTimes(1)
  })

  it('archives NTS sitemap index and catalogue documents byte-for-byte', async () => {
    const sitemap =
      '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex><sitemap><loc>https://www.nts.live/sitemap1.xml.gz</loc></sitemap></sitemapindex>'
    const catalogue =
      '<urlset><url><loc>https://www.nts.live/shows/synthetic-show</loc><lastmod>2025-01-01</lastmod></url></urlset>'
    const recorded = fixture(
      'nts',
      [sitemap, catalogue].map(
        (text) =>
          new Response(text, {
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    )
    const projected = await replayMixStationSteps(
      'nts',
      [shows],
      recorded.request,
    )
    expect(recorded.captures.map(({ response }) => response.body)).toEqual(
      [sitemap, catalogue].map((text) => ({
        state: 'captured',
        text,
        redacted: false,
      })),
    )
    const replay = recorded.replay()
    await expect(
      replayMixStationSteps('nts', [shows], replay.requestFor('task')),
    ).resolves.toEqual(projected)
    replay.assertComplete()
  })

  it.each([
    {
      station: 'rinse',
      showId: 'rinse.42',
      text: '{"entry":{"id":42,"slug":"synthetic-show","title":"Synthetic Show"},"episodes":[{"id":43,"slug":"synthetic-episode","artistTitle":"Fixture Artist","episodeDate":"2025-12-12T00:00:00+00:00","episodeTime":"18:00","fileUrl":"https://media.example.test/episode.mp3","futureIdentifier":9007199254740993123}]}',
    },
    {
      station: 'nts',
      showId: 'nts.synthetic-show',
      text: '{"status":"published","show_alias":"synthetic-show","name":"Synthetic Show","embeds":{"episodes":{"metadata":{"resultset":{"count":1}},"results":[{"status":"published","name":"Fixture Artist","show_alias":"synthetic-show","episode_alias":"synthetic-episode","broadcast":"2025-12-12T12:00:00Z","futureIdentifier":9007199254740993123}]}}}',
    },
  ] satisfies { station: MixStation; showId: string; text: string }[])(
    'keeps unknown nested $station episode metadata in the raw JSON',
    async ({ station, showId, text }) => {
      const steps = [
        {
          operation: 'listShowEpisodes',
          args: {
            at,
            page: null,
            show: { id: showId, handle: 'synthetic-show' },
          },
        },
      ]
      const recorded = fixture(station, [
        new Response(text, { headers: { 'content-type': 'application/json' } }),
      ])
      const projected = await replayMixStationSteps(
        station,
        steps,
        recorded.request,
      )
      expect(projected).toMatchObject([
        { entries: [{ title: 'Fixture Artist' }] },
      ])
      expect(recorded.captures[0]?.response.body).toEqual({
        state: 'captured',
        text,
        redacted: false,
      })
      const replay = recorded.replay()
      await expect(
        replayMixStationSteps(station, steps, replay.requestFor('task')),
      ).resolves.toEqual(projected)
      replay.assertComplete()
    },
  )

  it('retains safe Lot Radio discovery evidence and exact data rows from the archive POST', async () => {
    const archiveRow =
      '3:{"items":[{"sys":{"id":"fixture-episode"},"slug":"fixture-episode","title":"Fixture Artist","date":"2025-12-12T12:00:00Z","show":{"sys":{"id":"fixture-show"},"slug":"fixture-show","name":"Fixture Show"},"futureIdentifier":9007199254740993123}],"pages":{"next":null}}\n'
    const recorded = fixture('lotradio', [
      new Response(
        `<aside>synthetic-advert</aside><script src="${chunk}"></script>`,
        { headers: { 'content-type': 'text/html' } },
      ),
      new Response(
        `let unrelated="private-fixture";createServerReference("${action}",x,"getEpisodes")`,
        { headers: { 'content-type': 'application/javascript' } },
      ),
      new Response('0:{"viewer":"synthetic-account"}\n' + archiveRow, {
        headers: { 'content-type': 'text/x-component' },
      }),
    ])
    const projected = await replayMixStationSteps(
      'lotradio',
      [feed],
      recorded.request,
    )
    const evidence = recorded.captures.map(({ response }) => response.body)
    expect(JSON.stringify(evidence)).not.toMatch(
      /synthetic-advert|private-fixture|synthetic-account/,
    )
    expect(projected).toMatchObject([
      { entries: [{ episode: { title: 'Fixture Artist' } }] },
    ])
    expect(evidence[0]).toMatchObject({
      retainedRepresentation: 'station-discovery',
    })
    expect(evidence[1]).toMatchObject({
      retainedRepresentation: 'station-discovery',
    })
    expect(evidence[2]).toEqual({
      state: 'captured',
      text: archiveRow,
      redacted: true,
      retainedRepresentation: 'station-episode-data',
    })
    expect(recorded.captures[2]?.request).toMatchObject({
      method: 'POST',
      url: lotIndex,
      key: expect.any(String),
    })
    const replay = recorded.replay()
    await expect(
      replayMixStationSteps('lotradio', [feed], replay.requestFor('task')),
    ).resolves.toEqual(projected)
    replay.assertComplete()
  })

  it('accepts only the scoped read action and matches canonical POST arguments in replay', async () => {
    const url = new URL(lotIndex)
    const policy = mixStationCapturePolicy('lotradio', () => action)
    const body = {
      limit: 100,
      order: 'date:asc',
      staffChoice: false,
      filters: {},
    }
    const init = {
      method: 'POST',
      headers: {
        accept: 'text/x-component',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': action,
      },
      body: JSON.stringify([body]),
    }
    expect(policy(url, init)).not.toBeNull()
    expect(
      policy(url, {
        ...init,
        body: '[{"limit":100,"order":"date:asc","staffChoice":true,"staffChoice":false,"filters":{}}]',
      }),
    ).toBeNull()
    expect(
      policy(url, {
        ...init,
        body: JSON.stringify([{ ...body, filters: { account: 'fixture' } }]),
      }),
    ).toBeNull()
    expect(
      policy(url, {
        ...init,
        headers: { ...init.headers, 'next-action': 'b'.repeat(40) },
      }),
    ).toBeNull()
    expect(
      policy(url, {
        ...init,
        headers: { ...init.headers, authorization: 'fixture' },
      }),
    ).toBeNull()
    expect(policy(new URL('/account', url), init)).toBeNull()
    const recorded = fixture('lotradio', [
      new Response('1:{"items":[]}\n', {
        headers: { 'content-type': 'text/x-component' },
      }),
    ])
    await recorded.request(url, init)
    const accepted = recorded.replay()
    await expect(
      accepted.request(url, {
        ...init,
        body: '[{"filters":{},"staffChoice":false,"order":"date:asc","limit":100}]',
      }),
    ).resolves.toBeInstanceOf(Response)
    accepted.assertComplete()
    const changed = recorded.replay()
    await expect(
      changed.request(url, {
        ...init,
        body: JSON.stringify([{ ...body, cursor: 'other-page' }]),
      }),
    ).rejects.toThrow('differs')
  })

  it('does not retain account or ad JSON returned by a public archive endpoint', async () => {
    const recorded = fixture('rinse', [
      Response.json({ entries: [], adPlacements: [{ tracking: true }] }),
    ])
    await replayMixStationSteps('rinse', [shows], recorded.request)
    expect(recorded.captures[0]?.response.body).toEqual({
      state: 'unavailable',
      reason: 'policy',
    })
  })
})
