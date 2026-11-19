import { z } from 'zod'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import { MixIdSchema, MixShowIdSchema } from '@repo/schemas/subscriptions'
import {
  distinctNames,
  type MixStationAdapter,
  type StationEpisode,
  type StationFeedEntry,
  type StationRequest,
  type StationShow,
} from './mix-station'

const LOT_RADIO_URL = 'https://www.thelotradio.com'
const INDEX_URL = `${LOT_RADIO_URL}/the-index`
/** The largest page the index's `getEpisodes` action serves. */
export const LOT_RADIO_PAGE_SIZE = 100
/** `recent` reads this far before `since` for sessions edited after they aired. */
const RECENT_MARGIN_MS = 14 * 24 * 60 * 60 * 1000
const IMAGE_PARAMS = { w: '800', fm: 'jpg', q: '80' }

type LotRadioOrder = 'date:asc' | 'date:desc'

const DateSchema = z.string().datetime({ offset: true })
const ImageSchema = z.object({ url: z.string().nullish() }).nullish()
const NamedListSchema = z
  .object({
    items: z
      .array(z.object({ name: z.string().nullish() }).nullable())
      .default([]),
  })
  .nullish()

const ShowSchema = z.object({
  sys: z.object({ id: z.string() }),
  name: z.string().nullish(),
  slug: z.string().nullish(),
  photo: ImageSchema,
  genres: NamedListSchema,
  artists: NamedListSchema,
})

const ItemSchema = z.object({
  sys: z.object({ id: z.string() }),
  title: z.string().nullish(),
  slug: z.string().nullish(),
  /** The scheduled start. */
  date: DateSchema.nullish(),
  startTimestamp: DateSchema.nullish(),
  endTimestamp: DateSchema.nullish(),
  transcodedFile: z
    .object({ hls: z.string().url().nullish().catch(null) })
    .nullish(),
  tracklist: z
    .array(
      z
        .object({ artist: z.string().nullish(), title: z.string().nullish() })
        .nullable(),
    )
    .nullish(),
  image: ImageSchema,
  thumbnailsCollection: z
    .object({ items: z.array(ImageSchema).default([]) })
    .nullish(),
  genres: NamedListSchema,
  artists: NamedListSchema,
  show: ShowSchema.nullish(),
})
type LotRadioItem = z.infer<typeof ItemSchema>

export const LotRadioEpisodePageSchema = z.object({
  items: z.array(ItemSchema).default([]),
  total: z.number().int().nonnegative().nullish(),
  pages: z.object({ next: z.string().min(1).nullish() }).nullish(),
})
type LotRadioEpisodePage = z.infer<typeof LotRadioEpisodePageSchema>

/** `(0,t.createServerReference)("<id>",t.callServer,void 0,t.findSourceMapURL,"getEpisodes")` */
const ACTION_REFERENCE =
  /createServerReference\)?\(\s*"([0-9a-f]{40,42})"\s*,[^()"]*"getEpisodes"\s*\)/
const SCRIPT_SRC = /<script\b[^>]*\bsrc="(\/_next\/static\/[^"]+\.js)"/g
const CHUNK_PATH = /\/_next\/static\/[A-Za-z0-9/_.~-]+\.js/g

/**
 * The chunks that may hold the action reference: the page's script tags last
 * first, since the page's own chunks follow the shared ones, then the chunks
 * named only in the inline flight data.
 */
export function lotRadioChunkPaths(html: string): string[] {
  const listed = [...html.matchAll(SCRIPT_SRC)].map((match) => match[1] ?? '')
  const named = [...html.matchAll(CHUNK_PATH)].map((match) => match[0])
  return [...new Set([...listed.reverse(), ...named])].filter(Boolean)
}

async function responseText(response: Response, what: string) {
  if (!response.ok)
    throw new Error(`The Lot Radio ${what} failed (HTTP ${response.status})`)
  return response.text()
}

/** The id of the index's `getEpisodes` server action, which changes with each deployment of the site. */
async function discoverAction(request: StationRequest): Promise<string> {
  const html = await responseText(await request(INDEX_URL), 'index page')
  for (const path of lotRadioChunkPaths(html)) {
    const chunk = await responseText(
      await request(new URL(path, LOT_RADIO_URL)),
      'script chunk',
    )
    const id = ACTION_REFERENCE.exec(chunk)?.[1]
    if (id) return id
  }
  throw new Error('The Lot Radio index no longer names its episode action')
}

