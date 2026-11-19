import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import {
  isProviderArtistSearchAmbiguousError,
  isProviderItemNotFoundError,
} from '@repo/media-plugin-sdk'
import { MAX_PROVIDER_RESPONSE_BYTES } from '@repo/schemas/provider-response'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import { readAlbumMatchRejections } from '@/services/album-match-rejections'
import { db } from '@/lib/db'
import { jobLogSecrets } from '@/lib/job-errors'
import { sanitizeProviderPayload } from '@/lib/job-diagnostics'
import {
  ArtistSearchAmbiguousError,
  normalizeArtistProviderId,
} from '@/plugins/builtin/artist-providers'
import { getBuiltinScrapePlugin } from '@/plugins/builtin'
import {
  ProviderReplayContextSchema,
  ProviderReplayScopeSchema,
  readProviderReplayJobScope,
  reconstructProviderReplayContext,
} from '@/services/provider-response-context'
import { listArtistScrobbledRecordings } from '@/services/artist-listening'
import { listSpotifyArtistRecordings } from '@/services/artist-provider-evidence'
import { readProviderResponseAttempt } from '@/services/provider-response-history'
import { replayScrapeProvider } from '@/services/provider-response-replay'

const usage =
  'replay-provider-response.ts <export|replay> --job ID --attempt N ' +
  '[--item ID] [--artist ID] --output PRIVATE_FILE ' +
  '[--context PRIVATE_FILE] [--native PRIVATE_FILE]'

type Scope = z.infer<typeof ProviderReplayScopeSchema>
type Context = z.infer<typeof ProviderReplayContextSchema>
type ReplayInput = Parameters<typeof replayScrapeProvider>[2][number]
type CaptureRow = Awaited<
  ReturnType<typeof readProviderResponseAttempt>
>[number]

class ReplayCommandError extends Error {}

export function parseReplayArguments(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      job: { type: 'string' },
      attempt: { type: 'string' },
      item: { type: 'string' },
      artist: { type: 'string' },
      context: { type: 'string' },
      native: { type: 'string' },
      output: { type: 'string' },
    },
  })
  const [action] = positionals
  const scope = ProviderReplayScopeSchema.safeParse({
    jobId: values.job,
    jobItemId: values.item ?? null,
    artistId: values.artist ?? null,
    attempt: Number(values.attempt),
  })
  if (
    (action !== 'export' && action !== 'replay') ||
    positionals.length !== 1 ||
    !scope.success ||
    !values.output ||
    (action === 'export' && (values.context || values.native))
  )
    throw new ReplayCommandError(usage)
  return {
    action,
    scope: scope.data,
    output: values.output,
    context: values.context,
    native: values.native,
  }
}

export function selectProviderReplayCaptures(
  scope: Scope,
  rows: CaptureRow[],
  allowIncomplete = false,
) {
  if (
    !allowIncomplete &&
    rows.some(({ capture }, index) => capture.ordinal !== index + 1)
  )
    throw new ReplayCommandError(
      'The recorded attempt has gaps in its response evidence.',
    )
  const selected =
    scope.artistId === null
      ? rows
      : rows.filter(
          ({ artistId, capture }) =>
            artistId === scope.artistId && capture.phase === 'artist',
        )
  if (!selected.length)
    throw new ReplayCommandError(
      'No provider responses are saved for this attempt and target.',
    )
  const start = selected[0]?.capture.ordinal
  if (
    start === undefined ||
    (!allowIncomplete &&
      selected.some(({ capture }, index) => capture.ordinal !== start + index))
  )
    throw new ReplayCommandError(
      'The selected artist responses are interleaved. Use the full job item.',
    )
  return selected
}

function phasesFor(rows: CaptureRow[]) {
  const phases: Parameters<
    typeof reconstructProviderReplayContext
  >[2][number][] = []
  for (const row of rows) {
    const phase =
      row.capture.phase === 'media'
        ? ({ phase: 'media', artistId: null } satisfies (typeof phases)[number])
        : row.artistId !== null
          ? ({
              phase: 'artist',
              artistId: row.artistId,
            } satisfies (typeof phases)[number])
          : null
    if (!phase)
      throw new ReplayCommandError(
        'The saved artist response no longer has a library target.',
      )
    const previous = phases.at(-1)
    if (previous?.phase !== phase.phase || previous.artistId !== phase.artistId)
      phases.push(phase)
  }
  return phases
}

