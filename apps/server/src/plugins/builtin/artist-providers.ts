import {
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
import { musicBrainzRequest } from './musicbrainz'
import { spotifyClientToken } from './spotify'

const searchLimit = 5
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

function lastFmArtistUrl(value: string) {
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
}

/** Each lookup reads at most one search page and one artist record. */
export async function lookupArtistProvider(
  provider: ArtistProfileProvider,
  name: string,
  providerArtistId: string | null,
  context: ArtistRequestContext,
) {
  const evidence: Record<string, JsonValue> = {}
  const providerContext = { request: context.request, secrets: context.secrets }
  const secrets = jobLogSecrets(context.secrets)
  const lookup: { match?: ArtistCandidate } = {}
  async function find(
    response: JsonValue,
    total: number,
    candidates: ArtistCandidate[],
  ) {
    evidence.search = response
    await context.searched()
    const match = selectArtist(
      provider,
      name,
      total,
      candidates,
      context.recordDiagnostic,
    )
    lookup.match = match
    return match.id
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
      if (!id) {
        const response = JsonValueSchema.parse(
          await spotifyJson(context.request, token, 'search', {
            q: 'artist:"' + name.replace(/["\\]/g, ' ') + '"',
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
        id = await find(
          response,
          artists.total,
          artists.items.map(({ id, name }) => ({ id, name })),
        )
      }
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
      if (!id) {
        const response = await requestLastFm(providerContext, 'artist.search', {
          artist: name,
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
        id = await find(
          response,
          results['opensearch:totalResults'],
          results.artistmatches.artist.map((artist) => ({
            id: artist.mbid || artist.url.url,
            name: artist.name,
          })),
        )
      }
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
      if (id !== (link ? artist.url.url : artist.mbid))
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
      if (!id) {
        const response = await discogsRequest(
          providerContext,
          'database/search',
          {
            q: name,
            type: 'artist',
            per_page: String(searchLimit),
            page: '1',
          },
        )
        const results = z
          .object({
            pagination: z.object({ items: AlbumCountSchema }),
            results: z.array(DiscogsArtistSearchItemSchema).max(searchLimit),
          })
          .parse(response)
        id = await find(
          response,
          results.pagination.items,
          results.results.map(({ id, title }) => ({ id, name: title })),
        )
      }
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
      if (!id) {
        const response = await musicBrainzRequest(providerContext, 'artist/', {
          query: 'artist:"' + name.replace(/["\\]/g, '\\$&') + '"',
          limit: String(searchLimit),
        })
        const results = z
          .object({
            count: AlbumCountSchema,
            artists: z.array(MusicBrainzArtistSchema).max(searchLimit),
          })
          .parse(response)
        id = await find(
          response,
          results.count,
          results.artists.map(({ id, name, disambiguation }) => ({
            id,
            name,
            ...(disambiguation ? { details: disambiguation } : {}),
          })),
        )
      }
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
