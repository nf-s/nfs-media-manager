import { z } from 'zod'
import { isProviderItemNotFoundError } from '@repo/media-plugin-sdk'
import { MixIdSchema, MixShowIdSchema } from '@repo/schemas/subscriptions'
import {
  distinctNames,
  htmlText,
  splitBilledArtists,
  type MixStationAdapter,
  type StationEpisode,
  type StationFeedEntry,
  type StationRequest,
  type StationShow,
} from './mix-station'

const SITE = 'https://www.rinse.fm'
const API = `${SITE}/api/query/v1`
/** Shows per catalogue page; a shorter page is the last. */
export const RINSE_CATALOGUE_PAGE_SIZE = 20
const DEFAULT_ZONE = 'Europe/London'
const DAY_MS = 86_400_000
/** A display title that bills guests after the lead: "with Goldie & Cleveland Watkiss". */
const GUEST_BILLING =
  /^(?:with|w\/|b2b|b3b|and|&|x|vs\.?|feat\.?|ft\.?|featuring)\s+/i
/** How far before `since` the day feed starts, for late uploads and changes. */
const FEED_MARGIN_DAYS = 14
/** The oldest first day the feed reads; an older start is left to the catalogue. */
const FEED_MAX_DAYS = 60

const IdSchema = z.union([z.string(), z.number()]).transform(String)
const TextSchema = z.string().nullable().optional()
const ImagesSchema = z
  .array(z.object({ filename: z.string().nullable().optional() }))
  .nullable()
  .optional()
const GenreTagsSchema = z
  .array(
    z.object({
      title: TextSchema,
      isVisibleTag: z.boolean().nullable().optional(),
    }),
  )
  .nullable()
  .optional()
const ChannelsSchema = z
  .array(z.object({ defaultTimezoneOffset: TextSchema }))
  .nullable()
  .optional()

const RinseShowSchema = z.object({
  id: IdSchema,
  slug: z.string().min(1),
  title: z.string(),
  extract: TextSchema,
  featuredImage: ImagesSchema,
  defaultEpisodeImage: ImagesSchema,
  genreTag: GenreTagsSchema,
  channel: ChannelsSchema,
})
type RinseShow = z.infer<typeof RinseShowSchema>

const RinseEpisodeSchema = z.object({
  id: IdSchema,
  slug: z.string().min(1),
  artistTitle: TextSchema,
  displayTitle: TextSchema,
  subtitle: TextSchema,
  extract: TextSchema,
  episodeDate: TextSchema,
  episodeTime: TextSchema,
  episodeLength: z.number().nonnegative().nullable().optional().catch(null),
  fileUrl: TextSchema,
  youtubeStreamUrl: TextSchema,
  isRebroadcast: z.boolean().nullable().optional(),
  featuredImage: ImagesSchema,
  genreTag: GenreTagsSchema,
  channel: ChannelsSchema,
  parentShow: z.array(RinseShowSchema).nullable().optional(),
})
type RinseEpisode = z.infer<typeof RinseEpisodeSchema>

export const RinseShowPageSchema = z.object({
  entries: z.array(RinseShowSchema).default([]),
})
export const RinseShowDetailSchema = z.object({
  entry: RinseShowSchema.extend({ description: TextSchema }),
  episodes: z.array(RinseEpisodeSchema).default([]),
})
export const RinseSchedulePageSchema = z.object({
  entries: z.array(RinseEpisodeSchema).default([]),
})

async function rinseJson<T>(
  request: StationRequest,
  path: string,
  schema: z.ZodType<T, unknown>,
  options?: { notFoundOn404?: boolean },
): Promise<T> {
  const response = await request(
    `${API}/${path}`,
    { headers: { Accept: 'application/json' } },
    options,
  )
  if (!response.ok)
    throw new Error(`Rinse request failed (HTTP ${response.status})`)
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Rinse returned an invalid response')
  }
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new Error('Rinse returned an invalid response')
  return parsed.data
}

