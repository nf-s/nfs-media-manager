import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { PluginMatchCandidatesSchema } from '@repo/media-plugin-sdk'
import {
  ARTIST_ENRICHMENT_TASK,
  ArtistProfileProviderSchema,
  type ArtistProfileProvider,
} from '@repo/schemas/artist-profiles'
import {
  MatchSearchInputSchema,
  MatchSearchResultSchema,
  UnresolvedMatchListSchema,
  UnresolvedMatchQuerySchema,
  type MatchCandidate,
  type MatchSearchInput,
  type MatchSearchResult,
  type UnresolvedMatchList,
  type UnresolvedMatchQuery,
} from '@repo/schemas/find-match'
import { db } from '@/lib/db'
import {
  createAlbumMatchRejectionPredicate,
  effectiveReferenceOverrides,
} from '@/lib/album-match-identities'
import { ServerError } from '@/lib/error'
import { createStableId, parseOptionalDate } from '@/lib/media-utils'
import {
  normalizeArtistProviderId,
  searchArtistCandidates,
} from '@/plugins/builtin/artist-providers'
import { getScrapePlugin } from '@/plugins/registry'
import { artist, scrapeJob, scrapeJobItem, scrapeJobLog } from '@/schemas/db'
import { getAlbumReleaseHints } from './album-release-hints'
import { readAlbumMatchRejections } from './album-match-rejections'
import { identifierUrl } from './artist-provider-evidence'
import { loadArtistProviderTarget } from './artist-profiles'
import {
  observeCatalogMedia,
  observeCatalogOccurrence,
} from './catalog-discoveries'
import { providerOperation } from './manual-add'
import { sonovaultAlbumMatchCandidates } from './sonovault-album-lookup'
import { observeFilmCandidate } from './film-catalog-observations'

const SHARED_FILM_REFERENCES = ['imdb', 'tmdb']

const unavailable = () =>
  new ServerError({
    statusCode: 422,
    message: 'Find match is not available for this provider.',
  })

async function loadMediaTarget(kind: 'album' | 'film', id: string) {
  const record = await db.query.mediaItem.findFirst({
    where: (table, operators) => operators.eq(table.id, id),
    with: { credits: { with: { artist: true } } },
  })
  if (!record || record.mediaType !== kind)
    throw new ServerError({
      statusCode: 404,
      message: kind === 'album' ? 'Album not found.' : 'Film not found.',
    })
  return {
    title: record.title,
    artists: record.credits
      .filter((credit) => credit.role === 'artist')
      .sort((a, b) => a.billingOrder - b.billingOrder)
      .map((credit) => credit.artist.name),
    releaseDate: record.releaseDate?.toISOString(),
  }
}

/** The search text shown for an item: its first artist, then its title. */
function mediaQuery(media: { title: string; artists: string[] }) {
  const artist = media.artists.find((name) => name.trim())?.trim()
  return artist ? `${artist} ${media.title}` : media.title
}

/**
 * The identifier of each reference type a scrape of `provider` would use:
 * the latest override, else the provider's own reference.
 */
async function currentMediaIdentifiers(
  kind: 'album' | 'film',
  id: string,
  provider: string,
  isRejectedMatch: ReturnType<typeof createAlbumMatchRejectionPredicate>,
) {
  const shared = kind === 'film' ? SHARED_FILM_REFERENCES : []
  const overrides = await db.query.providerReferenceOverride.findMany({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.mediaItemId, id),
        operators.inArray(table.provider, [provider, ...shared]),
      ),
    orderBy: (table, operators) => [
      operators.asc(table.createdAt),
      operators.asc(table.id),
    ],
  })
  const references = await db.query.providerReference.findMany({
    where: (table, operators) => operators.eq(table.mediaItemId, id),
  })
  const discardRejected = provider === 'discogs' ? isRejectedMatch : undefined
  const { active, keepStoredReference } = effectiveReferenceOverrides(
    overrides,
    discardRejected,
  )
  const current = new Map(
    active.map((override) => [override.referenceType, override.externalId]),
  )
  for (const reference of references)
    if (
      keepStoredReference(reference) &&
      !discardRejected?.(reference) &&
      !current.has(reference.referenceType) &&
      (reference.provider === provider ||
        shared.includes(reference.referenceType))
    )
      current.set(reference.referenceType, reference.externalId)
  return current
}

