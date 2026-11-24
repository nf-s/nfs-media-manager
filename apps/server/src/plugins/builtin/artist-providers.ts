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
  type LastFmRecording,
} from './lastfm-artist-recordings'
import { musicBrainzRequest, musicBrainzText } from './musicbrainz'
import { spotifyClientToken, spotifyMarket } from './spotify'
import {
  selectSpotifyCatalogRecordings,
  verifySpotifyArtistCatalogRecordings,
  type SpotifyArtistCatalogRecording,
} from './spotify-artist-catalog'

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

class LastFmArtistIdentityMismatch extends Error {
  constructor() {
    super('Last.fm returned a different artist than requested.')
  }
}

async function fetchLastFmArtist(
  id: string,
  context: Parameters<typeof requestLastFm>[0],
) {
  const link = lastFmArtistUrl(id)
  const response = await requestLastFm(context, 'artist.getInfo', {
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
    .parse(response)
  if (id !== (link ? artist.url.url : artist.mbid))
    throw new LastFmArtistIdentityMismatch()
  return { artist, response }
}

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
  getSpotifyToken?: () => Promise<string>
  loadLastfmRecordings?: () => Promise<readonly LastFmRecording[]>
  inferredLastfmMbid?: boolean
  loadSpotifyCatalogRecordings?: () => Promise<
    readonly SpotifyArtistCatalogRecording[]
  >
}

export type SavedArtistRecordingContext = Omit<
  ArtistRequestContext,
  'recordDiagnostic' | 'searched'
> & { recordDiagnostic?: (diagnostic: unknown) => void }

export type SavedArtistRecordingVerification = {
  verdict: 'verified' | 'conflict' | 'insufficient'
  reason:
    | 'verified-recording-credit'
    | 'conflicting-recording-credit'
    | 'insufficient-recording-evidence'
    | 'saved-artist-id-invalid'
  evidenceCount: number
  evidence: JsonValue
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

async function readSpotifyArtistRecordings(
  context: MediaPluginTestContext,
  name: string,
  token: string,
  recordings: readonly SpotifyArtistRecording[],
) {
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
      return {
        verified,
        conflict: {
          spotifyTrackId,
          title,
          artistIds: artistIds.slice(0, searchLimit),
        },
      }
    }
    verified.push({ spotifyTrackId, title, artistId })
  }
  return { verified, conflict: null }
}

async function verifySpotifyArtistRecordings(
  context: ArtistRequestContext,
  name: string,
  token: string,
) {
  const recordings =
    context.spotifyRecordings?.slice(0, spotifyArtistRecordingLimit) ?? []
  const { verified, conflict } = await readSpotifyArtistRecordings(
    context,
    name,
    token,
    recordings,
  )
  if (conflict) {
    context.recordDiagnostic({
      stage: 'artist.recording-conflict',
      evidence: { verified, ...conflict },
    })
    throw new ArtistSearchAmbiguousError()
  }
  return verified.length === recordings.length ? verified : []
}

