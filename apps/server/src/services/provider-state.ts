import { and, asc, eq, inArray, notInArray, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { observeCatalogOccurrence } from './catalog-discoveries'
import {
  JsonValueSchema,
  ProviderItemAmbiguousError,
  ProviderItemNotFoundError,
  type PluginNormalizedResult,
  type JsonValue,
} from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import {
  createAlbumMatchRejectionPredicate,
  effectiveReferenceOverrides,
  isDiscogsAlbumReference,
  type RejectedAlbumIdentity,
} from '@/lib/album-match-identities'
import { filmAddedDate } from '@/lib/film-added-date'
import { resolveFileImportPatches } from '@/lib/file-import-patches'
import {
  legacySpotifyAlbumTracklist,
  spotifyAlbumId,
  SpotifyIdSchema,
} from '@/lib/spotify-api'
import { sanitizeAlbumProviderResult } from '@/lib/spotify-audio-features'
import { recordFilmAddedDate } from './film-added-dates'
import { observeFilmRelations } from './film-catalog-observations'
import {
  hasBlockedFilmReference,
  isBlockedFilmReference,
  lockFilmReferenceWrites,
  saveMdblistFilmReferences,
} from './film-reference-state'
import {
  discogsMasterReleaseMatch,
  readAlbumMatchRejections,
} from './album-match-rejections'
import {
  lockLibraryTrackWrites,
  replaceAlbumTracks,
} from './album-library-tracks'
import { recordAlbumTrackProviderReferences } from './album-track-provider-references'
import { writeArtistCredits } from './artist-names'
import { lockTagWrites, upsertProviderTags } from './tag-state'
import {
  checksumJson,
  createStableId,
  parseOptionalDate,
  slugifyParts,
} from '@/lib/media-utils'
import {
  album,
  externalLink,
  film,
  mediaCredit,
  mediaItem,
  mediaItemTag,
  mediaOverride,
  playlist,
  playlistItem,
  providerCurrentState,
  providerReference,
  providerReferenceOverride,
  providerSnapshot,
} from '@/schemas/db'

type ProviderDatabase = Parameters<Parameters<typeof db.transaction>[0]>[0]

interface ApplyProviderResultInput {
  mediaItemId: string
  mediaType: 'album' | 'film'
  provider: string
  source: string
  payload: JsonValue
  normalized: PluginNormalizedResult
  scrapeJobId?: string | null
  legacySpotifyAlbumId?: string
}

interface NormalizedCreditInsert {
  artistId: string
  name: string
  role: string
  billingOrder: number
}

async function replaceProviderReferences(
  database: ProviderDatabase,
  mediaItemId: string,
  providerId: string,
  references: PluginNormalizedResult['references'],
  isRejectedMatch?: ReturnType<typeof createAlbumMatchRejectionPredicate>,
  checkFilmReferenceStatus = false,
): Promise<void> {
  const overrides = await database
    .select()
    .from(providerReferenceOverride)
    .where(
      and(
        eq(providerReferenceOverride.mediaItemId, mediaItemId),
        or(
          eq(providerReferenceOverride.provider, providerId),
          and(
            inArray(providerReferenceOverride.provider, ['imdb', 'tmdb']),
            sql`${providerReferenceOverride.provider} = ${providerReferenceOverride.referenceType}`,
          ),
        ),
      ),
    )
    .orderBy(
      asc(providerReferenceOverride.createdAt),
      asc(providerReferenceOverride.id),
    )
  const { active, discogs, keepStoredReference } = effectiveReferenceOverrides(
    overrides,
    isRejectedMatch,
  )
  if (
    providerId === 'discogs' &&
    isRejectedMatch &&
    references.some((reference) => {
      const owned = { ...reference, provider: providerId }
      if (!isDiscogsAlbumReference(owned)) return false
      return discogs
        ? reference.referenceType !== discogs.referenceType ||
            reference.externalId !== discogs.externalId
        : !keepStoredReference(owned)
    })
  )
    throw new ProviderItemNotFoundError(
      'The Discogs selection changed during lookup. Refresh to use the current selection.',
    )
  const effective = new Map(
    active.map((override) => [override.referenceType, override.externalId]),
  )
  const effectiveReferences = new Map<
    string,
    PluginNormalizedResult['references'][number]
  >()
  for (const reference of references) {
    const overrideId = effective.get(reference.referenceType)
    if (overrideId !== undefined && overrideId !== reference.externalId)
      continue
    const key = `${reference.referenceType}:${reference.externalId}`
    const earlier = effectiveReferences.get(key)
    effectiveReferences.set(
      key,
      overrideId !== undefined && !reference.metadata && earlier?.metadata
        ? { ...reference, metadata: earlier.metadata }
        : reference,
    )
  }
  const withoutFreshMetadata = [...effective].filter(
    ([type, id]) => !effectiveReferences.get(`${type}:${id}`)?.metadata,
  )
  if (withoutFreshMetadata.length) {
    const existing = await database
      .select({
        referenceType: providerReference.referenceType,
        externalId: providerReference.externalId,
        isPrimary: providerReference.isPrimary,
        metadata: providerReference.metadata,
      })
      .from(providerReference)
      .where(
        and(
          eq(providerReference.mediaItemId, mediaItemId),
          eq(providerReference.provider, providerId),
          inArray(
            providerReference.referenceType,
            withoutFreshMetadata.map(([type]) => type),
          ),
        ),
      )
    const byId = new Map(
      existing.map((reference) => [
        `${reference.referenceType}:${reference.externalId}`,
        reference,
      ]),
    )
    for (const [referenceType, externalId] of withoutFreshMetadata) {
      const key = `${referenceType}:${externalId}`
      const fresh = effectiveReferences.get(key)
      const prior = byId.get(key)
      effectiveReferences.set(key, {
        referenceType,
        externalId,
        isPrimary: fresh?.isPrimary ?? prior?.isPrimary ?? false,
        metadata: fresh?.metadata ?? prior?.metadata ?? undefined,
      })
    }
  }
  const blockedReferences = checkFilmReferenceStatus
    ? (
        await database.query.providerReference.findMany({
          columns: {
            id: true,
            referenceType: true,
            externalId: true,
            metadata: true,
          },
          where: eq(providerReference.mediaItemId, mediaItemId),
        })
      ).filter(isBlockedFilmReference)
    : []
  if (
    [...effectiveReferences.values()].some((reference) =>
      hasBlockedFilmReference(blockedReferences, reference),
    )
  )
    throw new ProviderItemAmbiguousError(
      'The film reference was rejected or is unverified. Review the match before refreshing.',
    )
  await database.delete(providerReference).where(
    and(
      eq(providerReference.mediaItemId, mediaItemId),
      eq(providerReference.provider, providerId),
      blockedReferences.length
        ? notInArray(
            providerReference.id,
            blockedReferences.map(({ id }) => id),
          )
        : undefined,
    ),
  )

  for (const reference of effectiveReferences.values()) {
    const referenceId = createStableId(
      'pref',
      `${mediaItemId}:${providerId}:${reference.referenceType}:${reference.externalId}`,
    )

    await database.insert(providerReference).values({
      id: referenceId,
      mediaItemId,
      provider: providerId,
      referenceType: reference.referenceType,
      externalId: reference.externalId,
      isPrimary: reference.isPrimary,
      metadata: reference.metadata,
    })
  }
}

async function replaceExternalLinks(
  database: ProviderDatabase,
  mediaItemId: string,
  providerId: string,
  links: PluginNormalizedResult['links'],
): Promise<void> {
  await database
    .delete(externalLink)
    .where(
      and(
        eq(externalLink.mediaItemId, mediaItemId),
        eq(externalLink.provider, providerId),
      ),
    )

  for (const link of links) {
    await database.insert(externalLink).values({
      id: createStableId('link', `${mediaItemId}:${providerId}:${link.url}`),
      mediaItemId,
      provider: providerId,
      label: link.label,
      url: link.url,
    })
  }
}

async function replaceCredits(
  database: ProviderDatabase,
  mediaItemId: string,
  credits: PluginNormalizedResult['credits'],
): Promise<void> {
  if (credits.length === 0) {
    return
  }

  await database
    .delete(mediaCredit)
    .where(
      and(
        eq(mediaCredit.mediaItemId, mediaItemId),
        inArray(mediaCredit.role, [
          ...new Set(credits.map((credit) => credit.role)),
        ]),
      ),
    )

  await writeArtistCredits(
    database,
    normalizeCreditsForInsert(credits).map(({ name, role, billingOrder }) => ({
      mediaItemId,
      name,
      role,
      billingOrder,
    })),
  )
}

export function normalizeCreditsForInsert(
  credits: PluginNormalizedResult['credits'],
): NormalizedCreditInsert[] {
  const byArtistRole = new Map<string, NormalizedCreditInsert>()

  for (const credit of credits) {
    const artistId = createStableId('artist', credit.name.toLowerCase())
    const key = `${artistId}:${credit.role}`
    const existing = byArtistRole.get(key)

    if (!existing || credit.billingOrder < existing.billingOrder) {
      byArtistRole.set(key, {
        artistId,
        name: credit.name,
        role: credit.role,
        billingOrder: credit.billingOrder,
      })
    }
  }

  return [...byArtistRole.values()].sort(
    (left, right) =>
      left.billingOrder - right.billingOrder ||
      left.role.localeCompare(right.role) ||
      left.name.localeCompare(right.name),
  )
}

async function upsertPlaylistMemberships(
  database: ProviderDatabase,
  mediaItemId: string,
  memberships: PluginNormalizedResult['playlists'],
): Promise<void> {
  for (const membership of memberships) {
    const playlistId = createStableId(
      membership.kind === 'collection' ? 'collection' : 'playlist',
      `${membership.kind}:${membership.name.toLowerCase()}`,
    )

    await database
      .insert(playlist)
      .values({
        id: playlistId,
        name: membership.name,
        kind: membership.kind,
      })
      .onConflictDoNothing()

    await database
      .insert(playlistItem)
      .values({
        playlistId,
        mediaItemId,
        position: membership.position,
      })
      .onConflictDoNothing()
  }
}

export async function applyProviderResult(
  input: ApplyProviderResultInput,
): Promise<void> {
  await db.transaction((database) =>
    applyProviderResultInTransaction(input, database),
  )
}

async function spotifyOwnsAlbumTracklist(
  database: ProviderDatabase,
  mediaItemId: string,
  knownRejections: readonly RejectedAlbumIdentity[] | undefined,
) {
  // A later partial result can replace current state, so consult the history.
  const evidence = await database.query.providerSnapshot.findFirst({
    columns: { source: true },
    where: (table, operators) =>
      operators.and(
        operators.eq(table.mediaItemId, mediaItemId),
        operators.eq(table.provider, 'spotify'),
        operators.or(
          operators.eq(table.source, 'legacy-import'),
          sql`jsonb_typeof(${table.normalizedData}->'tracks') = 'array'
            and jsonb_typeof(${table.normalizedData}->'tracks'->0) = 'object'`,
        ),
      ),
    orderBy: (table) => [sql`(${table.source} = 'legacy-import')`],
  })
  if (!evidence) return false
  if (evidence.source !== 'legacy-import') return true

  const identity = await readActiveSpotifyAlbumIdentity(
    database,
    mediaItemId,
    knownRejections,
  )
  if (!identity || identity.ids.size !== 1) return false
  const [id] = identity.ids
  if (!id || identity.isRejectedId(id)) return false

  // Legacy normalized lists can be empty or a partial page. Inspect raw
  // receipts for the active edition without returning the market lists.
  const release = sql<unknown>`coalesce(${providerSnapshot.payload}->'spotify', ${providerSnapshot.payload})`
  const items = sql`(${release}) #> '{tracks,items}'`
  const legacyReceipts = await database
    .select({
      release: sql<unknown>`jsonb_set((${release}) - 'available_markets', '{tracks,items}', (
        select jsonb_agg(
          case when jsonb_typeof(item) = 'object' then item - 'available_markets' else item end
          order by position
        )
        from jsonb_array_elements(${items}) with ordinality as tracks(item, position)
      ))`,
    })
    .from(providerSnapshot)
    .where(
      and(
        eq(providerSnapshot.mediaItemId, mediaItemId),
        eq(providerSnapshot.provider, 'spotify'),
        eq(providerSnapshot.source, 'legacy-import'),
        sql`(${release})->>'id' = ${id}`,
        sql`jsonb_typeof(${items}) = 'array'`,
      ),
    )
  return legacyReceipts.some(
    ({ release }) => !!legacySpotifyAlbumTracklist(release),
  )
}

async function readActiveSpotifyAlbumIdentity(
  database: ProviderDatabase,
  mediaItemId: string,
  knownRejections?: readonly RejectedAlbumIdentity[],
) {
  const item = await database.query.mediaItem.findFirst({
    columns: {},
    where: (table, operators) => operators.eq(table.id, mediaItemId),
    with: {
      album: { columns: { spotifyUrl: true } },
      providerReferences: {
        columns: { externalId: true },
        where: (table, { and, or, eq }) =>
          or(
            eq(table.referenceType, 'spotify'),
            and(
              eq(table.provider, 'spotify'),
              eq(table.referenceType, 'album'),
            ),
          ),
      },
      referenceOverrides: {
        columns: { provider: true, referenceType: true, externalId: true },
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.provider, 'spotify'),
            inArray(table.referenceType, ['album', 'spotify']),
          ),
        orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
      },
    },
  })
  if (!item) return
  const rejections =
    knownRejections ?? (await readAlbumMatchRejections(database, mediaItemId))
  const isRejected = createAlbumMatchRejectionPredicate('spotify', rejections)
  const activeOverrides = effectiveReferenceOverrides(
    item.referenceOverrides,
    isRejected,
  )
  const active = activeOverrides.latestCount
    ? activeOverrides.active.map(({ externalId }) => externalId)
    : [
        item.album?.spotifyUrl ?? '',
        ...item.providerReferences.map(({ externalId }) => externalId),
      ]
  const ids = new Set(
    active.flatMap((reference) => {
      const id = spotifyAlbumId(reference)
      return id ? [id] : []
    }),
  )
  return {
    ids,
    selected: activeOverrides.latestCount > 0,
    isRejectedId: (id: string) =>
      isRejected({ referenceType: 'album', externalId: id }) ||
      isRejected({
        referenceType: 'url',
        externalId: `https://open.spotify.com/album/${id}`,
      }),
  }
}

