import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  JsonValueSchema,
  type PluginNormalizedResult,
  type JsonValue,
} from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import { filmAddedDate } from '@/lib/film-added-date'
import { resolveFileImportPatches } from '@/lib/file-import-patches'
import { sanitizeAlbumProviderResult } from '@/lib/spotify-audio-features'
import { recordFilmAddedDate } from './film-added-dates'
import { lockTagWrites, upsertProviderTags } from './tag-state'
import {
  checksumJson,
  createStableId,
  parseOptionalDate,
  slugifyParts,
} from '@/lib/media-utils'
import {
  album,
  artist,
  externalLink,
  film,
  mediaCredit,
  mediaItem,
  mediaOverride,
  playlist,
  playlistItem,
  providerCurrentState,
  providerReference,
  providerReferenceOverride,
  providerSnapshot,
  track,
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
  const effective = new Map(
    overrides.map((override) => [override.referenceType, override.externalId]),
  )
  const effectiveReferences: PluginNormalizedResult['references'] =
    references.map((reference) => ({
      ...reference,
      externalId:
        effective.get(reference.referenceType) ?? reference.externalId,
    }))
  for (const [referenceType, externalId] of effective) {
    if (
      !effectiveReferences.some(
        (reference) => reference.referenceType === referenceType,
      )
    )
      effectiveReferences.push({ referenceType, externalId, isPrimary: false })
  }
  await database
    .delete(providerReference)
    .where(
      and(
        eq(providerReference.mediaItemId, mediaItemId),
        eq(providerReference.provider, providerId),
      ),
    )

  for (const reference of new Map(
    effectiveReferences.map((reference) => [
      `${reference.referenceType}:${reference.externalId}`,
      reference,
    ]),
  ).values()) {
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

  for (const credit of normalizeCreditsForInsert(credits)) {
    await database
      .insert(artist)
      .values({
        id: credit.artistId,
        name: credit.name,
        sortName: credit.name,
      })
      .onConflictDoNothing()

    await database.insert(mediaCredit).values({
      mediaItemId,
      artistId: credit.artistId,
      role: credit.role,
      billingOrder: credit.billingOrder,
    })
  }
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

async function replaceAlbumTracks(
  database: ProviderDatabase,
  mediaItemId: string,
  tracksToInsert: PluginNormalizedResult['tracks'],
): Promise<void> {
  if (tracksToInsert.length === 0) {
    return
  }

  await database.delete(track).where(eq(track.albumMediaItemId, mediaItemId))

  for (const trackItem of tracksToInsert) {
    await database.insert(track).values({
      id: createStableId(
        'track',
        `${mediaItemId}:${trackItem.position}:${trackItem.title}:${trackItem.externalId ?? ''}`,
      ),
      albumMediaItemId: mediaItemId,
      externalId: trackItem.externalId ?? null,
      title: trackItem.title,
      position: trackItem.position,
      durationSec: trackItem.durationSec ?? null,
      metadata: {},
    })
  }

  await database
    .update(album)
    .set({
      trackCount: tracksToInsert.length,
      updatedAt: new Date(),
    })
    .where(eq(album.mediaItemId, mediaItemId))
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
  if (input.normalized.tags.length > 0) await lockTagWrites(database)
  await database.execute(
    sql`select id from media_item where id = ${input.mediaItemId} for update`,
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

  if (!localImport || !currentState || currentState.checksum !== checksum) {
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
    return sql`coalesce(${column}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb || jsonb_build_object('browse', coalesce(${column}->'browse', '{}'::jsonb) || coalesce(${JSON.stringify(patch)}::jsonb->'browse', '{}'::jsonb))`
  }
  if (mediaPatch) {
    const nextTitle = mediaPatch.title
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
        artworkUrl: overridden.has('artworkUrl')
          ? undefined
          : (mediaPatch.artworkUrl ?? undefined),
        releaseDate: overridden.has('releaseDate')
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
    await database
      .update(album)
      .set({
        dateAdded: overridden.has('dateAdded')
          ? undefined
          : (parseOptionalDate(input.normalized.albumPatch.dateAdded) ??
            undefined),
        durationSec: overridden.has('durationSec')
          ? undefined
          : (input.normalized.albumPatch.durationSec ?? undefined),
        spotifyUrl: overridden.has('spotifyUrl')
          ? undefined
          : (input.normalized.albumPatch.spotifyUrl ?? undefined),
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

  if (input.normalized.references.length > 0) {
    await replaceProviderReferences(
      database,
      input.mediaItemId,
      input.provider,
      input.normalized.references,
    )
  }

  if (input.normalized.links.length > 0) {
    await replaceExternalLinks(
      database,
      input.mediaItemId,
      input.provider,
      input.normalized.links,
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

  if (input.normalized.credits.length > 0) {
    await replaceCredits(database, input.mediaItemId, input.normalized.credits)
  }

  if (input.mediaType === 'album' && input.normalized.tracks.length > 0) {
    await replaceAlbumTracks(
      database,
      input.mediaItemId,
      input.normalized.tracks,
    )
  }

  if (input.normalized.playlists.length > 0) {
    await upsertPlaylistMemberships(
      database,
      input.mediaItemId,
      input.normalized.playlists,
    )
  }

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
