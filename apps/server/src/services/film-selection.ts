import { z } from 'zod'
import {
  FilmSelectionQuerySchema,
  QueueFilmSelectionSchema,
} from '@repo/schemas/film-selection'
import { listFilms } from './media'
import {
  annotateSelection,
  listSelectionProviders,
  queueMediaSelection,
  selectionBrowseOptions,
} from './media-selection'

export async function listFilmSelection(
  query: z.infer<typeof FilmSelectionQuerySchema>,
) {
  const providers = await listSelectionProviders(query, 'film')
  return annotateSelection(
    await listFilms(query, selectionBrowseOptions(query)),
    query,
    providers,
  )
}

export async function queueFilmSelection(
  input: z.infer<typeof QueueFilmSelectionSchema>,
  userId: string | null,
) {
  return queueMediaSelection(input, 'film', userId)
}
