import { z } from 'zod'
import { SpotifySavedAlbumsInputSchema } from '@repo/schemas/spotify'
import {
  SpotifySavedPageSchema,
  normalizeSpotifyAlbum,
  spotifyJson,
} from '@/lib/spotify-api'
import { type AlbumImportCandidate } from '@/lib/album-import-candidates'
import { ServerError } from '@/lib/error'
import { prepareAlbumCandidates } from './album-imports'
import { spotifyAccountToken, spotifyOperation } from './spotify-oauth'

const activePreviews = new Set<string>()
const maximumLibrarySize = 10000

function discoveryError(message: string) {
  return new ServerError({ statusCode: 422, message })
}

export async function previewSpotifyAlbums(
  input: z.infer<typeof SpotifySavedAlbumsInputSchema>,
  userId: string,
) {
  const options = SpotifySavedAlbumsInputSchema.parse(input)
  if (activePreviews.has(userId))
    throw new ServerError({
      statusCode: 409,
      message: 'A Spotify preview is already running. Wait for it to finish.',
    })
  activePreviews.add(userId)
  try {
    const discovered = await spotifyOperation(async (request) => {
      const token = await spotifyAccountToken(userId, request)
      const savedAlbums: z.infer<typeof SpotifySavedPageSchema>['items'] = []
      const seen = new Set<string>()
      let offset = options.offset
      let total = 0
      let nextOffset: number | null = null
      while (options.scanAll || savedAlbums.length < options.limit) {
        const limit = options.scanAll
          ? Math.min(50, savedAlbums.length ? total - offset : 50)
          : Math.min(50, options.limit - savedAlbums.length)
        const page = SpotifySavedPageSchema.parse(
          await spotifyJson(request, token, 'me/albums', {
            limit: String(limit),
            offset: String(offset),
          }),
        )
        if (
          page.offset !== offset ||
          page.items.length > limit ||
          offset + page.items.length > page.total ||
          (page.next !== null && !page.items.length)
        )
          throw discoveryError('Invalid Spotify saved album pagination')
        if (savedAlbums.length && total !== page.total)
          throw discoveryError(
            'Spotify library changed during discovery; preview again',
          )
        total = page.total
        if (options.scanAll && total > maximumLibrarySize)
          throw discoveryError(
            'Saved library exceeds the 10,000-album scan safety limit. No preview was staged.',
          )
        for (const saved of page.items) {
          if (options.scanAll && seen.has(saved.album.id))
            throw discoveryError(
              'Spotify library order changed during discovery. No preview was staged; try again when playback and library changes have stopped.',
            )
          seen.add(saved.album.id)
          savedAlbums.push(saved)
        }
        offset += page.items.length
        nextOffset =
          page.next !== null && offset < total && offset <= 10000
            ? offset
            : null
        if (nextOffset === null) break
      }
      const complete = options.offset === 0 && savedAlbums.length === total
      if (options.scanAll && !complete)
        throw discoveryError(
          'Spotify returned an incomplete saved library. No newest-added preview was staged.',
        )
      // Spotify does not guarantee saved-date order. Sort before selecting
      // the newest N, and never claim a partial page contains the newest overall.
      const ordered = [...savedAlbums].sort(
        (a, b) =>
          Date.parse(b.added_at) - Date.parse(a.added_at) ||
          a.album.id.localeCompare(b.album.id),
      )
      const records: AlbumImportCandidate[] = ordered
        .slice(0, options.limit)
        .map((saved) => ({
          provider: 'spotify',
          source: 'Spotify saved albums',
          result: normalizeSpotifyAlbum(saved.album, saved.added_at),
        }))
      return {
        records,
        warnings: complete
          ? []
          : [
              'Only a portion of the saved library was read. These albums are sorted by saved date within this batch, not the newest additions across your library.',
            ],
        discovery: {
          offset: options.offset,
          requested: options.limit,
          received: records.length,
          total,
          nextOffset,
          scanned: savedAlbums.length,
          complete,
        },
      }
    })
    return prepareAlbumCandidates(
      {
        records: discovered.records,
        warnings: discovered.warnings,
        skipped: 0,
      },
      userId,
      {
        kind: 'spotify',
        source: 'Spotify saved albums',
        discovery: {
          ...discovered.discovery,
          order: 'dateAddedDesc',
        },
      },
    )
  } finally {
    activePreviews.delete(userId)
  }
}