function legacySpotifyReceiptId(payload: JsonValue) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  const release = payload.spotify ?? payload
  if (release && typeof release === 'object' && !Array.isArray(release))
    return SpotifyIdSchema.safeParse(release.id).data
}

async function legacyAlbumProjection(
  database: ProviderDatabase,
  input: ApplyProviderResultInput,
) {
  if (input.mediaType !== 'album' || !input.source.startsWith('legacy'))
    return 'apply'
  const spotifyLegacy = input.provider === 'spotify'
  if (!spotifyLegacy && !input.legacySpotifyAlbumId) return 'apply'
  const releaseId = spotifyLegacy
    ? legacySpotifyReceiptId(input.payload)
    : input.legacySpotifyAlbumId
  if (!releaseId) return 'history'
  // The raw receipt and the saved edition must agree before projecting either.
  if (input.legacySpotifyAlbumId && input.legacySpotifyAlbumId !== releaseId)
    return 'history'
  const identity = await readActiveSpotifyAlbumIdentity(
    database,
    input.mediaItemId,
  )
  if (
    !identity ||
    identity.isRejectedId(releaseId) ||
    ((identity.selected || identity.ids.size > 0) &&
      (identity.ids.size !== 1 || !identity.ids.has(releaseId)))
  )
    return 'history'
  const modern = await database.query.providerSnapshot.findFirst({
    columns: { id: true },
    where: (table, { and, eq, isNotNull, notLike }) =>
      and(
        eq(table.mediaItemId, input.mediaItemId),
        eq(table.provider, 'spotify'),
        notLike(table.source, 'legacy%'),
        isNotNull(table.normalizedData),
      ),
  })
  if (!modern) return 'apply'
  return spotifyLegacy ? 'playlists' : 'enrich'
}