/**
 * The JSON rows of a React flight response, with the references this action's
 * data can hold resolved: escaped `$` strings, dates, omitted values and long
 * strings sent as separate text rows.
 */
export function lotRadioFlightRows(text: string): unknown[] {
  const bytes = Buffer.from(text, 'utf8')
  const texts = new Map<string, string>()
  const rows: string[] = []
  let at = 0
  while (at < bytes.length) {
    const newline = bytes.indexOf(0x0a, at)
    const lineEnd = newline < 0 ? bytes.length : newline
    const colon = bytes.indexOf(0x3a, at)
    const id = colon < 0 ? '' : bytes.toString('utf8', at, colon)
    if (colon < 0 || colon > lineEnd || !/^[0-9a-f]+$/.test(id)) {
      at = lineEnd + 1
      continue
    }
    // A text row is `<id>:T<hex byte length>,<text>` with no terminator.
    const comma = bytes.indexOf(0x2c, colon)
    const length =
      bytes[colon + 1] === 0x54 && comma > colon
        ? Number.parseInt(bytes.toString('utf8', colon + 2, comma), 16)
        : Number.NaN
    if (Number.isSafeInteger(length) && length >= 0) {
      texts.set(id, bytes.toString('utf8', comma + 1, comma + 1 + length))
      at = comma + 1 + length
      continue
    }
    rows.push(bytes.toString('utf8', colon + 1, lineEnd))
    at = lineEnd + 1
  }
  const revive = (_key: string, value: unknown): unknown => {
    if (typeof value !== 'string' || !value.startsWith('$')) return value
    if (value.startsWith('$$')) return value.slice(1)
    if (value === '$undefined') return undefined
    if (value.startsWith('$D')) return value.slice(2)
    return texts.get(value.slice(1)) ?? value
  }
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row, revive)]
    } catch {
      return []
    }
  })
}

function dataRow(text: string): unknown {
  return lotRadioFlightRows(text).find(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      'items' in row &&
      Array.isArray(row.items),
  )
}

/**
 * One page through the action, or null when the action is unknown to the site
 * or answers without data. Failures the request gate put a backoff on, and
 * rate limits, cooldowns and denials, are thrown.
 */
async function postPage(
  request: StationRequest,
  action: string,
  order: LotRadioOrder,
  cursor: string | null,
): Promise<unknown> {
  const query =
    cursor === null
      ? { limit: LOT_RADIO_PAGE_SIZE, order, filters: {}, staffChoice: false }
      : {
          limit: LOT_RADIO_PAGE_SIZE,
          cursor,
          order,
          filters: {},
          staffChoice: false,
        }
  let response: Response
  try {
    response = await request(INDEX_URL, {
      method: 'POST',
      headers: {
        accept: 'text/x-component',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': action,
      },
      body: JSON.stringify([query]),
    })
  } catch (error) {
    if (
      error instanceof ProviderRequestError &&
      error.code === 'request-failed' &&
      error.retryAt === null
    )
      return null
    throw error
  }
  if (!response.ok) return null
  return dataRow(await response.text()) ?? null
}

/** An absolute web address, or null for anything else. */
function httpUrl(value: string | null | undefined): URL | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value.startsWith('//') ? `https:${value}` : value)
  } catch {
    return null
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
}

/** An absolute image URL; Contentful images are asked for at a fixed JPEG size. */
function imageUrl(value: string | null | undefined): string | null {
  const url = httpUrl(value)
  if (!url) return null
  if (url.hostname === 'images.ctfassets.net')
    for (const [key, param] of Object.entries(IMAGE_PARAMS))
      url.searchParams.set(key, param)
  return url.toString()
}

function names(list: z.infer<typeof NamedListSchema>) {
  return distinctNames((list?.items ?? []).map((entry) => entry?.name))
}

