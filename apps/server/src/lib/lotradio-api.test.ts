import { describe, expect, it } from 'vitest'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import { createLotRadioAdapter, lotRadioFlightRows } from './lotradio-api'
import type { StationRequest } from './mix-station'

const ACTION = 'a'.repeat(42)
const NEXT_ACTION = 'b'.repeat(40)
const INDEX = 'https://www.thelotradio.com/the-index'
const CHUNK_URL = 'https://www.thelotradio.com/_next/static/immutable/chunks/'
const NOW = new Date('2026-06-30T00:00:00Z')

function indexHtml() {
  return [
    '<html><head>',
    '<script src="/_next/static/immutable/chunks/shared.js" async=""></script>',
    '<script src="/_next/static/immutable/chunks/page.js" async=""></script>',
    '<script src="/_next/static/immutable/chunks/other.js" async=""></script>',
    '</head><body><script>self.__next_f.push([1,"8:\\"/_next/static/immutable/chunks/late.js\\"\\n"])</script></body></html>',
  ].join('')
}

function chunkWith(action: string) {
  return `;var t=e.i(1);let s=(0,t.createServerReference)("${'c'.repeat(42)}",t.callServer,void 0,t.findSourceMapURL,"getHosts"),r=(0,t.createServerReference)("${action}",t.callServer,void 0,t.findSourceMapURL,"getEpisodes");`
}

function show(overrides: Record<string, unknown> = {}) {
  return {
    sys: { id: 'show1' },
    name: 'Example Hour',
    slug: 'example-hour',
    photo: { url: 'https://images.ctfassets.net/space/show1/photo.png' },
    genres: { items: [{ name: 'Ambient', slug: 'ambient' }] },
    artists: { items: [{ name: 'Fixture Host', slug: 'fixture-host' }] },
    ...overrides,
  }
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    sys: { id: 'session1' },
    title: 'Example Hour with Fixture Guest',
    slug: '2026-06-01-2000',
    date: '2026-06-02T00:00:00.000Z',
    startTimestamp: '2026-06-02T00:01:40.000Z',
    endTimestamp: '2026-06-02T01:00:40.400Z',
    transcodedFile: {
      hls: 'https://cdn.thelotradio.com/episodes/session1/hls/index.m3u8',
      mp4: [],
    },
    tracklist: [
      {
        timestamp: '2026-06-02T00:02:00.000Z',
        artist: 'Imaginary Band',
        title: 'Made Up Song',
      },
      {
        timestamp: '2026-06-02T00:06:00.000Z',
        artist: 'Second Act',
        title: '',
      },
    ],
    image: { url: 'https://images.ctfassets.net/space/img1/cover.jpg' },
    thumbnailsCollection: {
      items: [{ url: 'https://images.ctfassets.net/space/thumb1/t.png' }],
    },
    location: { name: 'Fixture Lot' },
    genres: { items: [{ name: 'House', slug: 'house' }, { name: 'house' }] },
    artists: { items: [{ name: 'Fixture Guest', slug: 'fixture-guest' }] },
    show: show(),
    ...overrides,
  }
}

function flight(data: Record<string, unknown>, rowId = '1') {
  return `0:{"a":"$@${rowId}","q":"","i":false}\n${rowId}:${JSON.stringify(data)}\n`
}

function page(
  items: unknown[],
  next: string | null = 'cursor-2',
): Record<string, unknown> {
  return { items, total: 1234, pages: { next, prev: null } }
}

type Call = { url: string; init: RequestInit | undefined }

function fakeSite(
  options: {
    actions?: string[]
    pages?: (Response | Error)[]
  } = {},
) {
  const actions = [...(options.actions ?? [ACTION])]
  const pages = [...(options.pages ?? [])]
  const calls: Call[] = []
  let currentAction = actions.shift() ?? ACTION
  const request: StationRequest = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url) === INDEX && !init?.method) {
      return new Response(indexHtml(), {
        headers: { 'content-type': 'text/html' },
      })
    }
    if (String(url) === `${CHUNK_URL}other.js`)
      return new Response(';console.info("no actions here")')
    if (String(url) === `${CHUNK_URL}page.js`) {
      const served = currentAction
      currentAction = actions.shift() ?? currentAction
      return new Response(chunkWith(served))
    }
    if (String(url) === INDEX && init?.method === 'POST') {
      const next = pages.shift()
      if (!next) throw new Error('No page left')
      if (next instanceof Error) throw next
      return next
    }
    return new Response('not found', { status: 404 })
  }
  return { request, calls }
}

