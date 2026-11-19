import { z } from 'zod'
import { isProviderItemNotFoundError } from '@repo/media-plugin-sdk'
import { MixIdSchema, MixShowIdSchema } from '@repo/schemas/subscriptions'
import {
  distinctNames,
  splitBilledArtists,
  type MixStationAdapter,
  type StationEpisode,
  type StationFeedEntry,
  type StationRequest,
  type StationShow,
} from './mix-station'

const NTS_API = 'https://www.nts.live/api/v2/'
const NTS_SITE = 'https://www.nts.live/shows/'

/** NTS reduces any larger `limit` to 12. */
export const NTS_PAGE_SIZE = 12

/**
 * The deepest offset the recently-added collection serves: 240 returned a
 * page and every multiple of 12 from 252 to 960 returned HTTP 422. Observed
 * in November 2026, not documented, so it may change.
 */
export const NTS_FEED_MAX_OFFSET = 240

/**
 * The feed stops at a page broadcast entirely this long before `since`. An
 * episode is listed a day or so after it airs, and the offsets the feed serves
 * reach about eleven days back, so the margin covers the upload delay and
 * leaves a weekly sync inside the feed.
 */
const FEED_MARGIN_MS = 3 * 24 * 60 * 60 * 1000

const GUEST_SEPARATOR = /\s+w\/\s+/i

const NamedValueSchema = z.object({ value: z.string().nullish() })

const MediaSchema = z
  .object({
    picture_large: z.string().nullish(),
    picture_medium_large: z.string().nullish(),
    picture_medium: z.string().nullish(),
  })
  .nullish()

export const NtsShowSchema = z.object({
  status: z.string().nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  show_alias: z.string().nullish(),
  media: MediaSchema,
})
export type NtsShow = z.infer<typeof NtsShowSchema>

export const NtsEpisodeSchema = z.object({
  status: z.string().nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  show_alias: z.string().nullish(),
  episode_alias: z.string().nullish(),
  broadcast: z.string().nullish(),
  genres: z.array(NamedValueSchema).nullish(),
  audio_sources: z.array(z.object({ url: z.string().nullish() })).nullish(),
  /** An older episode's Mixcloud page, from before `audio_sources`. */
  mixcloud: z.string().nullish(),
  media: MediaSchema,
})
export type NtsEpisode = z.infer<typeof NtsEpisodeSchema>

function ntsPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    metadata: z.object({
      resultset: z.object({ count: z.number().int().nonnegative() }),
    }),
    results: z.array(item).nullish(),
  })
}

export const NtsShowPageSchema = ntsPageSchema(NtsShowSchema)
export const NtsEpisodePageSchema = ntsPageSchema(NtsEpisodeSchema)

async function ntsJson(
  request: StationRequest,
  path: string,
  params: Record<string, string> = {},
  options?: { notFoundOn404?: boolean },
): Promise<unknown> {
  const url = new URL(path, NTS_API)
  url.search = new URLSearchParams(params).toString()
  const response = await request(url, undefined, options)
  if (!response.ok)
    throw new Error(`NTS request failed (HTTP ${response.status})`)
  return response.json()
}

function pageOffset(page: string | null): number {
  if (page === null) return 0
  if (!/^\d{1,9}$/.test(page)) throw new Error('Invalid NTS page token.')
  return Number(page)
}

function pageParams(offset: number) {
  return { offset: String(offset), limit: String(NTS_PAGE_SIZE) }
}

/** The next offset while the listing continues past a non-empty page. */
function nextOffset(offset: number, listed: number, count: number) {
  const next = offset + NTS_PAGE_SIZE
  return listed > 0 && next < count ? next : null
}

/** An absolute http(s) URL without its query string or fragment, which carry tracking. */
function plainUrl(value: string | null | undefined): string | null {
  const url = httpUrl(value)
  if (!url) return null
  url.search = ''
  url.hash = ''
  return url.toString()
}