async function searchMedia(
  kind: 'album' | 'film',
  input: z.infer<typeof MatchSearchInputSchema>,
): Promise<MatchSearchResult> {
  const plugin = await getScrapePlugin(input.provider)
  if (
    !plugin?.searchMatchCandidates ||
    !plugin.manifest.mediaTypes.includes(kind)
  )
    throw unavailable()
  const media = await loadMediaTarget(kind, input.id)
  const rejections =
    kind === 'album' ? await readAlbumMatchRejections(db, input.id) : []
  const isRejectedMatch = createAlbumMatchRejectionPredicate(
    input.provider,
    rejections,
  )
  const releaseHints =
    kind === 'album' && plugin.manifest.albumReleaseHints
      ? await getAlbumReleaseHints(input.id, rejections)
      : undefined
  const candidates = await providerOperation(
    input.provider,
    async (context, provider) => {
      if (!provider.searchMatchCandidates) throw unavailable()
      return PluginMatchCandidatesSchema.parse(
        await provider.searchMatchCandidates({
          ...context,
          mediaType: kind,
          media: {
            ...media,
            ...(releaseHints?.length ? { releaseHints } : {}),
          },
          ...(input.q ? { query: input.q } : {}),
        }),
      )
    },
    undefined,
    'searching',
  )
  const filmCatalogIds = new Map<string, string>()
  if (kind === 'film') {
    const key = nanoid()
    await db.transaction(async (tx) => {
      for (const [index, candidate] of candidates.entries()) {
        const id = await observeFilmCandidate(tx, candidate, {
          provider: input.provider,
          operation: 'match-search',
          occurrenceKey: key,
          subjectKind: 'film',
          subjectId: input.id,
          position: index + 1,
        })
        if (id) filmCatalogIds.set(candidate.externalId, id)
      }
    })
  }
  const current = await currentMediaIdentifiers(
    kind,
    input.id,
    input.provider,
    isRejectedMatch,
  )
  const albumCatalogIds =
    kind === 'album'
      ? await observeAlbumMatchCandidates(input, candidates)
      : new Map<string, string>()
  return MatchSearchResultSchema.parse({
    provider: input.provider,
    query: input.q ?? mediaQuery(media),
    items: candidates
      .filter(
        (candidate) =>
          !isRejectedMatch(candidate) &&
          !(
            candidate.url &&
            isRejectedMatch({ referenceType: 'url', externalId: candidate.url })
          ),
      )
      .map(
        (candidate): MatchCandidate => ({
          referenceType: candidate.referenceType,
          catalogMediaItemId: albumCatalogIds.get(
            `${candidate.referenceType}:${candidate.externalId}`,
          ),
          externalId: candidate.externalId,
          title: candidate.title,
          subtitle: candidate.subtitle ?? null,
          releaseDate: candidate.releaseDate ?? null,
          artworkUrl: candidate.artworkUrl ?? null,
          url: candidate.url ?? null,
          catalogMediaItemId: filmCatalogIds.get(candidate.externalId),
          current:
            current.get(candidate.referenceType) === candidate.externalId,
        }),
      ),
  })
}

async function observeAlbumMatchCandidates(
  input: z.infer<typeof MatchSearchInputSchema>,
  candidates: z.infer<typeof PluginMatchCandidatesSchema>,
) {
  const occurrenceKey = nanoid()
  return db.transaction(async (tx) => {
    const ids = new Map<string, string>()
    for (const [index, candidate] of candidates.entries()) {
      const id = await observeCatalogMedia(
        tx,
        {
          kind: 'album',
          title: candidate.title,
          provider: input.provider,
          referenceType: candidate.referenceType,
          externalId: candidate.externalId,
          artworkUrl: candidate.artworkUrl,
          releaseDate: parseOptionalDate(candidate.releaseDate),
          referenceMetadata: { url: candidate.url ?? null },
        },
        {
          provider: input.provider,
          operation: 'match-search',
          occurrenceKey,
          subjectKind: 'album',
          subjectId: input.id,
          position: index + 1,
        },
      )
      ids.set(`${candidate.referenceType}:${candidate.externalId}`, id)
    }
    return ids
  })
}

async function loadArtist(id: string, provider: ArtistProfileProvider) {
  const target = await loadArtistProviderTarget(id, provider, undefined, {
    includeCatalog: true,
  })
  if (!target)
    throw new ServerError({ statusCode: 404, message: 'Artist not found.' })
  return {
    name: target.name,
    current: target.providerArtistId
      ? normalizeArtistProviderId(provider, target.providerArtistId)
      : null,
  }
}

function artistCandidate(
  provider: ArtistProfileProvider,
  candidate: {
    id: string
    name: string
    details?: string
    artworkUrl?: string
  },
  current: string | null,
): MatchCandidate {
  return {
    referenceType: 'artist',
    externalId: candidate.id,
    title: candidate.name,
    subtitle: candidate.details ?? null,
    releaseDate: null,
    artworkUrl: candidate.artworkUrl ?? null,
    url: identifierUrl(provider, candidate.id),
    current: candidate.id === current,
  }
}