export async function applyProviderResultInTransaction(
  input: ApplyProviderResultInput,
  database: ProviderDatabase,
): Promise<void> {
  if (input.mediaType === 'album') {
    input = {
      ...input,
      ...sanitizeAlbumProviderResult(input.payload, input.normalized),
    }
  }
  const filmReferences =
    input.mediaType === 'film' && input.normalized.references.length > 0
  if (filmReferences) await lockFilmReferenceWrites(database)
  if (input.normalized.tags.length > 0) await lockTagWrites(database)
  if (input.mediaType === 'album' && input.normalized.tracks.length > 0)
    await lockLibraryTrackWrites(database)
  await database.execute(
    sql`select id from media_item where id = ${input.mediaItemId} for update`,
  )
  const projection = await legacyAlbumProjection(database, input)
  // An album match can be rejected after its evidence was collected.
  const rejections =
    input.mediaType === 'album' &&
    (input.source === 'scrape-job' ||
      input.source === 'archived-replay' ||
      input.source === 'album-open')
      ? await readAlbumMatchRejections(database, input.mediaItemId)
      : undefined
  const isRejectedMatch = rejections
    ? createAlbumMatchRejectionPredicate(input.provider, rejections)
    : undefined
  const normalizedSpotifyUrl = input.normalized.albumPatch?.spotifyUrl
  const discogs =
    input.provider === 'discogs' && isRejectedMatch
      ? discogsMasterReleaseMatch(input.payload, input.normalized.references)
      : undefined
  if (
    discogs &&
    isRejectedMatch?.({
      referenceType: 'release',
      externalId: discogs.releaseId,
    })
  )
    throw new ProviderItemAmbiguousError(
      'This Discogs master uses a main release already rejected for this album. Select a different edition.',
    )
  if (
    input.normalized.references.some((reference) =>
      isRejectedMatch?.(reference),
    ) ||
    input.normalized.links.some(({ url }) =>
      isRejectedMatch?.({ referenceType: 'url', externalId: url }),
    ) ||
    (normalizedSpotifyUrl &&
      isRejectedMatch?.({
        referenceType: 'album',
        externalId: normalizedSpotifyUrl,
      }))
  )
    throw new ProviderItemNotFoundError(
      'The album match was previously rejected.',
    )
  const checksum = checksumJson({
    provider: input.provider,
    payload: input.payload,
    normalized: input.normalized,
  })
  const normalizedMetadata = JsonValueSchema.parse(
    JSON.parse(JSON.stringify(input.normalized)),
  )
  if (
    !normalizedMetadata ||
    typeof normalizedMetadata !== 'object' ||
    Array.isArray(normalizedMetadata)
  )
    throw new Error('Invalid normalized provider result')

  const currentState = await database.query.providerCurrentState.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.mediaItemId, input.mediaItemId),
        operators.eq(table.provider, input.provider),
      ),
  })

  let latestSnapshotId = currentState?.latestSnapshotId ?? null

  const localImport =
    input.source.startsWith('legacy') || input.source === 'file-import'
  const previousImport = localImport
    ? await database.query.providerSnapshot.findFirst({
        where: (table, operators) =>
          operators.and(
            operators.eq(table.mediaItemId, input.mediaItemId),
            operators.eq(table.provider, input.provider),
            operators.eq(table.checksum, checksum),
            operators.eq(table.source, input.source),
          ),
      })
    : undefined

  const spotifyFileImport =
    input.mediaType === 'album' &&
    input.provider === 'spotify' &&
    input.source === 'file-import' &&
    currentState?.latestSnapshotId !== previousImport?.id
  if (
    !localImport ||
    !currentState ||
    currentState.checksum !== checksum ||
    spotifyFileImport ||
    (projection !== 'apply' && !previousImport)
  ) {
    const snapshotId = previousImport?.id ?? nanoid()

    if (!previousImport)
      await database.insert(providerSnapshot).values({
        id: snapshotId,
        mediaItemId: input.mediaItemId,
        provider: input.provider,
        checksum,
        payload: input.payload,
        normalizedData: normalizedMetadata,
        source: input.source,
        scrapeJobId: input.scrapeJobId ?? null,
      })

    latestSnapshotId = snapshotId
  }
  if (projection === 'playlists')
    await upsertPlaylistMemberships(
      database,
      input.mediaItemId,
      input.normalized.playlists,
    )
  if (projection === 'history' || projection === 'playlists') return

  const preserveSpotify = projection === 'enrich'
  if (
    !preserveSpotify &&
    input.mediaType === 'album' &&
    input.provider === 'legacy-browser' &&
    input.source === 'legacy-clean-import'
  ) {
    await database
      .delete(mediaItemTag)
      .where(eq(mediaItemTag.mediaItemId, input.mediaItemId))
    await database
      .delete(playlistItem)
      .where(eq(playlistItem.mediaItemId, input.mediaItemId))
  }
  if (
    input.mediaType === 'album' &&
    latestSnapshotId &&
    (input.source === 'file-import' || input.source === 'manual-add')
  )
    await observeCatalogOccurrence(
      database,
      { kind: 'album', id: input.mediaItemId },
      {
        provider: input.provider,
        operation: 'import',
        occurrenceKey: latestSnapshotId,
        snapshotId: latestSnapshotId,
        jobId: input.scrapeJobId ?? undefined,
      },
    )

  let mediaPatch = input.normalized.mediaPatch
  let filmPatch = input.normalized.filmPatch
  if (input.source === 'file-import') {
    const existing = await database.query.mediaItem.findFirst({
      where: (table, operators) => operators.eq(table.id, input.mediaItemId),
    })
    const existingFilm = await database.query.film.findFirst({
      where: (table, operators) =>
        operators.eq(table.mediaItemId, input.mediaItemId),
    })
    const resolved = resolveFileImportPatches(
      input.normalized,
      existing,
      existingFilm,
    )
    mediaPatch = resolved.mediaPatch
    filmPatch = resolved.filmPatch
  }
  const overrideRows = await database
    .select({ field: mediaOverride.field })
    .from(mediaOverride)
    .where(eq(mediaOverride.mediaItemId, input.mediaItemId))
  const overridden = new Set(overrideRows.map((row) => row.field))
  function mergeMetadata(
    column:
      | typeof mediaItem.metadata
      | typeof album.metadata
      | typeof film.metadata,
    patch: Record<string, JsonValue> | undefined,
  ) {
    if (!patch) return undefined
    const current = sql`coalesce(${column}, '{}'::jsonb)`
    const incoming = sql`${JSON.stringify(patch)}::jsonb`
    const [base, preferred] = preserveSpotify
      ? [incoming, current]
      : [current, incoming]
    const albumBrowse =
      preserveSpotify && column === mediaItem.metadata
        ? sql`|| coalesce((select ${album.metadata}->'browse' from ${album}
            where ${album.mediaItemId} = ${input.mediaItemId}), '{}'::jsonb)`
        : sql``
    return sql`${base} || ${preferred} || jsonb_build_object('browse',
      coalesce((${base})->'browse', '{}'::jsonb) ||
      coalesce((${preferred})->'browse', '{}'::jsonb) ${albumBrowse})`
  }
  if (mediaPatch) {
    const nextTitle = preserveSpotify ? undefined : mediaPatch.title
    await database
      .update(mediaItem)
      .set({
        title: overridden.has('title') ? undefined : (nextTitle ?? undefined),
        originalTitle: overridden.has('originalTitle')
          ? undefined
          : (mediaPatch.originalTitle ?? undefined),
        summary: overridden.has('summary')
          ? undefined
          : (mediaPatch.summary ?? undefined),
        artworkUrl:
          preserveSpotify || overridden.has('artworkUrl')
            ? undefined
            : (mediaPatch.artworkUrl ?? undefined),
        releaseDate:
          preserveSpotify || overridden.has('releaseDate')
            ? undefined
            : (parseOptionalDate(mediaPatch.releaseDate) ?? undefined),
        sourceLabel: overridden.has('sourceLabel')
          ? undefined
          : (mediaPatch.sourceLabel ?? undefined),
        metadata: mergeMetadata(mediaItem.metadata, mediaPatch.metadata),
        slug:
          nextTitle && !overridden.has('title')
            ? slugifyParts(nextTitle, input.mediaItemId)
            : undefined,
        updatedAt: new Date(),
      })
      .where(eq(mediaItem.id, input.mediaItemId))
  }

  if (input.mediaType === 'album' && input.normalized.albumPatch) {
    let spotifyUrl = preserveSpotify
      ? undefined
      : (normalizedSpotifyUrl ?? undefined)
    if (spotifyUrl && overridden.has('spotifyUrl')) {
      const existing = isRejectedMatch
        ? await database.query.album.findFirst({
            columns: { spotifyUrl: true },
            where: (table, operators) =>
              operators.eq(table.mediaItemId, input.mediaItemId),
          })
        : undefined
      if (
        !existing?.spotifyUrl ||
        !isRejectedMatch?.({
          referenceType: 'album',
          externalId: existing.spotifyUrl,
        })
      )
        spotifyUrl = undefined
    }
    await database
      .update(album)
      .set({
        dateAdded: overridden.has('dateAdded')
          ? undefined
          : (parseOptionalDate(input.normalized.albumPatch.dateAdded) ??
            undefined),
        durationSec:
          preserveSpotify || overridden.has('durationSec')
            ? undefined
            : (input.normalized.albumPatch.durationSec ?? undefined),
        spotifyUrl,
        metadata: mergeMetadata(
          album.metadata,
          input.normalized.albumPatch.metadata,
        ),
        updatedAt: new Date(),
      })
      .where(eq(album.mediaItemId, input.mediaItemId))
  }

  if (input.mediaType === 'film' && filmPatch) {
    const added = localImport
      ? filmAddedDate(
          filmPatch.dateAdded,
          filmPatch.dateAddedSource ?? 'Imported source date (estimated)',
        )
      : undefined
    if (added) await recordFilmAddedDate(database, input.mediaItemId, added)
    await database
      .update(film)
      .set({
        runtimeMinutes: overridden.has('runtimeMinutes')
          ? undefined
          : (filmPatch.runtimeMinutes ?? undefined),
        watched: overridden.has('watched')
          ? undefined
          : (filmPatch.watched ?? undefined),
        sourceKind: overridden.has('sourceKind')
          ? undefined
          : (filmPatch.sourceKind ?? undefined),
        budget: overridden.has('budget')
          ? undefined
          : (filmPatch.budget ?? undefined),
        boxOffice: overridden.has('boxOffice')
          ? undefined
          : (filmPatch.boxOffice ?? undefined),
        metadata: mergeMetadata(film.metadata, filmPatch.metadata),
        updatedAt: new Date(),
      })
      .where(eq(film.mediaItemId, input.mediaItemId))
  }

  if (filmReferences && input.provider === 'mdblist') {
    if (!latestSnapshotId) throw new Error('Missing MDBList result snapshot.')
    await saveMdblistFilmReferences(
      database,
      input.mediaItemId,
      input.normalized.references,
      latestSnapshotId,
    )
  } else if (input.normalized.references.length > 0) {
    await replaceProviderReferences(
      database,
      input.mediaItemId,
      input.provider,
      input.normalized.references,
      isRejectedMatch,
      filmReferences && input.source === 'scrape-job',
    )
  }

  const links = preserveSpotify
    ? input.normalized.links.filter(({ provider }) => provider !== 'spotify')
    : input.normalized.links
  if (links.length > 0) {
    await replaceExternalLinks(
      database,
      input.mediaItemId,
      input.provider,
      links,
    )
  }

  if (input.normalized.tags.length > 0) {
    await upsertProviderTags(
      database,
      input.mediaItemId,
      input.provider,
      input.mediaType,
      input.normalized.tags,
    )
  }

  if (!preserveSpotify && input.normalized.credits.length > 0) {
    await replaceCredits(database, input.mediaItemId, input.normalized.credits)
  }

  if (input.mediaType === 'album' && input.normalized.tracks.length > 0) {
    const spotifyTrackList =
      input.provider !== 'spotify' &&
      (await spotifyOwnsAlbumTracklist(database, input.mediaItemId, rejections))
    if (!spotifyTrackList)
      await replaceAlbumTracks(
        database,
        input.mediaItemId,
        input.normalized.tracks,
        {
          provider: input.provider,
          jobId: input.scrapeJobId ?? undefined,
          snapshotId: latestSnapshotId ?? undefined,
        },
      )
    if (
      input.normalized.tracks.some(
        (entry) => entry.references?.length || entry.isrc,
      )
    )
      await recordAlbumTrackProviderReferences(database, {
        albumId: input.mediaItemId,
        provider: input.provider,
        tracks: input.normalized.tracks,
        jobId: input.scrapeJobId ?? null,
      })
  }

  if (input.normalized.playlists.length > 0) {
    await upsertPlaylistMemberships(
      database,
      input.mediaItemId,
      input.normalized.playlists,
    )
  }

  if (input.mediaType === 'film' && latestSnapshotId)
    await observeFilmRelations(
      database,
      input.mediaItemId,
      input.payload,
      input.normalized,
      {
        provider: input.provider,
        operation: 'film-details',
        occurrenceKey: latestSnapshotId,
        snapshotId: latestSnapshotId,
        jobId: input.scrapeJobId ?? undefined,
      },
    )

  if (currentState) {
    await database
      .update(providerCurrentState)
      .set({
        latestSnapshotId,
        checksum,
        payload: input.payload,
        normalizedData: normalizedMetadata,
        status: 'ready',
        lastSuccessfulAt: new Date(),
        ...(input.source === 'scrape-job' ? { lastScrapedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(providerCurrentState.id, currentState.id))
  } else {
    await database.insert(providerCurrentState).values({
      id: nanoid(),
      mediaItemId: input.mediaItemId,
      provider: input.provider,
      latestSnapshotId,
      checksum,
      payload: input.payload,
      normalizedData: normalizedMetadata,
      status: 'ready',
      lastSuccessfulAt: new Date(),
      lastScrapedAt: input.source === 'scrape-job' ? new Date() : null,
    })
  }
}