function httpUrl(value: string | null | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

function artworkUrl(media: NtsShow['media']): string | null {
  for (const value of [
    media?.picture_medium_large,
    media?.picture_large,
    media?.picture_medium,
  ]) {
    const url = httpUrl(value)
    if (url) return url.toString()
  }
  return null
}

function showUrl(handle: string) {
  return `${NTS_SITE}${encodeURIComponent(handle)}`
}

function showId(handle: string | null | undefined): string | null {
  if (!handle) return null
  const parsed = MixShowIdSchema.safeParse(`nts.${handle}`)
  return parsed.success ? parsed.data : null
}

/** The stored show, or null when it is unpublished or its alias is unusable. */
export function normalizeNtsShow(show: NtsShow): StationShow | null {
  if (show.status !== 'published') return null
  const handle = show.show_alias?.trim() ?? ''
  const id = showId(handle)
  if (!id) return null
  return {
    id,
    handle,
    title: show.name?.trim() || handle,
    description: show.description?.trim() || null,
    thumbnailUrl: artworkUrl(show.media),
    url: showUrl(handle),
    itemTotal: null,
  }
}

/** The episode name before " w/ ", which NTS uses as the show's name. */
function billedShow(name: string) {
  return name.split(GUEST_SEPARATOR)[0]?.trim() ?? ''
}

/** The guests NTS bills after the first " w/ " of an episode name. */
function billedGuests(name: string) {
  const match = GUEST_SEPARATOR.exec(name)
  return match
    ? splitBilledArtists(name.slice(match.index + match[0].length))
    : []
}

/**
 * The stored episode, or null when it is unpublished, not yet broadcast,
 * undated or its aliases are unusable. NTS states no duration.
 */
export function normalizeNtsEpisode(
  episode: NtsEpisode,
  now: Date,
): StationEpisode | null {
  if (episode.status !== 'published' || !episode.broadcast) return null
  const publishedAt = new Date(episode.broadcast)
  if (Number.isNaN(publishedAt.getTime()) || publishedAt > now) return null
  const handle = episode.show_alias?.trim() ?? ''
  const alias = episode.episode_alias?.trim() ?? ''
  if (!showId(handle) || !alias) return null
  const id = MixIdSchema.safeParse(`nts.${handle}.${alias}`)
  if (!id.success) return null
  const name = episode.name?.trim() || alias
  const audioUrl =
    (episode.audio_sources ?? [])
      .map((source) => plainUrl(source.url))
      .find((url) => url !== null) ??
    plainUrl(episode.mixcloud) ??
    null
  return {
    id: id.data,
    title: name,
    description: episode.description?.trim() ?? '',
    url: `${showUrl(handle)}/episodes/${encodeURIComponent(alias)}`,
    audioUrl,
    artworkUrl: artworkUrl(episode.media),
    publishedAt,
    durationSec: null,
    artists: billedGuests(name),
    tags: distinctNames((episode.genres ?? []).map((genre) => genre.value)),
  }
}

/** A feed entry with the show as far as the episode names it. */
function feedEntry(episode: NtsEpisode, now: Date): StationFeedEntry | null {
  const stored = normalizeNtsEpisode(episode, now)
  const handle = episode.show_alias?.trim() ?? ''
  const id = showId(handle)
  if (!stored || !id) return null
  return {
    show: {
      id,
      handle,
      title: billedShow(stored.title) || handle,
      description: null,
      thumbnailUrl: null,
      url: showUrl(handle),
      itemTotal: null,
    },
    showPartial: true,
    episode: stored,
  }
}

function present<T>(value: T | null): value is T {
  return value !== null
}

export function createNtsAdapter(
  now: () => Date = () => new Date(),
): MixStationAdapter {
  return {
    station: 'nts',
    catalogue: {
      async listShows(request, page) {
        const offset = pageOffset(page)
        const body = NtsShowPageSchema.parse(
          await ntsJson(request, 'shows', pageParams(offset)),
        )
        const results = body.results ?? []
        const count = body.metadata.resultset.count
        const next = nextOffset(offset, results.length, count)
        return {
          entries: results.map(normalizeNtsShow).filter(present),
          next: next === null ? null : String(next),
          total: count,
        }
      },
      async listShowEpisodes(request, show, page) {
        const offset = pageOffset(page)
        let body: z.infer<typeof NtsEpisodePageSchema>
        try {
          body = NtsEpisodePageSchema.parse(
            await ntsJson(
              request,
              `shows/${encodeURIComponent(show.handle)}/episodes`,
              pageParams(offset),
              { notFoundOn404: true },
            ),
          )
        } catch (error) {
          // A show NTS has removed lists nothing; its stored episodes are kept.
          if (!isProviderItemNotFoundError(error)) throw error
          return { entries: [], next: null, total: null }
        }
        const results = body.results ?? []
        const count = body.metadata.resultset.count
        const next = nextOffset(offset, results.length, count)
        const at = now()
        return {
          entries: results
            .map((episode) => normalizeNtsEpisode(episode, at))
            .filter(present),
          next: next === null ? null : String(next),
          total: count,
        }
      },
    },
    async listFeed(request, _mode, page, since) {
      const offset = pageOffset(page)
      const body = NtsEpisodePageSchema.parse(
        await ntsJson(
          request,
          'collections/recently-added',
          pageParams(offset),
        ),
      )
      const results = body.results ?? []
      const count = body.metadata.resultset.count
      const at = now()
      const entries = results
        .map((episode) => feedEntry(episode, at))
        .filter(present)
      const listed = { entries, total: count }
      if (results.length === 0)
        return { ...listed, next: null, truncated: false }
      if (since) {
        const before = since.getTime() - FEED_MARGIN_MS
        const dates = results
          .map((episode) => new Date(episode.broadcast ?? '').getTime())
          .filter((time) => !Number.isNaN(time))
        if (dates.length > 0 && dates.every((time) => time < before))
          return { ...listed, next: null, truncated: false }
      }
      const next = offset + NTS_PAGE_SIZE
      if (next >= count) return { ...listed, next: null, truncated: false }
      if (next > NTS_FEED_MAX_OFFSET)
        return { ...listed, next: null, truncated: true }
      return { ...listed, next: String(next), truncated: false }
    },
    async getShow(request, handle) {
      try {
        return normalizeNtsShow(
          NtsShowSchema.parse(
            await ntsJson(
              request,
              `shows/${encodeURIComponent(handle)}`,
              {},
              { notFoundOn404: true },
            ),
          ),
        )
      } catch (error) {
        if (!isProviderItemNotFoundError(error)) throw error
        return null
      }
    },
  }
}

export const ntsAdapter = createNtsAdapter()
