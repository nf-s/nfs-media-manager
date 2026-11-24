import { z } from 'zod'
import {
  TidalCountryCodeSchema,
  type TidalTrackCandidate,
} from '@repo/schemas/tidal'
import { validIsrc } from '@/lib/isrc'
import {
  TidalTracksDocumentSchema,
  includedAlbums,
  nextPageCursor,
  tidalJson,
  tidalTrackCandidate,
  type TidalRequest,
} from '@/lib/tidal-api'

/** The first page and at most two more. */
const PAGE_LIMIT = 3

export const TidalIsrcLookupSchema = z
  .object({
    countryCode: TidalCountryCodeSchema,
    isrc: z.string().min(1).max(40),
  })
  .strict()
export type TidalIsrcLookup = z.infer<typeof TidalIsrcLookupSchema>

export type TidalTrackLookupPage = {
  page: number
  candidates: TidalTrackCandidate[]
}

/**
 * The TIDAL tracks with this ISRC and the albums each is on. Tracks TIDAL
 * returns with another ISRC are left out.
 */
export async function lookupTidalTracksByIsrc(
  request: TidalRequest,
  token: string,
  input: TidalIsrcLookup,
  observe?: (result: TidalTrackLookupPage) => Promise<void>,
): Promise<TidalTrackCandidate[]> {
  const { countryCode, isrc } = TidalIsrcLookupSchema.parse(input)
  const wanted = validIsrc(isrc)
  if (!wanted) throw new Error('Invalid ISRC')
  const params: [string, string][] = [
    ['countryCode', countryCode],
    ['filter[isrc]', wanted],
    ['include', 'albums'],
  ]
  const candidates = new Map<string, TidalTrackCandidate>()
  let cursor: string | null = null
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const document = TidalTracksDocumentSchema.parse(
      await tidalJson(
        request,
        token,
        '/tracks',
        cursor ? [...params, ['page[cursor]', cursor]] : params,
      ),
    )
    const albums = includedAlbums(document.included)
    const seen = document.data.map((track) =>
      tidalTrackCandidate(track, albums),
    )
    await observe?.({ page: page + 1, candidates: seen })
    for (const candidate of seen) {
      if (
        validIsrc(candidate.isrc) === wanted &&
        !candidates.has(candidate.tidalTrackId)
      )
        candidates.set(candidate.tidalTrackId, candidate)
    }
    cursor = nextPageCursor(document.links)
    if (!cursor) break
  }
  return [...candidates.values()]
}

/** Reads a TIDAL track match's lookup again from its recorded responses. */
export async function replayTidalTrackMatch(
  steps: readonly { operation: string; args: unknown }[],
  request: TidalRequest,
): Promise<TidalTrackCandidate[][]> {
  const [step] = steps
  if (steps.length !== 1 || step?.operation !== 'isrc-lookup')
    throw new Error('Expected one TIDAL ISRC lookup step')
  return [
    await lookupTidalTracksByIsrc(
      request,
      'offline-tidal-replay',
      TidalIsrcLookupSchema.parse(step.args),
    ),
  ]
}
