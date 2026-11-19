import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import type { MixStation } from '@repo/schemas/subscriptions'

/** A request through the station's provider gate: its spacing, cooldowns and cancellation. */
export type StationRequest = MediaPluginTestContext['request']

/** A show as a station lists it, already in the stored shape. */
export type StationShow = {
  /** `<station>.<the station's own identifier>`; see `MixShowIdSchema`. */
  id: string
  title: string
  /** The show's slug or alias on the station's site. */
  handle: string
  description: string | null
  thumbnailUrl: string | null
  /** The show's page on the station's site. */
  url: string
  /** The station's episode count, when the listing states one. */
  itemTotal: number | null
}

/** One archived mix or show episode. */
export type StationEpisode = {
  /** `<station>.<the station's own identifier>`; see `MixIdSchema`. */
  id: string
  title: string
  description: string
  /** The episode's page on the station's site. */
  url: string
  /** The recording: a file, a stream, or its SoundCloud or Mixcloud page. */
  audioUrl: string | null
  artworkUrl: string | null
  /** UTC. */
  publishedAt: Date
  durationSec: number | null
  /** Billed performers as the station names them, in billing order, without duplicates. */
  artists: string[]
  /** The station's genre names, without duplicates. */
  tags: string[]
}

export type StationPage<T> = {
  entries: T[]
  /** The token of the next page; null after the last. */
  next: string | null
  /** The size of the whole listing, when the station states it. */
  total: number | null
}

/** An episode of the station-wide feed with the show it belongs to. */
export type StationFeedEntry = {
  show: StationShow
  /**
   * The feed names the show without its details. The sync stores the show from
   * `getShow` when it is new, and leaves a stored show as it is.
   */
  showPartial: boolean
  episode: StationEpisode
}

export type StationFeedPage = StationPage<StationFeedEntry> & {
  /**
   * The feed ended before reaching the requested start, so additions older than
   * its last entry may be missing. The next run reads the catalogue again.
   */
  truncated: boolean
}

/**
 * How one station's archive is read. Every method makes its requests through
 * `request`, validates the response and returns stored shapes; none touches
 * the database. A page token is opaque to the caller and survives a restart.
 *
 * A station with a catalogue is read in full once, show by show, and from its
 * feed afterwards. A station without one is read from its feed both times.
 */
export interface MixStationAdapter {
  station: MixStation
  /** The show catalogue and each show's episodes; null for a feed-only station. */
  catalogue: {
    listShows: (
      request: StationRequest,
      page: string | null,
    ) => Promise<StationPage<StationShow>>
    /** Newest first, so a later run can stop at the first stored episode. */
    listShowEpisodes: (
      request: StationRequest,
      show: Pick<StationShow, 'id' | 'handle'>,
      page: string | null,
    ) => Promise<StationPage<StationEpisode>>
  } | null
  /**
   * One page of the station-wide feed. `archive` reads everything the feed
   * holds; `recent` reads newest first back to `since`, the start of the last
   * completed run, re-reading a margin before it for late changes.
   */
  listFeed: (
    request: StationRequest,
    mode: 'archive' | 'recent',
    page: string | null,
    since: Date | null,
  ) => Promise<StationFeedPage>
  /** The full details of a show the feed named only partially. */
  getShow:
    | ((request: StationRequest, handle: string) => Promise<StationShow | null>)
    | null
}

const BILLING_SEPARATOR =
  /\s+(?:b2b|b3b|w\/|with|and|&|x|vs\.?)\s+|\s*,\s+|\s+\/\s+/i

/**
 * Splits a billing line such as "Lamsi B2B Yung Singh" into its names. Only
 * the separators stations use between performers split; a title after
 * "presents" or "invites" is not a performer, so the line ends there.
 */
export function splitBilledArtists(billing: string): string[] {
  const performers =
    billing.split(/\s+(?:presents|invites|pres\.)\s+/i)[0] ?? ''
  const seen = new Set<string>()
  const names: string[] = []
  for (const part of performers.split(BILLING_SEPARATOR)) {
    const name = part.replace(/\s+/g, ' ').trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

/** The values in their first-seen order, trimmed, without blanks or case-insensitive repeats. */
export function distinctNames(values: readonly (string | null | undefined)[]) {
  const seen = new Set<string>()
  const names: string[] = []
  for (const value of values) {
    const name = (value ?? '').replace(/\s+/g, ' ').trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

/** The text of a short HTML fragment: tags dropped, common entities decoded, whitespace collapsed. */
export function htmlText(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<\s*br\s*\/?>|<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}