function flightResponse(text: string) {
  return new Response(text, { headers: { 'content-type': 'text/x-component' } })
}

function bodyOf(call: Call | undefined) {
  const body = call?.init?.body
  return typeof body === 'string' ? JSON.parse(body) : null
}

function posts(calls: Call[]) {
  return calls.filter((call) => call.init?.method === 'POST')
}

describe('lotRadioAdapter', () => {
  it('finds the action in the page chunks and keeps it across pages', async () => {
    const { request, calls } = fakeSite({
      pages: [
        flightResponse(flight(page([item()]))),
        flightResponse(flight(page([item()], null))),
      ],
    })
    const adapter = createLotRadioAdapter(() => NOW)
    const first = await adapter.listFeed(request, 'archive', null, null)
    const second = await adapter.listFeed(request, 'archive', 'cursor-2', null)

    expect(calls.map((call) => call.url)).toEqual([
      INDEX,
      `${CHUNK_URL}other.js`,
      `${CHUNK_URL}page.js`,
      INDEX,
      INDEX,
    ])
    expect(first).toMatchObject({
      next: 'cursor-2',
      total: 1234,
      truncated: false,
    })
    expect(second.next).toBeNull()

    const [firstPost, secondPost] = posts(calls)
    expect(firstPost?.init?.headers).toEqual({
      accept: 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': ACTION,
    })
    expect(bodyOf(firstPost)).toEqual([
      { limit: 100, order: 'date:asc', filters: {}, staffChoice: false },
    ])
    expect(bodyOf(secondPost)).toEqual([
      {
        limit: 100,
        cursor: 'cursor-2',
        order: 'date:asc',
        filters: {},
        staffChoice: false,
      },
    ])
  })

  it('reads recent sessions newest first', async () => {
    const { request, calls } = fakeSite({
      pages: [
        flightResponse(flight(page([item()]))),
        flightResponse(flight(page([item()]))),
      ],
    })
    const adapter = createLotRadioAdapter(() => NOW)
    const first = await adapter.listFeed(request, 'recent', null, null)
    await adapter.listFeed(request, 'recent', 'cursor-2', null)

    expect(first.next).toBe('cursor-2')
    expect(posts(calls).map(bodyOf)).toEqual([
      [{ limit: 100, order: 'date:desc', filters: {}, staffChoice: false }],
      [
        {
          limit: 100,
          cursor: 'cursor-2',
          order: 'date:desc',
          filters: {},
          staffChoice: false,
        },
      ],
    ])
  })

  it('discovers the action again and retries once after a failed page', async () => {
    const { request, calls } = fakeSite({
      actions: [ACTION, NEXT_ACTION],
      pages: [
        new Response('Server Action unavailable.', { status: 409 }),
        flightResponse(flight(page([item()]))),
      ],
    })
    const result = await createLotRadioAdapter(() => NOW).listFeed(
      request,
      'archive',
      null,
      null,
    )

    expect(result.entries).toHaveLength(1)
    expect(
      posts(calls).map((call) =>
        new Headers(call.init?.headers).get('next-action'),
      ),
    ).toEqual([ACTION, NEXT_ACTION])
  })

  it('retries after a request gate failure without a backoff', async () => {
    const { request } = fakeSite({
      pages: [
        new ProviderRequestError(
          'Provider request failed (HTTP 409)',
          'request-failed',
        ),
        flightResponse(flight(page([item()]))),
      ],
    })
    const result = await createLotRadioAdapter(() => NOW).listFeed(
      request,
      'archive',
      null,
      null,
    )
    expect(result.entries).toHaveLength(1)
  })

  it('does not retry a rate limit', async () => {
    const limited = new ProviderRequestError(
      'Provider rate limit reached (HTTP 429)',
      'rate-limit',
      NOW.getTime(),
    )
    const { request, calls } = fakeSite({ pages: [limited] })
    await expect(
      createLotRadioAdapter(() => NOW).listFeed(request, 'archive', null, null),
    ).rejects.toBe(limited)
    expect(posts(calls)).toHaveLength(1)
  })

  it('throws when the retried page also has no data', async () => {
    const { request, calls } = fakeSite({
      pages: [flightResponse('0:{"a":"$@1"}\n'), flightResponse('0:{}\n')],
    })
    await expect(
      createLotRadioAdapter(() => NOW).listFeed(request, 'archive', null, null),
    ).rejects.toThrow('no episode page')
    expect(posts(calls)).toHaveLength(2)
  })

  it('throws when no chunk names the action', async () => {
    const request: StationRequest = async (url) =>
      new Response(String(url) === INDEX ? indexHtml() : ';')
    await expect(
      createLotRadioAdapter(() => NOW).listFeed(request, 'archive', null, null),
    ).rejects.toThrow('no longer names its episode action')
  })

  it('maps a session and its show', async () => {
    const { request } = fakeSite({
      pages: [flightResponse(flight(page([item()]), '3a'))],
    })
    const result = await createLotRadioAdapter(() => NOW).listFeed(
      request,
      'archive',
      null,
      null,
    )

    expect(result.entries).toEqual([
      {
        show: {
          id: 'lotradio.show1',
          title: 'Example Hour',
          handle: 'example-hour',
          description: null,
          thumbnailUrl:
            'https://images.ctfassets.net/space/show1/photo.png?w=800&fm=jpg&q=80',
          url: 'https://www.thelotradio.com/shows/example-hour',
          itemTotal: null,
        },
        showPartial: false,
        episode: {
          id: 'lotradio.session1',
          title: 'Example Hour with Fixture Guest',
          description: 'Imaginary Band - Made Up Song\nSecond Act',
          url: 'https://www.thelotradio.com/shows/example-hour/2026-06-01-2000',
          audioUrl:
            'https://cdn.thelotradio.com/episodes/session1/hls/index.m3u8',
          artworkUrl:
            'https://images.ctfassets.net/space/img1/cover.jpg?w=800&fm=jpg&q=80',
          publishedAt: new Date('2026-06-02T00:01:40.000Z'),
          durationSec: 3540,
          artists: ['Fixture Guest'],
          tags: ['House'],
          tracklist: [
            { artist: 'Imaginary Band', title: 'Made Up Song', position: 1 },
          ],
        },
      },
    ])
  })

  it('falls back to the thumbnail, the show photo and the show credits', async () => {
    const bare = {
      image: null,
      tracklist: null,
      transcodedFile: null,
      startTimestamp: null,
      endTimestamp: null,
      genres: { items: [] },
      artists: undefined,
    }
    const { request } = fakeSite({
      pages: [
        flightResponse(
          flight(
            page([
              item({ ...bare, sys: { id: 'withThumb' } }),
              item({
                ...bare,
                sys: { id: 'withPhoto' },
                thumbnailsCollection: { items: [] },
              }),
              item({
                ...bare,
                sys: { id: 'noArtwork' },
                thumbnailsCollection: null,
                // Only a web address is kept as the recording.
                transcodedFile: { hls: 'javascript:void(0)' },
                show: show({ photo: null }),
              }),
            ]),
          ),
        ),
      ],
    })
    const result = await createLotRadioAdapter(() => NOW).listFeed(
      request,
      'archive',
      null,
      null,
    )
    expect(result.entries.map((entry) => entry.episode)).toEqual([
      expect.objectContaining({
        artworkUrl:
          'https://images.ctfassets.net/space/thumb1/t.png?w=800&fm=jpg&q=80',
      }),
      expect.objectContaining({
        artworkUrl:
          'https://images.ctfassets.net/space/show1/photo.png?w=800&fm=jpg&q=80',
      }),
      expect.objectContaining({ artworkUrl: null, audioUrl: null }),
    ])
    expect(result.entries[0]?.episode).toMatchObject({
      audioUrl: null,
      description: '',
      publishedAt: new Date('2026-06-02T00:00:00.000Z'),
      durationSec: null,
      artists: ['Fixture Host'],
      tags: ['Ambient'],
    })
  })

  it.each([
    { name: 'no show', overrides: { show: null } },
    {
      name: 'a show without a slug',
      overrides: { show: show({ slug: null }) },
    },
    { name: 'no slug', overrides: { slug: '' } },
    { name: 'no date', overrides: { date: null } },
    { name: 'an unusable id', overrides: { sys: { id: '-bad id' } } },
    {
      name: 'an unusable show id',
      overrides: { show: show({ sys: { id: 'bad id' } }) },
    },
    {
      name: 'a start after now',
      overrides: { date: '2026-07-01T00:00:00.000Z' },
    },
  ])('skips a session with $name', async ({ overrides }) => {
    const { request } = fakeSite({
      pages: [flightResponse(flight(page([item(overrides)])))],
    })
    const result = await createLotRadioAdapter(() => NOW).listFeed(
      request,
      'archive',
      null,
      null,
    )
    expect(result.entries).toEqual([])
    expect(result.next).toBe('cursor-2')
  })

  it('stops a recent read once a page is entirely 14 days before since', async () => {
    const since = new Date('2026-06-20T00:00:00Z')
    const old = item({ date: '2026-06-05T23:00:00.000Z' })
    const inMargin = item({ date: '2026-06-06T01:00:00.000Z' })
    const { request } = fakeSite({
      pages: [
        flightResponse(flight(page([inMargin, old]))),
        flightResponse(flight(page([old]))),
        flightResponse(flight(page([old]))),
      ],
    })
    const adapter = createLotRadioAdapter(() => NOW)
    expect((await adapter.listFeed(request, 'recent', null, since)).next).toBe(
      'cursor-2',
    )
    const stopped = await adapter.listFeed(request, 'recent', 'cursor-2', since)
    expect(stopped.next).toBeNull()
    expect(stopped.entries).toHaveLength(1)
    expect(
      (await adapter.listFeed(request, 'archive', 'cursor-2', since)).next,
    ).toBe('cursor-2')
  })

  it('ends at an empty page or a page without a cursor', async () => {
    const { request } = fakeSite({
      pages: [
        flightResponse(flight(page([], 'cursor-3'))),
        flightResponse(flight({ items: [item()], total: 1 })),
      ],
    })
    const adapter = createLotRadioAdapter(() => NOW)
    expect(await adapter.listFeed(request, 'archive', null, null)).toEqual({
      entries: [],
      next: null,
      total: 1234,
      truncated: false,
    })
    const last = await adapter.listFeed(request, 'archive', 'cursor-2', null)
    expect(last).toMatchObject({ next: null, total: 1 })
  })

  it.each([
    { name: 'items that are not objects', data: { items: ['x'], total: 1 } },
    { name: 'a negative total', data: { items: [], total: -1 } },
    { name: 'an invalid date', data: { items: [item({ date: 'soon' })] } },
  ])('rejects a page with $name', async ({ data }) => {
    const { request } = fakeSite({ pages: [flightResponse(flight(data))] })
    await expect(
      createLotRadioAdapter(() => NOW).listFeed(request, 'archive', null, null),
    ).rejects.toThrow('invalid episode page')
  })

  it('has no catalogue and no show lookup', () => {
    const adapter = createLotRadioAdapter()
    expect(adapter).toMatchObject({
      station: 'lotradio',
      catalogue: null,
      getShow: null,
    })
  })
})

describe('lotRadioFlightRows', () => {
  it('resolves text rows, escaped strings, dates and omitted values', () => {
    const text = 'Línea larga\nwith a newline'
    const bytes = Buffer.byteLength(text).toString(16)
    const rows = lotRadioFlightRows(
      [
        `0:{"a":"$@1"}`,
        `2:T${bytes},${text}1:{"items":[],"note":"$2","price":"$$5","at":"$D2026-01-01T00:00:00.000Z","gone":"$undefined"}`,
        'not a row',
        '3:{broken',
        '',
      ].join('\n'),
    )
    expect(rows).toEqual([
      { a: '$@1' },
      { items: [], note: text, price: '$5', at: '2026-01-01T00:00:00.000Z' },
    ])
  })
})
