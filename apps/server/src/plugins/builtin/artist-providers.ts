import {
  isProviderItemNotFoundError,
  JsonValueSchema,
  ProviderItemNotFoundError,
  type JsonValue,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import {
  ArtistProfileSchema,
  type ArtistProfileProvider,
} from '@repo/schemas/artist-profiles'
import { z } from 'zod'
import { albumNameKey } from '@/lib/album-import-candidates'
import { sanitizeProviderPayload } from '@/lib/job-diagnostics'
import { jobLogSecrets } from '@/lib/job-errors'
import { SpotifyIdSchema, spotifyJson } from '@/lib/spotify-api'
import {
  AlbumCountSchema,
  AlbumHttpUrlSchema,
  AlbumMbidSchema,
} from './album-provider-helpers'
import { discogsRequest } from './discogs'
import { requestLastFm } from './lastfm'
import {
  corroborateLastFmArtist,
  lastFmArtistUrl,
} from './lastfm-artist-recordings'
import { musicBrainzRequest, musicBrainzText } from './musicbrainz'
import { spotifyClientToken, spotifyMarket } from './spotify'

const searchLimit = 5
export const spotifyArtistRecordingLimit = 2
const ArtistNameSchema = z.string().trim().min(1)
const ArtistMbidSchema = AlbumMbidSchema.transform((value) =>
  value.toLowerCase(),
)
const DiscogsArtistIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value)))
const TagsSchema = z.array(z.object({ name: ArtistNameSchema })).default([])
const MusicBrainzArtistSchema = z.object({
  id: ArtistMbidSchema,
  name: ArtistNameSchema,
  country: z.string().nullish(),
  type: z.string().nullish(),
  disambiguation: z.string().optional(),
})
const DiscogsArtistSearchItemSchema = z.object({
  id: z.number().int().positive().safe().transform(String),
  title: ArtistNameSchema,
  type: z.literal('artist'),
})
const SpotifyArtistSchema = z.object({
  id: SpotifyIdSchema,
  name: ArtistNameSchema,
  type: z.literal('artist'),
  images: z.array(z.object({ url: z.string() })).optional(),
  genres: z.array(ArtistNameSchema).optional(),
})
const SpotifyArtistRecordingSchema = z.object({
  id: SpotifyIdSchema,
  name: ArtistNameSchema,
  artists: z.array(SpotifyArtistSchema.pick({ id: true, name: true })),
})

export type SpotifyArtistRecording = { spotifyTrackId: string; title: string }

const LastFmArtistUrlSchema = z.string().transform((value, context) => {
  const link = lastFmArtistUrl(value)
  if (link) return link
  context.addIssue({ code: 'custom', message: 'Expected a Last.fm artist URL' })
  return z.NEVER
})
const LastFmArtistSchema = z.object({
  name: ArtistNameSchema,
  mbid: z.union([ArtistMbidSchema, z.literal('')]).nullish(),
  url: LastFmArtistUrlSchema,
})

export function normalizeArtistProviderId(
  provider: ArtistProfileProvider,
  id: string,
): string | null {
  switch (provider) {
    case 'spotify': {
      const parsed = SpotifyIdSchema.safeParse(id)
      return parsed.success ? parsed.data : null
    }
    case 'discogs': {
      const parsed = DiscogsArtistIdSchema.safeParse(id)
      return parsed.success ? parsed.data : null
    }
    case 'musicbrainz': {
      const parsed = ArtistMbidSchema.safeParse(id)
      return parsed.success ? parsed.data : null
    }
    case 'lastfm': {
      const parsed = ArtistMbidSchema.safeParse(id)
      if (parsed.success) return parsed.data
      const link = lastFmArtistUrl(id)
      return link?.url ?? null
    }
  }
}

export class ArtistSearchAmbiguousError extends Error {
  constructor() {
    super('Artist search is ambiguous. Specify a provider artist ID.')
    this.name = 'ArtistSearchAmbiguousError'
  }
}

export type ArtistCandidate = {
  id: string
  name: string
  details?: string
}