export function validateReplayContext(
  value: unknown,
  scope: Scope,
  provider: string,
  mediaItemId: string | null,
  rows: CaptureRow[],
) {
  const parsed = ProviderReplayContextSchema.safeParse(value)
  if (!parsed.success)
    throw new ReplayCommandError('The replay lookup context is invalid.')
  const context = parsed.data
  const contextScope = context.scope
  if (
    context.provider !== provider ||
    contextScope.jobId !== scope.jobId ||
    contextScope.jobItemId !== scope.jobItemId ||
    contextScope.artistId !== scope.artistId ||
    contextScope.attempt !== scope.attempt
  )
    throw new ReplayCommandError(
      'The replay lookup context belongs to another attempt.',
    )
  const phases = phasesFor(rows)
  if (
    context.inputs.length !== phases.length ||
    context.inputs.some((input, index) => {
      const phase = phases[index]
      if (!phase || phase.phase !== input.phase) return true
      return input.phase === 'media'
        ? input.context.mediaItemId !== mediaItemId
        : input.context.artist.id !== phase.artistId ||
            input.bootstrap !== (scope.jobItemId !== null)
    })
  )
    throw new ReplayCommandError(
      'The replay lookup context does not match the recorded targets.',
    )
  return context
}

async function readPrivateJson(path: string, limit: number): Promise<unknown> {
  const { constants } = await import('node:fs')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await file.stat()
    if (
      !stats.isFile() ||
      stats.mode & 0o077 ||
      stats.uid !== process.getuid?.() ||
      stats.size > limit
    )
      throw new ReplayCommandError(
        'Replay input must be an owner-only file within the size limit.',
      )
    const bytes = await file.readFile()
    if (bytes.byteLength > limit)
      throw new ReplayCommandError('Replay input exceeds the size limit.')
    return JSON.parse(bytes.toString('utf8'))
  } finally {
    await file.close()
  }
}

export async function writePrivateJson(path: string, value: unknown) {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value) + '\n', 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
}

const NativeProjectionFileSchema = z.object({
  scope: ProviderReplayScopeSchema,
  entries: z
    .array(
      z.object({
        ordinal: z.number().int().positive(),
        requestKey: z.string().regex(/^[a-f0-9]{64}$/i),
        reference: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,200}$/)
          .optional(),
        status: z.number().int().min(200).max(599),
        contentType: z.string().regex(/^[a-z0-9]+\/[a-z0-9!#$&^_.+-]+$/i),
        text: z.string().max(MAX_PROVIDER_RESPONSE_BYTES),
      }),
    )
    .max(100),
})

const spotifyTrackPath =
  /^https:\/\/api\.spotify\.com\/v1\/tracks\/([a-z0-9]{22})$/i
const lastfmArtistSearch = z.object({
  results: z.object({ artistmatches: z.unknown() }),
})

function recordedSpotifyTracks(rows: CaptureRow[], artistId: string) {
  return [
    ...new Set(
      rows.flatMap((row) => {
        if (row.artistId !== artistId || row.capture.phase !== 'artist')
          return []
        const match = spotifyTrackPath.exec(row.capture.request.url ?? '')?.[1]
        return match ? [match] : []
      }),
    ),
  ]
}

export function recordedArtistLookupByName(
  provider: string,
  rows: CaptureRow[],
  artistId: string,
) {
  return rows.some(({ artistId: owner, capture }) => {
    if (owner !== artistId || capture.phase !== 'artist') return false
    if (provider === 'spotify') {
      const url = capture.request.url ?? ''
      return (
        spotifyTrackPath.test(url) ||
        url === 'https://api.spotify.com/v1/search'
      )
    }
    if (provider !== 'lastfm' || capture.response.body.state !== 'captured')
      return false
    try {
      const payload: unknown = JSON.parse(capture.response.body.text)
      return lastfmArtistSearch.safeParse(payload).success
    } catch {
      return false
    }
  })
}

export function recordedLastfmInferredMbid(
  rows: CaptureRow[],
  artistId: string,
) {
  const relevant = rows.filter(
    (row) => row.artistId === artistId && row.capture.phase === 'artist',
  )
  const first = relevant[0]?.capture.response.body
  if (
    first?.state !== 'captured' ||
    !recordedArtistLookupByName('lastfm', relevant.slice(1), artistId)
  )
    return undefined
  try {
    const parsed = z
      .object({ artist: z.object({ mbid: z.string() }) })
      .safeParse(JSON.parse(first.text))
    return parsed.success
      ? (normalizeArtistProviderId('musicbrainz', parsed.data.artist.mbid) ??
          undefined)
      : undefined
  } catch {
    return undefined
  }
}