export async function verifySavedArtistRecordings(
  provider: 'spotify' | 'lastfm',
  name: string,
  profile: { externalId?: string | null; url?: string | null },
  context: SavedArtistRecordingContext,
): Promise<SavedArtistRecordingVerification> {
  const saved =
    profile.externalId ?? (provider === 'lastfm' ? profile.url : null)
  const expectedId = saved ? normalizeArtistProviderId(provider, saved) : null
  const secrets = jobLogSecrets(context.secrets)
  const insufficient: SavedArtistRecordingVerification = {
    verdict: 'insufficient',
    reason: 'insufficient-recording-evidence',
    evidenceCount: 0,
    evidence: null,
  }
  if (!expectedId) return { ...insufficient, reason: 'saved-artist-id-invalid' }
  if (!artistNameKey(name)) return insufficient

  function result(
    verdict: 'verified' | 'conflict',
    evidenceCount: number,
    method: string,
    proof: Record<string, JsonValue>,
  ): SavedArtistRecordingVerification {
    return {
      verdict,
      reason:
        verdict === 'verified'
          ? 'verified-recording-credit'
          : 'conflicting-recording-credit',
      evidenceCount,
      evidence: sanitizeProviderPayload(
        { method, expectedId, ...proof },
        secrets,
      ),
    }
  }

  if (provider === 'lastfm') {
    if (!context.loadLastfmRecordings) return insufficient
    let conflict: SavedArtistRecordingVerification | undefined
    const candidate = {
      id: expectedId,
      name,
      ...(profile.url ? { url: profile.url } : {}),
    }
    const verified = await corroborateLastFmArtist(
      name,
      [candidate],
      context.loadLastfmRecordings,
      context,
      (recordings) => {
        conflict = result(
          'conflict',
          new Set(recordings.map(({ title }) => title)).size,
          'lastfm-recordings',
          { recordings },
        )
      },
    )
    if (conflict) return conflict
    const expectedMbid = AlbumMbidSchema.safeParse(expectedId).data
    if (!verified || (expectedMbid && verified.artistMbid !== expectedMbid))
      return insufficient
    const recordings = verified.recordingCredits.slice(0, 2)
    return result(
      'verified',
      recordings.length,
      verified.releaseEvidence
        ? 'lastfm-recorded-release'
        : 'lastfm-top-tracks',
      {
        recordings,
        artistMbid: verified.artistMbid ?? null,
        artistUrl: verified.artistUrl ?? null,
        releaseEvidence: verified.releaseEvidence ?? null,
      },
    )
  }

  const native: SpotifyArtistRecording[] = []
  for (const recording of context.spotifyRecordings ?? []) {
    if (
      !SpotifyIdSchema.safeParse(recording.spotifyTrackId).success ||
      !recording.title.trim() ||
      native.some(
        ({ spotifyTrackId }) => spotifyTrackId === recording.spotifyTrackId,
      )
    )
      continue
    native.push(recording)
    if (native.length === spotifyArtistRecordingLimit) break
  }
  const loadCatalog = context.loadSpotifyCatalogRecordings
  const preloaded = native.length ? undefined : await loadCatalog?.()
  if (
    !native.length &&
    (!preloaded || selectSpotifyCatalogRecordings(preloaded).length < 2)
  )
    return insufficient
  const token = await spotifyClientToken(context.secrets, context.request)
  secrets.push(token)
  if (native.length) {
    const { verified, conflict } = await readSpotifyArtistRecordings(
      context,
      name,
      token,
      native,
    )
    if (conflict || verified.some(({ artistId }) => artistId !== expectedId))
      return result(
        'conflict',
        verified.length + Number(Boolean(conflict)),
        'spotify-native-tracks',
        { recordings: verified, conflict },
      )
    if (verified.length === native.length)
      return result('verified', verified.length, 'spotify-native-tracks', {
        recordings: verified,
      })
  }
  const catalog = preloaded ?? (await loadCatalog?.())
  if (!catalog) return insufficient
  let conflict: SavedArtistRecordingVerification | undefined
  const verified = await verifySpotifyArtistCatalogRecordings(
    context,
    name,
    token,
    catalog,
    (recordings) => {
      conflict = result(
        'conflict',
        new Set(recordings.map(({ title }) => title)).size,
        'spotify-catalog-recordings',
        { recordings },
      )
    },
  )
  if (conflict) return conflict
  if (!verified) return insufficient
  return result(
    verified.artistId === expectedId ? 'verified' : 'conflict',
    verified.recordings.length,
    'spotify-catalog-recordings',
    { recordings: verified.recordings },
  )
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
  async function find({ spotifyToken = '', requireRecordings = false } = {}) {
    const { response, total, candidates } = await searchArtistProvider(
      provider,
      artistNameQuery(provider, name),
      providerContext,
      async () => spotifyToken,
    )
    evidence.search = response
    await context.searched()
    try {
      const selected = selectArtist(
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
      if (!requireRecordings) {
        lookup.match = selected
        return selected.id
      }
    } catch (error) {
      if (!(error instanceof ArtistSearchAmbiguousError)) throw error
    }

    if (provider === 'spotify' && context.loadSpotifyCatalogRecordings) {
      const verified = await verifySpotifyArtistCatalogRecordings(
        context,
        name,
        spotifyToken,
        await context.loadSpotifyCatalogRecordings(),
      )
      if (verified) {
        lookup.match = { id: verified.artistId, name: verified.artistName }
        evidence.catalogRecordingVerification = verified.recordings
        return verified.artistId
      }
    }
    if (provider === 'lastfm' && context.loadLastfmRecordings) {
      const verified = await corroborateLastFmArtist(
        name,
        candidates,
        context.loadLastfmRecordings,
        providerContext,
      )
      if (verified) {
        lookup.match = verified.candidate
        lookup.recordingMbid = verified.artistMbid
        lookup.recordingUrl = verified.artistUrl
        if (verified.releaseEvidence) evidence.trackInfo = verified.response
        else evidence.topTracks = verified.response
        evidence.recordingVerification = {
          matchedTitles: verified.matchedTitles,
          artistMbid: verified.artistMbid ?? null,
          artistUrl: verified.artistUrl ?? null,
          ...(verified.releaseEvidence
            ? { releaseEvidence: verified.releaseEvidence }
            : {}),
        }
        return verified.candidate.id
      }
    }
    throw new ArtistSearchAmbiguousError()
  }
  let id = providerArtistId
    ? normalizeArtistProviderId(provider, providerArtistId)
    : null
  if (providerArtistId && !id)
    throw new Error('Invalid provider artist identifier.')
  let profile: z.input<typeof ArtistProfileSchema>

  switch (provider) {
    case 'spotify': {
      const token = await (context.getSpotifyToken?.() ??
        spotifyClientToken(context.secrets, context.request))
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
      if (!id) id = await find({ spotifyToken: token })
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
      let details: Awaited<ReturnType<typeof fetchLastFmArtist>>
      try {
        details = await fetchLastFmArtist(id, providerContext)
        if (
          context.inferredLastfmMbid &&
          artistNameKey(details.artist.name) !== artistNameKey(name)
        )
          throw new LastFmArtistIdentityMismatch()
      } catch (error) {
        if (
          !context.inferredLastfmMbid ||
          !context.loadLastfmRecordings ||
          !(
            error instanceof LastFmArtistIdentityMismatch ||
            isProviderItemNotFoundError(error)
          )
        )
          throw error
        evidence.rejectedInferredId = id
        const verifiedId = await find({ requireRecordings: true })
        if (verifiedId === id) {
          if (!lookup.recordingUrl) throw error
          id = lookup.recordingUrl
        } else id = verifiedId
        details = await fetchLastFmArtist(id, providerContext)
      }
      const { artist } = details
      evidence.artist = details.response
      if (
        (lookup.recordingMbid && lookup.recordingMbid !== artist.mbid) ||
        (lookup.recordingUrl && lookup.recordingUrl !== artist.url.url)
      )
        throw new LastFmArtistIdentityMismatch()
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