function text(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function imageUrl(
  ...sets: (z.infer<typeof ImagesSchema> | undefined)[]
): string | null {
  for (const images of sets) {
    const filename = text(images?.[0]?.filename)
    if (filename)
      return `https://image.rinse.fm/_/${encodeURIComponent(filename)}?w=800&h=800`
  }
  return null
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The zone's formatter; an unknown zone falls back to London, the station's home. */
function zoneFormatter(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone)
  if (cached) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return zoneFormatter(DEFAULT_ZONE)
  }
  formatters.set(zone, formatter)
  return formatter
}

/** The wall-clock reading of an instant in a zone, as if that reading were UTC. */
function wallClock(instant: number, zone: string): number {
  const parts = zoneFormatter(zone).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0)
  return Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  )
}

/** The instant a wall-clock time in a zone names, both given in milliseconds. */
function zonedInstant(local: number, zone: string): number {
  const offset = (instant: number) =>
    wallClock(instant, zone) - Math.floor(instant / 1000) * 1000
  const first = local - offset(local)
  // A guess across a clock change is off by the change; the second pass settles it.
  return local - offset(first)
}

/**
 * When an episode started. `episodeDate` is local midnight of the broadcast
 * day, given as an instant (so a summer date reads as 23:00 the day before in
 * UTC); `episodeTime` carries the local start in its time of day only.
 */
function broadcastStart(episode: RinseEpisode, zone: string): Date | null {
  const day = Date.parse(episode.episodeDate ?? '')
  if (!Number.isFinite(day)) return null
  const localDay = Math.floor(wallClock(day, zone) / DAY_MS) * DAY_MS
  const time = /T(\d{2}):(\d{2})/.exec(episode.episodeTime ?? '')
  const minutes = time ? Number(time[1]) * 60 + Number(time[2]) : 0
  const start = zonedInstant(localDay + minutes * 60_000, zone)
  return Number.isFinite(start) ? new Date(start) : null
}

/** The recording the site itself plays: an MP3 file, else the YouTube stream. */
function recordingUrl(episode: RinseEpisode): string | null {
  for (const candidate of [episode.fileUrl, episode.youtubeStreamUrl]) {
    const value = text(candidate)
    if (!URL.canParse(value)) continue
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    if (
      candidate === episode.fileUrl &&
      !url.pathname.toLowerCase().endsWith('.mp3')
    )
      continue
    return url.href
  }
  return null
}

export function normalizeRinseShow(
  show: RinseShow & { description?: string | null },
): StationShow | null {
  const id = MixShowIdSchema.safeParse(`rinse.${show.id}`)
  const title = text(show.title)
  if (!id.success || !title) return null
  return {
    id: id.data,
    title,
    handle: show.slug,
    description: text(show.extract) || htmlText(show.description) || null,
    thumbnailUrl: imageUrl(show.featuredImage, show.defaultEpisodeImage),
    url: `${SITE}/shows/${encodeURIComponent(show.slug)}`,
    itemTotal: null,
  }
}

/**
 * The stored episode, or null for a rebroadcast or an episode without a
 * recording yet. The title matches the site's heading: the billing name, then
 * the display title or subtitle.
 */