async function offlineInputs(
  context: Context,
  placeholderNames: string[],
  rows: CaptureRow[],
): Promise<ReplayInput[]> {
  const secrets: Record<string, string> = Object.fromEntries(
    placeholderNames.map((key, index) => [key, `offline-fixture-${index + 1}`]),
  )
  if (context.provider === 'spotify' && context.spotifyMarket)
    secrets['market'] = context.spotifyMarket
  const results: ReplayInput[] = []
  for (const input of context.inputs) {
    if (input.phase === 'media') {
      const rejections =
        input.context.mediaType === 'album'
          ? await readAlbumMatchRejections(db, input.context.mediaItemId)
          : []
      const isRejectedMatch = createAlbumMatchRejectionPredicate(
        context.provider,
        rejections,
      )
      results.push({
        phase: 'media',
        context: {
          ...input.context,
          existingReferences: input.context.existingReferences.filter(
            (reference) => !isRejectedMatch(reference),
          ),
          ...(rejections.length ? { isRejectedMatch } : {}),
          secrets,
          log: async () => {},
        },
      })
      continue
    }
    const { artist, providerArtistId } = input.context
    const result: Extract<ReplayInput, { phase: 'artist' }> = {
      phase: 'artist',
      bootstrap: input.bootstrap,
      context: { ...input.context, secrets },
    }
    if (
      !input.bootstrap &&
      (providerArtistId === null || input.inferredLastfmMbid)
    ) {
      const trackIds = recordedSpotifyTracks(rows, artist.id)
      if (context.provider === 'spotify') {
        const recordings = trackIds.length
          ? (input.spotifyRecordings ??
            (await listSpotifyArtistRecordings(artist.id)))
          : undefined
        if (
          trackIds.some(
            (id, index) => recordings?.[index]?.spotifyTrackId !== id,
          )
        )
          throw new ReplayCommandError(
            'The saved Spotify recording requests differ from the replay recording inputs.',
          )
        result.recordings = {
          spotifyRecordings: recordings,
          loadSpotifyCatalogRecordings: () =>
            listArtistScrobbledRecordings(db, artist.id, artist.name, {
              requireRelease: true,
            }),
        }
      } else if (context.provider === 'lastfm') {
        // Follow the same bounded lookup in memory without exporting listening history.
        result.recordings = {
          inferredLastfmMbid: input.inferredLastfmMbid,
          loadLastfmRecordings: () =>
            listArtistScrobbledRecordings(db, artist.id, artist.name),
        }
      }
    }
    results.push(result)
  }
  return results
}

