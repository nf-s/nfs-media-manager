import { z } from 'zod'
import { albumNameKey } from '@/lib/album-import-candidates'
import { trackVersionKey } from '@/lib/track-matching'
import { AlbumHttpUrlSchema, AlbumMbidSchema } from './album-provider-helpers'
import { requestLastFm } from './lastfm'

const topTrackLimit = 50
const minimumRecordings = 2

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
          artist: z
            .object({
              name: z.string().trim().min(1),
              mbid: z.string().nullish(),
              url: z.string().nullish(),
            })
            .nullish(),
        }),
      )
      .max(topTrackLimit),
  }),
})

type Candidate = { id: string; name: string; url?: string }

function lastFmTrackArtistUrl(value: string, title: string) {
  const parsed = AlbumHttpUrlSchema.safeParse(value)
  if (!parsed.success) return null
  const url = new URL(parsed.data)
  const [, artistPath, trackSlug] =
    /^(\/music\/[^/]+)\/_\/([^/]+)\/?$/.exec(url.pathname) ?? []
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

/** Check one exact-name candidate against distinct recordings credited in the library. */
export async function corroborateLastFmArtist(
  name: string,
  candidates: readonly Candidate[],
  loadRecordingTitles: () => Promise<readonly string[]>,
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

  const recordingKeys = new Map(
    (await loadRecordingTitles()).flatMap((title) => {
      const exactTitle = exactNameKey(title)
      const recordingKey = trackVersionKey(title)
      return exactTitle && recordingKey ? [[exactTitle, recordingKey]] : []
    }),
  )
  if (new Set(recordingKeys.values()).size < minimumRecordings) return null

  const response = await requestLastFm(context, 'artist.getTopTracks', {
    ...(candidateMbid ? { mbid: candidateMbid } : { artist: candidate.name }),
    autocorrect: '0',
    page: '1',
    limit: String(topTrackLimit),
  })
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
      ? lastFmTrackArtistUrl(track.url, track.name)
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
  }
}