async function searchArtist(
  input: z.infer<typeof MatchSearchInputSchema>,
): Promise<MatchSearchResult> {
  const provider = ArtistProfileProviderSchema.safeParse(input.provider)
  if (!provider.success) throw unavailable()
  const target = await loadArtist(input.id, provider.data)
  const candidates = await providerOperation(
    provider.data,
    (context) =>
      searchArtistCandidates(provider.data, target.name, input.q, context),
    undefined,
    'searching',
  )
  const occurrenceKey = nanoid()
  const items = await db.transaction(async (tx) => {
    const result: MatchCandidate[] = []
    for (const [index, candidate] of candidates.entries()) {
      const current = candidate.id === target.current
      const provisionalId = createStableId(
        'catalog-artist',
        JSON.stringify([provider.data, candidate.id]),
      )
      if (!current)
        await tx
          .insert(artist)
          .values({
            id: provisionalId,
            name: candidate.name,
            sortName: candidate.name,
            catalogProvider: provider.data,
            catalogExternalId: candidate.id,
          })
          .onConflictDoNothing()
      const [native] = current
        ? []
        : await tx
            .select({ id: artist.id, merged: artist.mergedIntoId })
            .from(artist)
            .where(
              and(
                eq(artist.catalogProvider, provider.data),
                eq(artist.catalogExternalId, candidate.id),
              ),
            )
      const id = current ? input.id : (native?.merged ?? native?.id)
      if (id)
        await observeCatalogOccurrence(
          tx,
          { kind: 'artist', id },
          {
            provider: provider.data,
            operation: 'match-search',
            occurrenceKey,
            subjectKind: 'artist',
            subjectId: input.id,
            position: index + 1,
            details: { details: candidate.details ?? null },
          },
        )
      result.push({
        ...artistCandidate(provider.data, candidate, target.current),
        catalogMediaItemId: id,
      })
    }
    return result
  })
  return MatchSearchResultSchema.parse({
    provider: provider.data,
    query: input.q ?? target.name,
    items,
  })
}

/**
 * Searches one provider for the records an item could be matched to. Every
 * request goes through the provider's request policy; a provider that is
 * halted, cooling down or over budget refuses with a 422.
 */
export async function searchMatchCandidates(
  input: MatchSearchInput,
): Promise<MatchSearchResult> {
  const options = MatchSearchInputSchema.parse(input)
  return options.kind === 'artist'
    ? searchArtist(options)
    : searchMedia(options.kind, options)
}

const FailureLogSchema = z.object({
  classification: z.enum(['not-found', 'ambiguous']),
  diagnostics: z.array(z.unknown()).optional(),
})

const CandidateDiagnosticSchema = z.object({
  stage: z.enum(['artist.candidates', 'artist.stored-candidates']),
  evidence: z.object({ candidates: z.array(z.unknown()) }),
})

const StoredArtistCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  details: z.string().trim().min(1).optional(),
})

/** The artists an ambiguous lookup recorded before it stopped. */
function storedArtistCandidates(
  provider: ArtistProfileProvider,
  diagnostics: unknown[],
) {
  const recorded = diagnostics
    .map((entry) => CandidateDiagnosticSchema.safeParse(entry))
    .flatMap((entry) => (entry.success ? [entry.data] : []))
    .at(-1)
  const candidates = new Map<
    string,
    z.infer<typeof StoredArtistCandidateSchema>
  >()
  for (const value of recorded?.evidence.candidates ?? []) {
    const candidate = StoredArtistCandidateSchema.safeParse(value)
    const id = candidate.success
      ? normalizeArtistProviderId(provider, candidate.data.id)
      : null
    if (candidate.success && id && !candidates.has(id))
      candidates.set(id, { ...candidate.data, id })
  }
  return [...candidates.values()].slice(0, 20)
}

/**
 * SONO-22: the Discogs master or release and MusicBrainz release group of an
 * album's confirmed Sonovault release, offered in that provider's Find match
 * where the album has no match of that kind or a different one. Choosing one
 * goes through the usual save and refresh.
 */
async function addSonovaultSuggestions(
  items: UnresolvedMatchList['items'],
  albumId: string,
) {
  const suggestions = await sonovaultAlbumMatchCandidates(albumId)
  if (!suggestions.length) return
  const rejections = await readAlbumMatchRejections(db, albumId)
  for (const entry of suggestions) {
    // An identity marked incorrect for this album is not offered again.
    if (
      createAlbumMatchRejectionPredicate(
        entry.provider,
        rejections,
      )({ referenceType: entry.referenceType, externalId: entry.sonovault })
    )
      continue
    const candidate: MatchCandidate = {
      referenceType: entry.referenceType,
      externalId: entry.sonovault,
      title: entry.title,
      subtitle: [entry.artist, 'Sonovault'].filter(Boolean).join(' · '),
      releaseDate: null,
      artworkUrl: null,
      url: entry.url,
      current: false,
    }
    const existing = items.find((item) => item.provider === entry.provider)
    if (!existing)
      items.push({
        provider: entry.provider,
        jobId: entry.jobId,
        outcome: 'suggested',
        candidates: [candidate],
      })
    else if (
      existing.candidates.length < 20 &&
      !existing.candidates.some(
        (item) =>
          item.referenceType === candidate.referenceType &&
          item.externalId === candidate.externalId,
      )
    )
      existing.candidates.push(candidate)
  }
}