export async function runProviderReplayCommand(args: string[]) {
  const command = parseReplayArguments(args)
  const { scope } = command
  const job = await readProviderReplayJobScope(scope)
  if (!job)
    throw new ReplayCommandError(
      'The selected job does not own that item or artist.',
    )

  const rows = selectProviderReplayCaptures(
    scope,
    await readProviderResponseAttempt(scope),
    command.action === 'export',
  )
  const scrub = (value: unknown) =>
    sanitizeProviderPayload(value, jobLogSecrets({}))
  const readContext = async () => {
    const reconstructed = command.context
      ? await readPrivateJson(command.context, 4 * 1024 * 1024)
      : await reconstructProviderReplayContext(
          scope,
          job,
          phasesFor(rows).map((phase) =>
            phase.phase === 'artist'
              ? {
                  ...phase,
                  inferredLastfmMbid:
                    job.provider === 'lastfm'
                      ? recordedLastfmInferredMbid(rows, phase.artistId)
                      : undefined,
                  lookupByName: recordedArtistLookupByName(
                    job.provider,
                    rows,
                    phase.artistId,
                  ),
                }
              : phase,
          ),
        )
    if (reconstructed === null) return null
    const validated = validateReplayContext(
      reconstructed,
      scope,
      job.provider,
      job.mediaItemId,
      rows,
    )
    const cleaned = ProviderReplayContextSchema.parse(scrub(validated))
    return {
      ...cleaned,
      // These values have already been tied to the saved job. Redaction must
      // not alias identifiers or cause another item to be selected.
      scope: validated.scope,
      provider: validated.provider,
      inputs: cleaned.inputs.map((input, index) => {
        const original = validated.inputs[index]
        if (input.phase === 'media' && original?.phase === 'media')
          return {
            ...input,
            context: {
              ...input.context,
              mediaItemId: original.context.mediaItemId,
            },
          }
        if (input.phase === 'artist' && original?.phase === 'artist')
          return {
            ...input,
            context: {
              ...input.context,
              artist: {
                ...input.context.artist,
                id: original.context.artist.id,
              },
            },
          }
        throw new ReplayCommandError(
          'The replay lookup context is invalid after credential scrubbing.',
        )
      }),
    }
  }
  const context =
    command.action === 'export'
      ? await readContext().catch(() => null)
      : await readContext()

  if (command.action === 'export') {
    await writePrivateJson(command.output, {
      version: 1,
      scope,
      provider: job.provider,
      contextSource: context === null ? 'unavailable' : 'current-library',
      context,
      responses: rows,
    })
    process.stdout.write('Saved private provider response export.\n')
    return
  }

  const plugin = getBuiltinScrapePlugin(job.provider)
  if (!plugin)
    throw new ReplayCommandError(
      'Export the evidence and use the installed adapter in a network-disabled process.',
    )
  if (context === null)
    throw new ReplayCommandError(
      'The original lookup context could not be reconstructed. Supply a private context file.',
    )
  const originalOrdinals = new Map<number, number>()
  const captures = rows.map(({ capture }, index) => {
    const ordinal = index + 1
    originalOrdinals.set(ordinal, capture.ordinal)
    return { ...capture, ordinal }
  })
  const nativeValue = command.native
    ? NativeProjectionFileSchema.safeParse(
        await readPrivateJson(command.native, 40 * 1024 * 1024),
      )
    : null
  if (
    nativeValue &&
    (!nativeValue.success ||
      JSON.stringify(nativeValue.data.scope) !== JSON.stringify(scope))
  )
    throw new ReplayCommandError(
      'The private native projection belongs to another attempt or is invalid.',
    )
  const native = new Map(
    nativeValue?.success
      ? nativeValue.data.entries.map((entry) => [entry.ordinal, entry])
      : [],
  )
  if (nativeValue?.success && native.size !== nativeValue.data.entries.length)
    throw new ReplayCommandError(
      'The private native projection repeats a response ordinal.',
    )

  // Also block direct network access through the standard fetch API. The CLI
  // only executes built-in adapters, whose provider HTTP calls use the SDK.
  const fetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new ReplayCommandError(
      'Live requests are disabled during provider replay.',
    )
  }
  try {
    const replay = await replayScrapeProvider(
      job.provider,
      captures,
      await offlineInputs(
        context,
        plugin.manifest.secrets
          .filter(({ required }) => required)
          .map(({ key }) => key),
        rows,
      ),
      {
        ...(native.size
          ? {
              projectNativeResponse: async (capture) => {
                const ordinal = originalOrdinals.get(capture.ordinal)
                const projection =
                  ordinal === undefined ? undefined : native.get(ordinal)
                if (
                  !projection ||
                  projection.requestKey !== capture.request.key ||
                  projection.status !== capture.response.status ||
                  (capture.response.body.state === 'local' &&
                    projection.reference !== capture.response.body.reference) ||
                  Buffer.byteLength(projection.text) >
                    MAX_PROVIDER_RESPONSE_BYTES
                )
                  throw new ReplayCommandError(
                    'The native projection does not match the saved response.',
                  )
                const text = z.string().parse(scrub(projection.text))
                return new Response(text, {
                  status: projection.status,
                  headers: { 'content-type': projection.contentType },
                })
              },
            }
          : {}),
      },
    ).then(
      (result) => ({
        outcome: 'mapped',
        result: scrub(
          result.map((entry) =>
            'normalized' in entry
              ? { normalized: entry.normalized }
              : { profile: entry.profile },
          ),
        ),
      }),
      (error: unknown) => {
        if (isProviderItemNotFoundError(error))
          return { outcome: 'not-found', result: [] }
        if (
          error instanceof ArtistSearchAmbiguousError ||
          isProviderArtistSearchAmbiguousError(error)
        )
          return { outcome: 'ambiguous', result: [] }
        throw error
      },
    )
    await writePrivateJson(command.output, {
      version: 1,
      scope,
      provider: job.provider,
      contextSource: command.context ? 'supplied' : 'current-library',
      ...replay,
    })
    process.stdout.write('Saved private provider replay report.\n')
  } finally {
    globalThis.fetch = fetch
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runProviderReplayCommand(process.argv.slice(2)).catch(
    (error: unknown) => {
      // Provider, adapter, database and filesystem errors can contain private values.
      const message =
        error instanceof ReplayCommandError
          ? error.message
          : error instanceof Error &&
              [
                'Provider replay request differs from the recorded request',
                'Provider replay request is missing or differs from the recorded request',
                'Provider replay did not consume its complete request history',
              ].includes(error.message)
            ? 'The replayed lookup does not match the saved request fingerprint. Check for changed references, options or provider configuration.'
            : error instanceof Error &&
                error.message ===
                  'Provider replay requires an offline projector for native worker evidence'
              ? 'This response needs an explicit offline native projection.'
              : error instanceof Error &&
                  error.message ===
                    'Provider replay response body is unavailable'
                ? 'A recorded response body is not available for replay.'
                : 'Replay could not finish from the saved responses. Check the saved context and response availability.'
      process.stderr.write(message + '\n')
      process.exitCode = 1
    },
  )
}