export function artistNameKey(name: string) {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function artistSearchNameMatches(
  provider: ArtistProfileProvider,
  candidate: string,
  name: string,
) {
  const key = artistNameKey(candidate)
  const expected = artistNameKey(name)
  return (
    key === expected ||
    (provider === 'discogs' && key.replace(/ \(\d+\)$/, '') === expected)
  )
}

function selectArtist(
  provider: ArtistProfileProvider,
  name: string,
  total: number,
  candidates: ArtistCandidate[],
  recordDiagnostic: (diagnostic: unknown) => void,
) {
  if (total < candidates.length)
    throw new Error('Artist search returned an invalid result count.')
  const matches = candidates.filter((candidate) =>
    artistSearchNameMatches(provider, candidate.name, name),
  )
  recordDiagnostic({
    stage: 'artist.candidates',
    evidence: { total, candidates },
  })
  if (total > candidates.length || matches.length > 1)
    throw new ArtistSearchAmbiguousError()
  const [match] = matches
  if (!match || artistNameKey(match.name) !== artistNameKey(name))
    throw new ProviderItemNotFoundError('No exact artist match.')
  return match
}

function artworkUrl(value: string | undefined) {
  const parsed = AlbumHttpUrlSchema.safeParse(value)
  if (!parsed.success) return undefined
  const url = new URL(parsed.data)
  url.search = ''
  url.hash = ''
  return url.href
}

type ArtistRequestContext = MediaPluginTestContext & {
  recordDiagnostic(diagnostic: unknown): void
  searched(): Promise<void>
  spotifyRecordings?: readonly SpotifyArtistRecording[]
  loadLastfmRecordings?: () => Promise<readonly string[]>
}

type ArtistSearchContext = MediaPluginTestContext & {
  recordDiagnostic?: (diagnostic: unknown) => void
}

/** A search result with what Find match shows beside its name. */
export type ArtistSearchCandidate = ArtistCandidate & {
  artworkUrl?: string
  url?: string
}

/** One page of the provider's artist search: the request a lookup makes by name. */
async function searchArtistProvider(
  provider: ArtistProfileProvider,
  query: string,
  context: ArtistSearchContext,
  spotifyToken: () => Promise<string>,
): Promise<{
  response: JsonValue
  total: number
  candidates: ArtistSearchCandidate[]
}> {
  switch (provider) {
    case 'spotify': {
      const response = JsonValueSchema.parse(
        await spotifyJson(context.request, await spotifyToken(), 'search', {
          q: query,
          type: 'artist',
          limit: String(searchLimit),
        }),
      )
      const { artists } = z
        .object({
          artists: z.object({
            total: AlbumCountSchema,
            items: z.array(SpotifyArtistSchema).max(searchLimit),
          }),
        })
        .parse(response)
      return {
        response,
        total: artists.total,
        candidates: artists.items.map(({ id, name, images }) => ({
          id,
          name,
          artworkUrl: images
            ?.map((image) => artworkUrl(image.url))
            .find(Boolean),
        })),
      }
    }
    case 'lastfm': {
      const response = await requestLastFm(context, 'artist.search', {
        artist: query,
        limit: String(searchLimit),
      })
      const { results } = z
        .object({
          results: z.object({
            'opensearch:totalResults': AlbumCountSchema,
            artistmatches: z.object({
              artist: z.array(LastFmArtistSchema).max(searchLimit),
            }),
          }),
        })
        .parse(response)
      return {
        response,
        total: results['opensearch:totalResults'],
        candidates: results.artistmatches.artist.map((artist) => ({
          id: artist.mbid || artist.url.url,
          name: artist.name,
          url: artist.url.url,
        })),
      }
    }
    case 'discogs': {
      const response = await discogsRequest(context, 'database/search', {
        q: query,
        type: 'artist',
        per_page: String(searchLimit),
        page: '1',
      })
      const results = z
        .object({
          pagination: z.object({ items: AlbumCountSchema }),
          results: z.array(DiscogsArtistSearchItemSchema).max(searchLimit),
        })
        .parse(response)
      return {
        response,
        total: results.pagination.items,
        candidates: results.results.map(({ id, title }) => ({
          id,
          name: title,
        })),
      }
    }
    case 'musicbrainz': {
      const response = await musicBrainzRequest(context, 'artist/', {
        query,
        limit: String(searchLimit),
      })
      const results = z
        .object({
          count: AlbumCountSchema,
          artists: z.array(MusicBrainzArtistSchema).max(searchLimit),
        })
        .parse(response)
      return {
        response,
        total: results.count,
        candidates: results.artists.map(({ id, name, disambiguation }) => ({
          id,
          name,
          ...(disambiguation ? { details: disambiguation } : {}),
        })),
      }
    }
  }
}

/** The search text a lookup by name sends to each provider. */
function artistNameQuery(provider: ArtistProfileProvider, name: string) {
  switch (provider) {
    case 'spotify':
      return 'artist:"' + name.replace(/["\\]/g, ' ') + '"'
    case 'musicbrainz':
      return 'artist:"' + name.replace(/["\\]/g, '\\$&') + '"'
    case 'lastfm':
    case 'discogs':
      return name
  }
}

/**
 * The artists a provider's search lists for Find match: the lookup's own
 * search by name, or the text the owner typed.
 */
export async function searchArtistCandidates(
  provider: ArtistProfileProvider,
  name: string,
  query: string | undefined,
  context: MediaPluginTestContext,
): Promise<ArtistSearchCandidate[]> {
  const typed =
    query && provider === 'musicbrainz' ? musicBrainzText(query) : query
  const result = await searchArtistProvider(
    provider,
    typed ?? artistNameQuery(provider, name),
    context,
    () => spotifyClientToken(context.secrets, context.request),
  )
  return result.candidates
}

async function verifySpotifyArtistRecordings(
  context: ArtistRequestContext,
  name: string,
  token: string,
) {
  const recordings =
    context.spotifyRecordings?.slice(0, spotifyArtistRecordingLimit) ?? []
  const params = spotifyMarket(context.secrets)
  const verified: (SpotifyArtistRecording & { artistId: string })[] = []
  for (const recording of recordings) {
    const { spotifyTrackId, title } = recording
    const response = await spotifyJson(
      context.request,
      token,
      'tracks/' + spotifyTrackId,
      params,
      { notFoundOn404: true },
    ).catch((error: unknown) => {
      if (!isProviderItemNotFoundError(error)) throw error
      return null
    })
    const track = SpotifyArtistRecordingSchema.safeParse(response)
    if (
      !track.success ||
      track.data.id !== spotifyTrackId ||
      albumNameKey(track.data.name) !== albumNameKey(title)
    )
      continue
    const artistIds = [
      ...new Set(
        track.data.artists
          .filter(
            (artist) => artistNameKey(artist.name) === artistNameKey(name),
          )
          .map(({ id }) => id),
      ),
    ]
    const [artistId] = artistIds
    if (!artistId) continue
    const previous = verified[0]
    if (artistIds.length > 1 || (previous && previous.artistId !== artistId)) {
      context.recordDiagnostic({
        stage: 'artist.recording-conflict',
        evidence: {
          verified,
          spotifyTrackId,
          artistIds: artistIds.slice(0, searchLimit),
        },
      })
      throw new ArtistSearchAmbiguousError()
    }
    verified.push({ spotifyTrackId, title, artistId })
  }
  return verified.length === recordings.length ? verified : []
}

/** A name search may also check bounded recording evidence before fetching the artist profile. */
export async function lookupArtistProvider(
  provider: ArtistProfileProvider,
  name: string,
  providerArtistId: string | null,
  context: ArtistRequestContext,
) {
  const evidence: Record<string, JsonValue> = {}
  const providerContext = {
    request: context.request,
    secrets: context.secrets,
    recordDiagnostic: context.recordDiagnostic,
  }
  const secrets = jobLogSecrets(context.secrets)
  const lookup: {
    match?: ArtistCandidate
    recordingMbid?: string
    recordingUrl?: string
  } = {}
  async function find(spotifyToken = '') {
    const { response, total, candidates } = await searchArtistProvider(
      provider,
      artistNameQuery(provider, name),
      providerContext,
      async () => spotifyToken,
    )
    evidence.search = response
    await context.searched()
    try {
      lookup.match = selectArtist(
        provider,
        name,
        total,
        candidates.map(({ id, name, details }) => ({
          id,
          name,
          ...(details ? { details } : {}),
        })),
        context.recordDiagnostic,
      )
    } catch (error) {
      if (
        !(error instanceof ArtistSearchAmbiguousError) ||
        provider !== 'lastfm' ||
        total <= candidates.length ||
        !context.loadLastfmRecordings
      )
        throw error
      const verified = await corroborateLastFmArtist(
        name,
        candidates,
        context.loadLastfmRecordings,
        providerContext,
      )
      if (!verified) throw error
      lookup.match = verified.candidate
      lookup.recordingMbid = verified.artistMbid
      lookup.recordingUrl = verified.artistUrl
      evidence.topTracks = verified.response
      evidence.recordingVerification = {
        matchedTitles: verified.matchedTitles,
        artistMbid: verified.artistMbid ?? null,
        artistUrl: verified.artistUrl ?? null,
      }
    }
    return lookup.match.id
  }
  let id = providerArtistId
    ? normalizeArtistProviderId(provider, providerArtistId)
    : null
  if (providerArtistId && !id)
    throw new Error('Invalid provider artist identifier.')
  let profile: z.input<typeof ArtistProfileSchema>

  switch (provider) {
    case 'spotify': {
      const token = await spotifyClientToken(context.secrets, context.request)
      secrets.push(token)
      if (!id && context.spotifyRecordings?.length) {
        const verified = await verifySpotifyArtistRecordings(
          context,
          name,
          token,
        )
        const [first] = verified
        if (first) {
          id = first.artistId
          lookup.match = { id, name }
          evidence.recordingVerification = verified
          await context.searched()
        }
      }
      if (!id) id = await find(token)
      evidence.artist = JsonValueSchema.parse(
        await spotifyJson(
          context.request,
          token,
          'artists/' + id,
          {},
          { notFoundOn404: true },
        ),
      )
      const artist = SpotifyArtistSchema.parse(evidence.artist)
      profile = {
        name: artist.name,
        externalId: artist.id,
        url: 'https://open.spotify.com/artist/' + artist.id,
        artworkUrl: artist.images
          ?.map((image) => artworkUrl(image.url))
          .find(Boolean),
        tags: artist.genres,
      }
      break
    }
    case 'lastfm': {
      if (!id) id = await find()
      const link = lastFmArtistUrl(id)
      evidence.artist = await requestLastFm(providerContext, 'artist.getInfo', {
        ...(link ? { artist: link.name } : { mbid: id }),
        autocorrect: '0',
      })
      const { artist } = z
        .object({
          artist: LastFmArtistSchema.extend({
            tags: z.object({ tag: TagsSchema }).optional(),
            bio: z.object({ summary: z.string().optional() }).optional(),
            image: z.array(z.object({ '#text': z.string() })).optional(),
          }),
        })
        .parse(evidence.artist)
      if (
        id !== (link ? artist.url.url : artist.mbid) ||
        (lookup.recordingMbid && lookup.recordingMbid !== artist.mbid) ||
        (lookup.recordingUrl && lookup.recordingUrl !== artist.url.url)
      )
        throw new Error('Last.fm returned a different artist than requested.')
      profile = {
        name: artist.name,
        externalId: artist.mbid || artist.url.url,
        url: artist.url.url,
        summary:
          artist.bio?.summary
            ?.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '')
            .replace(/<[^>]+>/g, '')
            .trim() || undefined,
        artworkUrl: artist.image
          ?.map((image) => artworkUrl(image['#text']))
          .reverse()
          .find(Boolean),
        tags: artist.tags?.tag.map((tag) => tag.name),
      }
      // A lookup by the service's canonical URL can discover an MBID.
      id = profile.externalId ?? id
      break
    }
    case 'discogs': {
      if (!id) id = await find()
      evidence.artist = await discogsRequest(providerContext, 'artists/' + id)
      const artist = z
        .object({
          id: z.number().int().positive().safe().transform(String),
          name: ArtistNameSchema,
          profile: z.string().optional(),
          images: z.array(z.object({ uri: z.string().optional() })).optional(),
        })
        .parse(evidence.artist)
      profile = {
        name: artist.name,
        externalId: artist.id,
        summary: artist.profile?.trim() || undefined,
        url: 'https://www.discogs.com/artist/' + artist.id,
        artworkUrl: artist.images
          ?.map((image) => artworkUrl(image.uri))
          .find(Boolean),
      }
      break
    }
    case 'musicbrainz': {
      if (!id) id = await find()
      evidence.artist = await musicBrainzRequest(
        providerContext,
        'artist/' + id,
        {
          inc: 'tags+genres',
        },
      )
      const artist = MusicBrainzArtistSchema.extend({
        tags: TagsSchema,
        genres: TagsSchema,
      }).parse(evidence.artist)
      profile = {
        name: artist.name,
        externalId: artist.id,
        country: artist.country?.trim() || undefined,
        type: artist.type?.trim() || undefined,
        summary: artist.disambiguation?.trim() || undefined,
        url: 'https://musicbrainz.org/artist/' + artist.id,
        tags: [...artist.genres, ...artist.tags].map((tag) => tag.name),
      }
      break
    }
  }
  if (
    profile.externalId !== id ||
    (lookup.match &&
      artistNameKey(profile.name ?? '') !== artistNameKey(lookup.match.name))
  )
    throw new Error('Provider returned a different artist than requested.')
  const normalized = ArtistProfileSchema.parse(profile)
  const savedProfile = ArtistProfileSchema.parse(
    sanitizeProviderPayload(normalized, secrets),
  )
  if (savedProfile.externalId !== normalized.externalId)
    throw new Error('Provider returned an invalid artist identifier.')
  return {
    profile: { ...savedProfile, tags: [...new Set(savedProfile.tags)] },
    payload: sanitizeProviderPayload(evidence, secrets),
  }
}