/**
 * The providers whose latest lookup for an item found nothing or found
 * several records, read from stored jobs without provider requests, and
 * those a confirmed Sonovault release suggests a match for.
 */
export async function listUnresolvedMatches(
  query: UnresolvedMatchQuery,
): Promise<UnresolvedMatchList> {
  const { kind, id } = UnresolvedMatchQuerySchema.parse(query)
  const found =
    kind === 'artist'
      ? await db.query.artist.findFirst({
          columns: { id: true },
          where: (table, operators) => operators.eq(table.id, id),
        })
      : await db.query.mediaItem.findFirst({
          columns: { id: true },
          where: (table, operators) =>
            operators.and(
              operators.eq(table.id, id),
              operators.eq(table.mediaType, kind),
            ),
        })
  if (!found)
    throw new ServerError({ statusCode: 404, message: 'Item not found.' })
  const latest =
    kind === 'artist'
      ? await db
          .selectDistinctOn([scrapeJob.provider], {
            id: scrapeJob.id,
            provider: scrapeJob.provider,
            status: scrapeJob.status,
          })
          .from(scrapeJob)
          .where(
            and(
              sql`${scrapeJob.options}->>'task' = ${ARTIST_ENRICHMENT_TASK}`,
              sql`${scrapeJob.options}->>'artistId' = ${id}`,
              sql`${scrapeJob.options}->>'verifySnapshotId' is null`,
            ),
          )
          .orderBy(
            scrapeJob.provider,
            desc(scrapeJob.createdAt),
            desc(scrapeJob.id),
          )
      : await db
          .selectDistinctOn([scrapeJob.provider], {
            id: scrapeJob.id,
            provider: scrapeJob.provider,
            status: scrapeJob.status,
          })
          .from(scrapeJob)
          .innerJoin(scrapeJobItem, eq(scrapeJobItem.jobId, scrapeJob.id))
          .where(eq(scrapeJobItem.mediaItemId, id))
          .orderBy(
            scrapeJob.provider,
            desc(scrapeJob.createdAt),
            desc(scrapeJob.id),
          )
  const failed = latest.filter((job) => job.status === 'failed')
  const logs = !failed.length
    ? []
    : await db
        .select({
          jobId: scrapeJobLog.jobId,
          metadata: scrapeJobLog.metadata,
        })
        .from(scrapeJobLog)
        .where(
          and(
            inArray(
              scrapeJobLog.jobId,
              failed.map((job) => job.id),
            ),
            eq(scrapeJobLog.level, 'error'),
          ),
        )
        .orderBy(desc(scrapeJobLog.createdAt), desc(scrapeJobLog.id))
  const items: UnresolvedMatchList['items'] = []
  for (const job of failed) {
    const failure = logs
      .filter((log) => log.jobId === job.id)
      .map((log) => FailureLogSchema.safeParse(log.metadata))
      .find((log) => log.success)
    if (!failure?.success) continue
    const provider = ArtistProfileProviderSchema.safeParse(job.provider)
    const stored =
      kind === 'artist' &&
      provider.success &&
      failure.data.classification === 'ambiguous'
        ? storedArtistCandidates(provider.data, failure.data.diagnostics ?? [])
        : []
    const target =
      stored.length && provider.success
        ? await loadArtistProviderTarget(id, provider.data)
        : null
    const current =
      target?.providerArtistId && provider.success
        ? normalizeArtistProviderId(provider.data, target.providerArtistId)
        : null
    items.push({
      provider: job.provider,
      jobId: job.id,
      outcome: failure.data.classification,
      candidates: provider.success
        ? stored.map((candidate) =>
            artistCandidate(provider.data, candidate, current),
          )
        : [],
    })
  }
  if (kind === 'album') await addSonovaultSuggestions(items, id)
  if (!items.length) return { query: null, items }
  const text =
    kind === 'artist'
      ? ((
          await db.query.artist.findFirst({
            columns: { name: true },
            where: (table, operators) => operators.eq(table.id, id),
          })
        )?.name ?? null)
      : mediaQuery(await loadMediaTarget(kind, id))
  return UnresolvedMatchListSchema.parse({ query: text, items })
}