export function normalizeRinseEpisode(
  episode: RinseEpisode,
  show: RinseShow,
): StationEpisode | null {
  if (episode.isRebroadcast === true) return null
  const audioUrl = recordingUrl(episode)
  const id = MixIdSchema.safeParse(`rinse.${episode.id}`)
  const billing = text(episode.artistTitle) || text(show.title)
  const zone =
    text(episode.channel?.[0]?.defaultTimezoneOffset) ||
    text(show.channel?.[0]?.defaultTimezoneOffset) ||
    DEFAULT_ZONE
  const publishedAt = broadcastStart(episode, zone)
  if (!audioUrl || !id.success || !billing || !publishedAt) return null
  const heading = text(episode.displayTitle) || text(episode.subtitle)
  const guests = GUEST_BILLING.test(heading)
    ? splitBilledArtists(heading.replace(GUEST_BILLING, ''))
    : []
  return {
    id: id.data,
    title: heading ? `${billing} ${heading}` : billing,
    description: (episode.extract ?? '').trim(),
    url: `${SITE}/episodes/${encodeURIComponent(episode.slug)}`,
    audioUrl,
    artworkUrl: imageUrl(
      episode.featuredImage,
      show.featuredImage,
      show.defaultEpisodeImage,
    ),
    publishedAt,
    durationSec:
      episode.episodeLength == null
        ? null
        : Math.round(episode.episodeLength * 60),
    artists: distinctNames([...splitBilledArtists(billing), ...guests]),
    tags: distinctNames(
      (episode.genreTag ?? [])
        .filter((tag) => tag.isVisibleTag !== false)
        .map((tag) => tag.title),
    ),
  }
}

const DateTokenSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value,
  )

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(day: string, days: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS))
}

function pageIndex(page: string | null): number {
  if (page === null) return 0
  if (!/^\d{1,6}$/.test(page)) throw new Error('Invalid Rinse catalogue page')
  return Number(page)
}

export function createRinseAdapter(
  now: () => Date = () => new Date(),
): MixStationAdapter {
  return {
    station: 'rinse',
    catalogue: {
      async listShows(request, page) {
        const index = pageIndex(page)
        const result = await rinseJson(
          request,
          `shows/filter?offset=${index}`,
          RinseShowPageSchema,
        )
        return {
          entries: result.entries.flatMap(
            (show) => normalizeRinseShow(show) ?? [],
          ),
          next:
            result.entries.length >= RINSE_CATALOGUE_PAGE_SIZE
              ? String(index + 1)
              : null,
          total: null,
        }
      },
      async listShowEpisodes(request, show) {
        let result: z.infer<typeof RinseShowDetailSchema>
        try {
          result = await rinseJson(
            request,
            `shows/${encodeURIComponent(show.handle)}`,
            RinseShowDetailSchema,
            { notFoundOn404: true },
          )
        } catch (error) {
          // A show Rinse has removed has no episodes; its stored ones are kept.
          if (!isProviderItemNotFoundError(error)) throw error
          return { entries: [], next: null, total: 0 }
        }
        const entries = result.episodes
          .flatMap(
            (episode) =>
              normalizeRinseEpisode(
                episode,
                episode.parentShow?.[0] ?? result.entry,
              ) ?? [],
          )
          .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
        return { entries, next: null, total: entries.length }
      },
    },
    async listFeed(request, _mode, page, since) {
      const today = utcDay(now())
      let day: string
      if (page === null) {
        day = utcDay(
          new Date((since ?? now()).getTime() - FEED_MARGIN_DAYS * DAY_MS),
        )
        if (day < addDays(today, -FEED_MAX_DAYS))
          return { entries: [], next: null, total: null, truncated: true }
      } else {
        const token = DateTokenSchema.safeParse(page)
        if (!token.success) throw new Error('Invalid Rinse feed page')
        day = token.data
      }
      const result = await rinseJson(
        request,
        `schedule/${day}`,
        RinseSchedulePageSchema,
      )
      const entries: StationFeedEntry[] = []
      for (const episode of result.entries) {
        const parent = episode.parentShow?.[0]
        if (!parent) continue
        const show = normalizeRinseShow(parent)
        const stored = normalizeRinseEpisode(episode, parent)
        if (show && stored)
          entries.push({ show, showPartial: false, episode: stored })
      }
      return {
        entries,
        next: day >= today ? null : addDays(day, 1),
        total: null,
        truncated: false,
      }
    },
    getShow: null,
  }
}

export const rinseAdapter = createRinseAdapter()
