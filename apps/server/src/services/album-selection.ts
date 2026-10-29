import { z } from 'zod'
import {
  AlbumSelectionQuerySchema,
  QueueAlbumSelectionSchema,
} from '@repo/schemas/album-selection'
import { listAlbums } from './media'
import {
  annotateSelection,
  listSelectionProviders,
  queueMediaSelection,
  selectionBrowseOptions,
} from './media-selection'

export async function listAlbumSelection(
  query: z.infer<typeof AlbumSelectionQuerySchema>,
) {
  const providers = await listSelectionProviders(query, 'album')
  return annotateSelection(
    await listAlbums(query, selectionBrowseOptions(query)),
    query,
    providers,
  )
}

export async function queueAlbumSelection(
  input: z.infer<typeof QueueAlbumSelectionSchema>,
  userId: string | null,
) {
  return queueMediaSelection(input, 'album', userId)
}