function normalizeShow(show: z.infer<typeof ShowSchema>): StationShow | null {
  const id = MixShowIdSchema.safeParse(`lotradio.${show.sys.id}`)
  const handle = show.slug?.trim()
  const title = show.name?.trim()
  if (!id.success || !handle || !title) return null
  return {
    id: id.data,
    title,
    handle,
    description: null,
    thumbnailUrl: imageUrl(show.photo?.url),
    url: `${LOT_RADIO_URL}/shows/${encodeURIComponent(handle)}`,
    itemTotal: null,
  }
}

function durationSeconds(
  start: string | null | undefined,
  end: string | null | undefined,
) {
  if (!start || !end) return null
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000)
  return seconds > 0 ? seconds : null
}

/** The tracklist as `Artist - Title` lines, so a session is found by a track played in it. */
function tracklistText(tracklist: LotRadioItem['tracklist']) {
  return (tracklist ?? [])
    .map((track) =>
      [track?.artist?.trim(), track?.title?.trim()].filter(Boolean).join(' - '),
    )
    .filter(Boolean)
    .join('\n')
}

/** A session with its show, or null when it lacks a show, slug or date, has not started, or its ids are unusable. */
export function normalizeLotRadioItem(
  item: LotRadioItem,
  now: Date,
): StationFeedEntry | null {
  const show = item.show ? normalizeShow(item.show) : null
  const slug = item.slug?.trim()
  const id = MixIdSchema.safeParse(`lotradio.${item.sys.id}`)
  if (!show || !slug || !item.date || !id.success) return null
  if (Date.parse(item.date) > now.getTime()) return null
  const artists = names(item.artists)
  const tags = names(item.genres)
  const episode: StationEpisode = {
    id: id.data,
    title: item.title?.trim() || show.title,
    description: tracklistText(item.tracklist),
    url: `${show.url}/${encodeURIComponent(slug)}`,
    audioUrl: httpUrl(item.transcodedFile?.hls)?.toString() ?? null,
    artworkUrl:
      imageUrl(item.image?.url) ??
      imageUrl(item.thumbnailsCollection?.items[0]?.url) ??
      show.thumbnailUrl,
    publishedAt: new Date(item.startTimestamp ?? item.date),
    durationSec: durationSeconds(item.startTimestamp, item.endTimestamp),
    artists: artists.length ? artists : names(item.show?.artists),
    tags: tags.length ? tags : names(item.show?.genres),
  }
  return { show, showPartial: false, episode }
}

/**
 * The Lot Radio publishes no catalogue: its index lists every archived session
 * with its show, read through the page's own `getEpisodes` server action. The
 * action's id is found in the page's scripts and kept for the adapter's life;
 * a failed page discovers it again and retries once.
 */
export function createLotRadioAdapter(
  now: () => Date = () => new Date(),
): MixStationAdapter {
  let action: string | null = null

  const readPage = async (
    request: StationRequest,
    order: LotRadioOrder,
    cursor: string | null,
  ): Promise<LotRadioEpisodePage> => {
    action ??= await discoverAction(request)
    let data = await postPage(request, action, order, cursor)
    if (data === null) {
      action = await discoverAction(request)
      data = await postPage(request, action, order, cursor)
    }
    if (data === null)
      throw new Error('The Lot Radio index returned no episode page')
    const parsed = LotRadioEpisodePageSchema.safeParse(data)
    if (!parsed.success)
      throw new Error('The Lot Radio returned an invalid episode page')
    return parsed.data
  }

  return {
    station: 'lotradio',
    catalogue: null,
    getShow: null,
    listFeed: async (request, mode, page, since) => {
      const data = await readPage(
        request,
        mode === 'archive' ? 'date:asc' : 'date:desc',
        page,
      )
      const at = now()
      const entries = data.items.flatMap((item) => {
        const entry = normalizeLotRadioItem(item, at)
        return entry ? [entry] : []
      })
      const before = since === null ? null : since.getTime() - RECENT_MARGIN_MS
      const pastSince =
        mode === 'recent' &&
        before !== null &&
        data.items.every(
          (item) => item.date != null && Date.parse(item.date) < before,
        )
      return {
        entries,
        next:
          data.items.length === 0 || pastSince
            ? null
            : (data.pages?.next ?? null),
        total: data.total ?? null,
        truncated: false,
      }
    },
  }
}

export const lotRadioAdapter = createLotRadioAdapter()
