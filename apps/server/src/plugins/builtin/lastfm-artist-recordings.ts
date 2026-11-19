import { z } from 'zod'
import { isProviderItemNotFoundError } from '@repo/media-plugin-sdk'
import { albumNameKey } from '@/lib/album-import-candidates'
import { trackVersionKey } from '@/lib/track-matching'
import { AlbumHttpUrlSchema, AlbumMbidSchema } from './album-provider-helpers'
import { requestLastFm } from './lastfm'

const topTrackLimit = 50
const minimumRecordings = 2
const ArtistCreditSchema = z.object({
  name: z.string().trim().min(1),
  mbid: z.string().nullish(),
  url: z.string().nullish(),
})

function exactNameKey(name: string) {
  return albumNameKey(name.normalize('NFKC'))
}

export function lastFmArtistUrl(value: string) {
  const parsed = AlbumHttpUrlSchema.safeParse(value)
  if (!parsed.success) return null
  const url = new URL(parsed.data)
  if (!['www.last.fm', 'last.fm'].includes(url.hostname) || url.port)
    return null
  const slug = /^\/music\/([^/]+)\/?$/.exec(url.pathname)?.[1]
  if (!slug || slug.startsWith('+')) return null
  try {
    const name = decodeURIComponent(slug.replaceAll('+', ' ')).trim()
    if (!name) return null
    return {
      name,
      url:
        'https://www.last.fm/music/' +
        encodeURIComponent(name).replaceAll('%20', '+'),
    }
  } catch {
    return null
  }
}

const TopTracksSchema = z.object({
  toptracks: z.object({
    '@attr': z.object({ artist: z.string().optional() }).optional(),
    track: z
      .array(
        z.object({
          name: z.string().trim().min(1),
          url: z.string().nullish(),
          artist: ArtistCreditSchema.nullish(),
        }),
      )
      .max(topTrackLimit),
  }),
})

type Candidate = { id: string; name: string; url?: string }
export type LastFmRecording = {
  title: string
  albumName: string | null
  trackMbid?: string | null
}

const TrackInfoSchema = z.object({
  track: z.object({
    name: z.string().trim().min(1),
    mbid: z.string().nullish(),
    url: z.string().nullish(),
    artist: ArtistCreditSchema,
    album: z.object({
      title: z.string().trim().min(1),
      artist: z.string().trim().min(1),
      url: z.string().nullish(),
    }),
  }),
})

function lastFmItemArtistUrl(
  value: string,
  title: string,
  kind: 'track' | 'album',
) {
  const parsed = AlbumHttpUrlSchema.safeParse(value)
  if (!parsed.success) return null
  const url = new URL(parsed.data)
  const pattern =
    kind === 'track'
      ? /^(\/music\/[^/]+)\/_\/([^/]+)\/?$/
      : /^(\/music\/[^/]+)\/([^/]+)\/?$/
  const [, artistPath, trackSlug] = pattern.exec(url.pathname) ?? []
  if (!artistPath || !trackSlug) return null
  try {
    const linkedTitle = decodeURIComponent(trackSlug.replaceAll('+', ' '))
    return exactNameKey(linkedTitle) === exactNameKey(title)
      ? lastFmArtistUrl(url.origin + artistPath)
      : null
  } catch {
    return null
  }
}

function singleRecordedRelease(recordings: readonly LastFmRecording[]) {
  const titles = new Map<string, string>()
  const albums = new Set<string>()
  const mbids = new Set<string>()
  for (const { title, albumName, trackMbid } of recordings) {
    const titleKey = exactNameKey(title)
    if (!titleKey) continue
    titles.set(titleKey, title)
    if (albumName?.trim()) albums.add(exactNameKey(albumName))
    if (!trackMbid) continue
    const mbid = AlbumMbidSchema.safeParse(trackMbid).data
    if (!mbid) return null
    mbids.add(mbid.toLowerCase())
  }
  const [title] = titles.values()
  const [albumKey] = albums
  const [trackMbid] = mbids
  return title &&
    albumKey &&
    titles.size === 1 &&
    albums.size === 1 &&
    mbids.size <= 1
    ? { title, albumKey, trackMbid }
    : null
}

async function requestRecordingEvidence(
  context: Parameters<typeof requestLastFm>[0],
  method: 'artist.getTopTracks' | 'track.getInfo',
  params: Record<string, string>,
) {
  try {
    return await requestLastFm(context, method, params)
  } catch (error) {
    if (!isProviderItemNotFoundError(error)) throw error
    return null
  }
}

