import { z } from 'zod'
import {
  ProviderItemNotFoundError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import {
  SpotifyAlbumSchema,
  SpotifyTracksPageSchema,
  UpcSchema,
  normalizeSpotifyAlbum,
  spotifyAlbumId,
  spotifyJson,
  spotifyToken,
  type SpotifyRequest,
} from '@/lib/spotify-api'

const nameKey = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
const artistKey = (names: string[]) =>
  JSON.stringify([...new Set(names.map(nameKey))].sort())

async function clientToken(
  secrets: Record<string, string>,
  request: SpotifyRequest,
) {
  const clientId = secrets['clientId']
  const clientSecret = secrets['clientSecret']
  if (!clientId || !clientSecret)
    throw new Error('Spotify client credentials are missing')
  return (
    await spotifyToken(
      request,
      new URLSearchParams({
        grant_type: 'client_credentials',
      }),
      { clientId, clientSecret },
    )
  ).access_token
}

export const spotifyPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'spotify',
    displayName: 'Spotify',
    description:
      'Album metadata and read-only saved album discovery; outbound links only',
    mediaTypes: ['album'],
    identifierTypes: ['album', 'spotify', 'upc'],
    supportsNameLookup: true,
    requireExplicitSelection: true,
    maxItemsPerJob: 1,
    rateLimit: { maxConcurrent: 1, minTimeMs: 1500 },
    secrets: [
      {
        key: 'clientId',
        label: 'Client ID',
        required: true,
        envVars: ['SPOTIFY_CLIENT_ID'],
      },
      {
        key: 'clientSecret',
        label: 'Client secret',
        required: true,
        envVars: ['SPOTIFY_CLIENT_SECRET'],
      },
      {
        key: 'redirectUri',
        label: 'OAuth redirect URI',
        required: false,
        helpText:
          'Exact HTTPS /api/v1/spotify/callback URI; HTTP only on 127.0.0.1 or [::1]. Required for saved albums.',
        envVars: ['SPOTIFY_CLIENT_REDIRECT_URI'],
      },
      {
        key: 'market',
        label: 'Market',
        required: false,
        helpText: 'Optional two-letter country code, for example AU.',
      },
    ],
  },
  async testConnection({ secrets, request }) {
    await clientToken(secrets, request)
  },
  async scrapeMediaItem(context) {
    if (context.mediaType !== 'album')
      throw new Error('Spotify supports albums only')
    const spotifyRef = context.existingReferences.find(
      (ref) =>
        ref.referenceType === 'spotify' ||
        (ref.referenceType === 'album' &&
          ref.metadata?.['sourceProvider'] === 'spotify'),
    )
    let id = spotifyRef ? spotifyAlbumId(spotifyRef.externalId) : null
    if (spotifyRef && !id) throw new Error('Invalid Spotify album identifier')
    const upc = (
      context.existingReferences.find(
        (ref) =>
          ref.referenceType === 'upc' &&
          ref.metadata?.['sourceProvider'] === 'spotify',
      ) ?? context.existingReferences.find((ref) => ref.referenceType === 'upc')
    )?.externalId
    if (upc) UpcSchema.parse(upc)
    const media = context.media
    if (!id && !upc && (!media?.title || !media.artists.length))
      throw new Error('Spotify requires an album ID, UPC, or title and artist')
    const market = context.secrets['market']
    if (market && !/^[A-Z]{2}$/.test(market))
      throw new Error(
        'Spotify market must be a two-letter uppercase country code',
      )
    const params: Record<string, string> = market ? { market } : {}
    const token = await clientToken(context.secrets, context.request)
    if (!id) {
      const quote = (value: string) => `"${value.replace(/["\\]/g, ' ')}"`
      const q = upc
        ? `upc:${upc}`
        : `album:${quote(media?.title ?? '')} artist:${quote(media?.artists[0] ?? '')}`
      const found = z
        .object({
          albums: z.object({
            items: z.array(SpotifyAlbumSchema),
            total: z.number().int().nonnegative(),
          }),
        })
        .parse(
          await spotifyJson(context.request, token, 'search', {
            ...params,
            q,
            type: 'album',
            limit: '10',
          }),
        ).albums
      if (found.total > found.items.length)
        throw new Error(
          'Spotify lookup is ambiguous; set an album ID explicitly',
        )
      const matches = upc
        ? found.items
        : found.items.filter(
            (item) =>
              nameKey(item.name) === nameKey(media?.title ?? '') &&
              artistKey(item.artists.map((artist) => artist.name)) ===
                artistKey(media?.artists ?? []),
          )
      if (!matches.length)
        throw new ProviderItemNotFoundError('No exact Spotify album match')
      if (matches.length !== 1)
        throw new Error(
          'Spotify lookup is ambiguous; set an album ID explicitly',
        )
      id = matches[0]?.id ?? null
    }
    if (!id) throw new ProviderItemNotFoundError('No exact Spotify album match')
    const data = SpotifyAlbumSchema.parse(
      await spotifyJson(context.request, token, `albums/${id}`, params),
    )
    if (
      data.id !== id ||
      (!spotifyRef &&
        upc &&
        data.external_ids?.upc?.padStart(14, '0') !== upc.padStart(14, '0'))
    )
      throw new Error(
        'Spotify album identity does not match the requested identifier',
      )
    if (
      !spotifyRef &&
      !upc &&
      (nameKey(data.name) !== nameKey(media?.title ?? '') ||
        artistKey(data.artists.map((artist) => artist.name)) !==
          artistKey(media?.artists ?? []))
    )
      throw new Error(
        'Spotify album identity changed after search; set its ID explicitly',
      )
    const initial = data.tracks
    if (
      !initial ||
      initial.offset !== 0 ||
      initial.total > 500 ||
      (data.total_tracks !== undefined && data.total_tracks !== initial.total)
    )
      throw new Error(
        'Spotify album tracks missing, inconsistent or exceed the 500-track safety limit',
      )
    const tracks = [...initial.items]
    let next = initial.next
    while (next !== null) {
      if (tracks.length >= initial.total || tracks.length >= 500)
        throw new Error('Invalid Spotify track pagination')
      const page = SpotifyTracksPageSchema.parse(
        await spotifyJson(context.request, token, `albums/${id}/tracks`, {
          ...params,
          limit: '50',
          offset: String(tracks.length),
        }),
      )
      if (
        page.offset !== tracks.length ||
        page.total !== initial.total ||
        !page.items.length ||
        tracks.length + page.items.length > initial.total
      )
        throw new Error(
          'Spotify album changed during pagination; retry explicitly',
        )
      tracks.push(...page.items)
      next = page.next
    }
    if (tracks.length !== initial.total)
      throw new Error('Incomplete Spotify track listing')
    if (
      new Set(
        tracks.map((track) => `${track.disc_number}:${track.track_number}`),
      ).size !== tracks.length
    )
      throw new Error('Duplicate Spotify track positions')
    const result = normalizeSpotifyAlbum({
      ...data,
      tracks: { ...initial, items: tracks, next: null },
    })
    if (!data.external_ids?.upc && upc) {
      result.normalized.references.push({
        referenceType: 'upc',
        externalId: upc,
        isPrimary: false,
      })
    }
    return result
  },
}