async function corroborateRecordedRelease(
  candidate: Candidate,
  candidateMbid: string | undefined,
  candidateLink: ReturnType<typeof lastFmArtistUrl>,
  recordings: readonly LastFmRecording[],
  context: Parameters<typeof requestLastFm>[0],
) {
  const recorded = singleRecordedRelease(recordings)
  const nameKey = exactNameKey(candidate.name)
  if (!recorded || nameKey === 'various artists') return null

  const response = await requestRecordingEvidence(context, 'track.getInfo', {
    ...(recorded.trackMbid
      ? { mbid: recorded.trackMbid }
      : { track: recorded.title, artist: candidate.name }),
    autocorrect: '0',
  })
  if (response === null) return null
  const result = TrackInfoSchema.safeParse(response)
  if (!result.success) return null
  const { track } = result.data
  const { artist, album } = track
  if (
    exactNameKey(track.name) !== exactNameKey(recorded.title) ||
    exactNameKey(artist.name) !== nameKey ||
    exactNameKey(album.title) !== recorded.albumKey ||
    exactNameKey(album.artist) !== nameKey
  )
    return null

  const trackMbid = AlbumMbidSchema.safeParse(track.mbid).data?.toLowerCase()
  if (
    (track.mbid && !trackMbid) ||
    (recorded.trackMbid && recorded.trackMbid !== trackMbid)
  )
    return null
  const artistMbid = AlbumMbidSchema.safeParse(artist.mbid).data?.toLowerCase()
  if (
    (artist.mbid && !artistMbid) ||
    (candidateMbid && candidateMbid !== artistMbid)
  )
    return null

  const artistLink = artist.url ? lastFmArtistUrl(artist.url) : null
  const trackLink = track.url
    ? lastFmItemArtistUrl(track.url, track.name, 'track')
    : null
  const albumLink = album.url
    ? lastFmItemArtistUrl(album.url, album.title, 'album')
    : null
  if (
    (artist.url && !artistLink) ||
    (track.url && !trackLink) ||
    (album.url && !albumLink)
  )
    return null
  const links = [artistLink, trackLink, albumLink].filter(
    (link) => link !== null,
  )
  if (links.some((link) => exactNameKey(link.name) !== nameKey)) return null
  const [artistUrl] = links.map((link) => link.url)
  if (links.some((link) => link.url !== artistUrl)) return null
  if (
    candidateLink &&
    (artistUrl !== candidateLink.url || !(artistLink || trackLink))
  )
    return null

  return {
    candidate,
    response,
    matchedTitleCount: 1,
    matchedTitles: [track.name],
    artistMbid,
    artistUrl,
    releaseEvidence: {
      albumTitle: album.title,
      albumArtist: album.artist,
      trackMbid: trackMbid ?? null,
    },
  }
}

/** Check one exact-name candidate against distinct recordings credited in the library. */
export async function corroborateLastFmArtist(
  name: string,
  candidates: readonly Candidate[],
  loadRecordings: () => Promise<readonly LastFmRecording[]>,
  context: Parameters<typeof requestLastFm>[0],
) {
  const nameKey = exactNameKey(name)
  const matches = candidates.filter(
    (candidate) => exactNameKey(candidate.name) === nameKey,
  )
  const [candidate] = matches
  if (matches.length !== 1 || !candidate || !nameKey) return null

  const candidateMbid = AlbumMbidSchema.safeParse(
    candidate.id,
  ).data?.toLowerCase()
  const candidateIdLink = candidateMbid ? null : lastFmArtistUrl(candidate.id)
  const candidateLink = candidate.url
    ? lastFmArtistUrl(candidate.url)
    : candidateIdLink
  if (candidate.url && !candidateLink) return null
  if (candidateLink && exactNameKey(candidateLink.name) !== nameKey) return null
  if (
    !candidateMbid &&
    (!candidateIdLink || candidateLink?.url !== candidateIdLink.url)
  )
    return null

  const recordings = await loadRecordings()
  const recordingKeys = new Map(
    recordings.flatMap(({ title }) => {
      const exactTitle = exactNameKey(title)
      const recordingKey = trackVersionKey(title)
      return exactTitle && recordingKey ? [[exactTitle, recordingKey]] : []
    }),
  )
  const distinctRecordings = new Set(recordingKeys.values()).size
  if (distinctRecordings === 1)
    return corroborateRecordedRelease(
      candidate,
      candidateMbid,
      candidateLink,
      recordings,
      context,
    )
  if (distinctRecordings < minimumRecordings) return null

  const response = await requestRecordingEvidence(
    context,
    'artist.getTopTracks',
    {
      ...(candidateMbid ? { mbid: candidateMbid } : { artist: candidate.name }),
      autocorrect: '0',
      page: '1',
      limit: String(topTrackLimit),
    },
  )
  if (response === null) return null
  const parsed = TopTracksSchema.safeParse(response)
  if (!parsed.success) return null
  const { toptracks } = parsed.data
  const listedArtist = toptracks['@attr']?.artist
  if (listedArtist && exactNameKey(listedArtist) !== nameKey) return null

  const creditedMbids = new Set<string>()
  const creditedUrls = new Set<string>()
  const supportedRecordings = new Map<string, string>()
  for (const track of toptracks.track) {
    const recording = recordingKeys.get(exactNameKey(track.name))
    if (!recording) continue
    if (track.artist && exactNameKey(track.artist.name) !== nameKey) return null

    const mbid = AlbumMbidSchema.safeParse(
      track.artist?.mbid,
    ).data?.toLowerCase()
    const artistLink = track.artist?.url
      ? lastFmArtistUrl(track.artist.url)
      : null
    const trackLink = track.url
      ? lastFmItemArtistUrl(track.url, track.name, 'track')
      : null
    if (track.artist?.mbid && !mbid) return null
    if (track.artist?.url && !artistLink) return null
    if (track.url && !trackLink) return null
    if (mbid && candidateMbid && mbid !== candidateMbid) return null
    if (mbid) creditedMbids.add(mbid)
    for (const link of [artistLink, trackLink]) {
      if (!link) continue
      if (exactNameKey(link.name) !== nameKey) return null
      if (candidateLink && link.url !== candidateLink.url) return null
      creditedUrls.add(link.url)
    }
    if (creditedMbids.size > 1 || creditedUrls.size > 1) return null

    const supportsCandidate =
      (candidateMbid && mbid === candidateMbid) ||
      (candidateLink && (artistLink || trackLink))
    if (supportsCandidate && !supportedRecordings.has(recording))
      supportedRecordings.set(recording, track.name)
  }
  if (supportedRecordings.size < minimumRecordings) return null
  const [artistMbid] = creditedMbids
  const [artistUrl] = creditedUrls
  return {
    candidate,
    response,
    matchedTitleCount: supportedRecordings.size,
    matchedTitles: [...supportedRecordings.values()],
    artistMbid,
    artistUrl,
    releaseEvidence: undefined,
  }
}
