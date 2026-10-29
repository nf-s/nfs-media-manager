import {
  listBrowseFacets,
  queryBrowseIds,
  type BrowseQueryOptions,
} from './browse'
import { getCollectionSourceLinks } from './source-navigation'
import { withStoredTrailerLinks } from './stored-trailers'
import { getAlbumProviderDetails } from './album-provider-details'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { JsonValue } from '@repo/media-plugin-sdk'
import {
  type AlbumDetail,
  type AlbumListItem,
  type AlbumPatchInput,
  type AlbumQuery,
  type FilmDetail,
  type FilmListItem,
  type FilmPatchInput,
  type FilmQuery,
} from '@repo/schemas/media'
import { nanoid } from 'nanoid'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  createStableId,
  parseOptionalDate,
  slugifyParts,
  toIsoString,
} from '@/lib/media-utils'
import {
  album,
  film,
  mediaItem,
  mediaOverride,
  providerReference,
  providerReferenceOverride,
} from '@/schemas/db'

type CommonCredit = {
  artist: { name: string }
  role: string
  billingOrder: number
}

type CommonTag = {
  tag: { name: string; kind: string; hidden: boolean }
}

type CommonLink = {
  provider: string
  label: string
  url: string
}

type CommonReference = {
  provider: string
  referenceType: string
  externalId: string
  isPrimary: boolean
  metadata: Record<string, JsonValue> | null
}

type CommonPlaylistItem = {
  position: number
  playlist: { name: string; kind: 'playlist' | 'collection' }
}

type CommonRecord<TMediaType extends 'album' | 'film'> = {
  id: string
  mediaType: TMediaType
  slug: string
  title: string
  originalTitle: string | null
  summary: string | null
  artworkUrl: string | null
  releaseDate: Date | null
  sourceLabel: string | null
  metadata: Record<string, JsonValue> | null
  createdAt: Date
  updatedAt: Date
  credits: CommonCredit[]
  tags: CommonTag[]
  links: CommonLink[]
  providerReferences: CommonReference[]
  playlistItems: CommonPlaylistItem[]
}

type CommonPayload<TMediaType extends 'album' | 'film'> = {
  id: string
  mediaType: TMediaType
  slug: string
  title: string
  originalTitle: string | null
  summary: string | null
  artworkUrl: string | null
  releaseDate: string | null
  sourceLabel: string | null
  metadata: Record<string, JsonValue> | null
  tags: AlbumListItem['tags']
  credits: AlbumListItem['credits']
  links: AlbumListItem['links']
  providerReferences: AlbumListItem['providerReferences']
  playlists: AlbumListItem['playlists']
  createdAt: string
  updatedAt: string
}

function mapCredits(credits: CommonCredit[]): AlbumListItem['credits'] {
  return credits
    .map((credit) => ({
      name: credit.artist.name,
      role: credit.role,
      billingOrder: credit.billingOrder,
    }))
    .sort(
      (left, right) =>
        left.billingOrder - right.billingOrder ||
        left.name.localeCompare(right.name),
    )
}

function mapTags(items: CommonTag[]): AlbumListItem['tags'] {
  return items
    .filter((item) => !item.tag.hidden)
    .map((item) => ({ name: item.tag.name, kind: item.tag.kind }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function mapLinks(items: CommonLink[]): AlbumListItem['links'] {
  return items
    .map((item) => ({
      provider: item.provider,
      label: item.label,
      url: item.url,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

function mapReferences(
  items: CommonReference[],
): AlbumListItem['providerReferences'] {
  return items
    .map((item) => ({
      provider: item.provider,
      referenceType: item.referenceType,
      externalId: item.externalId,
      isPrimary: item.isPrimary,
      metadata: item.metadata ?? null,
    }))
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.referenceType.localeCompare(right.referenceType),
    )
}

function mapPlaylists(items: CommonPlaylistItem[]): AlbumListItem['playlists'] {
  return items
    .map((item) => ({
      name: item.playlist.name,
      kind: item.playlist.kind,
      position: item.position,
    }))
    .sort(
      (left, right) =>
        left.position - right.position || left.name.localeCompare(right.name),
    )
}

function buildCommonPayload<TMediaType extends 'album' | 'film'>(
  record: CommonRecord<TMediaType>,
): CommonPayload<TMediaType> {
  return {
    id: record.id,
    mediaType: record.mediaType,
    slug: record.slug,
    title: record.title,
    originalTitle: record.originalTitle,
    summary: record.summary,
    artworkUrl: record.artworkUrl,
    releaseDate: toIsoString(record.releaseDate),
    sourceLabel: record.sourceLabel,
    metadata: record.metadata ?? null,
    tags: mapTags(record.tags),
    credits: mapCredits(record.credits),
    links: mapLinks(record.links),
    providerReferences: mapReferences(record.providerReferences),
    playlists: mapPlaylists(record.playlistItems),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function reorderRecords<TRecord extends { id: string }>(
  records: TRecord[],
  ids: string[],
): TRecord[] {
  const order = new Map(ids.map((id, index) => [id, index]))

  return [...records].sort((left, right) => {
    const leftIndex = order.get(left.id) ?? 0
    const rightIndex = order.get(right.id) ?? 0
    return leftIndex - rightIndex
  })
}

export const listAlbumFilterOptions = () => listBrowseFacets('album')
export const listFilmFilterOptions = () => listBrowseFacets('film')

export async function listAlbums(
  query: AlbumQuery,
  options: BrowseQueryOptions = {},
): Promise<{ items: AlbumListItem[]; totalCount: number; pageCount: number }> {
  const { ids, totalCount, pageCount } = await queryBrowseIds(
    'album',
    query,
    options,
  )
  if (!ids.length) return { items: [], totalCount, pageCount }

  const records = await db.query.mediaItem.findMany({
    where: (table, operators) => operators.inArray(table.id, ids),
    with: {
      album: true,
      credits: {
        with: {
          artist: true,
        },
      },
      tags: {
        with: {
          tag: true,
        },
      },
      links: true,
      providerReferences: true,
      playlistItems: {
        with: {
          playlist: true,
        },
      },
    },
  })

  const items = reorderRecords(records, ids).flatMap((record) => {
    if (!record.album) {
      return []
    }

    const item: AlbumListItem = {
      ...buildCommonPayload({
        ...record,
        mediaType: 'album',
        metadata: { ...record.album.metadata, ...record.metadata },
      }),
      mediaType: 'album',
      dateAdded: toIsoString(record.album.dateAdded),
      durationSec: record.album.durationSec ?? null,
      spotifyUrl: record.album.spotifyUrl ?? null,
      trackCount: record.album.trackCount,
    }

    return [item]
  })

  return { items, totalCount, pageCount }
}

export async function listFilms(
  query: FilmQuery,
  options: BrowseQueryOptions = {},
): Promise<{ items: FilmListItem[]; totalCount: number; pageCount: number }> {
  const { ids, totalCount, pageCount } = await queryBrowseIds(
    'film',
    query,
    options,
  )
  if (!ids.length) return { items: [], totalCount, pageCount }

  const records = await db.query.mediaItem.findMany({
    where: (table, operators) => operators.inArray(table.id, ids),
    with: {
      film: true,
      credits: {
        with: {
          artist: true,
        },
      },
      tags: {
        with: {
          tag: true,
        },
      },
      links: true,
      providerReferences: true,
      playlistItems: {
        with: {
          playlist: true,
        },
      },
    },
  })

  const items = reorderRecords(records, ids).flatMap((record) => {
    if (!record.film) {
      return []
    }

    const item: FilmListItem = {
      ...buildCommonPayload({
        ...record,
        mediaType: 'film',
        metadata: { ...record.film.metadata, ...record.metadata },
      }),
      mediaType: 'film',
      dateAdded: (record.film.dateAdded ?? record.createdAt).toISOString(),
      dateAddedSource:
        record.film.dateAddedSource ?? 'Library import (original date unknown)',
      runtimeMinutes: record.film.runtimeMinutes ?? null,
      watched: record.film.watched,
      sourceKind: record.film.sourceKind ?? null,
      budget: record.film.budget ?? null,
      boxOffice: record.film.boxOffice ?? null,
    }

    return [item]
  })

  return { items, totalCount, pageCount }
}

export async function getAlbumDetail(id: string): Promise<AlbumDetail | null> {
  const record = await db.query.mediaItem.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, id),
        operators.eq(table.mediaType, 'album'),
      ),
    with: {
      album: {
        with: {
          tracks: true,
        },
      },
      credits: {
        with: {
          artist: true,
        },
      },
      tags: {
        with: {
          tag: true,
        },
      },
      links: true,
      providerReferences: true,
      playlistItems: {
        with: {
          playlist: true,
        },
      },
    },
  })

  if (!record?.album) {
    return null
  }

  const albumDetail: AlbumDetail = {
    providerDetails: await getAlbumProviderDetails(id),
    collectionSources: await getCollectionSourceLinks(id, {
      ...record.album.metadata,
      ...record.metadata,
    }),
    ...buildCommonPayload({
      ...record,
      mediaType: 'album',
      metadata: { ...record.album.metadata, ...record.metadata },
    }),
    mediaType: 'album',
    dateAdded: toIsoString(record.album.dateAdded),
    durationSec: record.album.durationSec ?? null,
    spotifyUrl: record.album.spotifyUrl ?? null,
    trackCount: record.album.trackCount,
    tracks: record.album.tracks
      .map((item) => ({
        externalId: item.externalId ?? null,
        title: item.title,
        position: item.position,
        durationSec: item.durationSec ?? null,
      }))
      .sort((left, right) => left.position - right.position),
  }

  return albumDetail
}

export async function getFilmDetail(id: string): Promise<FilmDetail | null> {
  const record = await db.query.mediaItem.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, id),
        operators.eq(table.mediaType, 'film'),
      ),
    with: {
      film: true,
      credits: {
        with: {
          artist: true,
        },
      },
      tags: {
        with: {
          tag: true,
        },
      },
      links: true,
      providerReferences: true,
      playlistItems: {
        with: {
          playlist: true,
        },
      },
    },
  })

  if (!record?.film) {
    return null
  }

  const filmDetail: FilmDetail = {
    collectionSources: await getCollectionSourceLinks(id, {
      ...record.film.metadata,
      ...record.metadata,
    }),
    ...buildCommonPayload({
      ...record,
      mediaType: 'film',
      metadata: { ...record.film.metadata, ...record.metadata },
    }),
    mediaType: 'film',
    dateAdded: (record.film.dateAdded ?? record.createdAt).toISOString(),
    dateAddedSource:
      record.film.dateAddedSource ?? 'Library import (original date unknown)',
    runtimeMinutes: record.film.runtimeMinutes ?? null,
    watched: record.film.watched,
    sourceKind: record.film.sourceKind ?? null,
    budget: record.film.budget ?? null,
    boxOffice: record.film.boxOffice ?? null,
  }

  return (await withStoredTrailerLinks([filmDetail]))[0] ?? filmDetail
}

function buildAlbumOverrideEntries(input: AlbumPatchInput) {
  const entries: Array<{
    field: string
    value: string | number | boolean | null
  }> = []

  if (typeof input.title !== 'undefined') {
    entries.push({ field: 'title', value: input.title })
  }
  if (typeof input.originalTitle !== 'undefined') {
    entries.push({ field: 'originalTitle', value: input.originalTitle })
  }
  if (typeof input.summary !== 'undefined') {
    entries.push({ field: 'summary', value: input.summary })
  }
  if (typeof input.artworkUrl !== 'undefined') {
    entries.push({ field: 'artworkUrl', value: input.artworkUrl })
  }
  if (typeof input.releaseDate !== 'undefined') {
    entries.push({ field: 'releaseDate', value: input.releaseDate })
  }
  if (typeof input.sourceLabel !== 'undefined') {
    entries.push({ field: 'sourceLabel', value: input.sourceLabel })
  }
  if (typeof input.dateAdded !== 'undefined') {
    entries.push({ field: 'dateAdded', value: input.dateAdded })
  }
  if (typeof input.durationSec !== 'undefined') {
    entries.push({ field: 'durationSec', value: input.durationSec })
  }
  if (typeof input.spotifyUrl !== 'undefined') {
    entries.push({ field: 'spotifyUrl', value: input.spotifyUrl })
  }

  return entries
}

function buildFilmOverrideEntries(input: FilmPatchInput) {
  const entries: Array<{
    field: string
    value: string | number | boolean | null
  }> = []

  if (input.dateAdded !== undefined) {
    entries.push({ field: 'dateAdded', value: input.dateAdded })
  }

  if (typeof input.title !== 'undefined') {
    entries.push({ field: 'title', value: input.title })
  }
  if (typeof input.originalTitle !== 'undefined') {
    entries.push({ field: 'originalTitle', value: input.originalTitle })
  }
  if (typeof input.summary !== 'undefined') {
    entries.push({ field: 'summary', value: input.summary })
  }
  if (typeof input.artworkUrl !== 'undefined') {
    entries.push({ field: 'artworkUrl', value: input.artworkUrl })
  }
  if (typeof input.releaseDate !== 'undefined') {
    entries.push({ field: 'releaseDate', value: input.releaseDate })
  }
  if (typeof input.sourceLabel !== 'undefined') {
    entries.push({ field: 'sourceLabel', value: input.sourceLabel })
  }
  if (typeof input.runtimeMinutes !== 'undefined') {
    entries.push({ field: 'runtimeMinutes', value: input.runtimeMinutes })
  }
  if (typeof input.watched !== 'undefined') {
    entries.push({ field: 'watched', value: input.watched })
  }
  if (typeof input.sourceKind !== 'undefined') {
    entries.push({ field: 'sourceKind', value: input.sourceKind })
  }
  if (typeof input.budget !== 'undefined') {
    entries.push({ field: 'budget', value: input.budget })
  }
  if (typeof input.boxOffice !== 'undefined') {
    entries.push({ field: 'boxOffice', value: input.boxOffice })
  }

  return entries
}

export async function patchAlbum(
  id: string,
  input: AlbumPatchInput,
  userId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(mediaItem)
      .set({
        title: input.title ?? undefined,
        originalTitle: input.originalTitle ?? undefined,
        summary: input.summary ?? undefined,
        artworkUrl: input.artworkUrl ?? undefined,
        releaseDate: parseOptionalDate(input.releaseDate) ?? undefined,
        sourceLabel: input.sourceLabel ?? undefined,
        slug: input.title ? slugifyParts(input.title, id) : undefined,
        updatedAt: new Date(),
      })
      .where(eq(mediaItem.id, id))

    await tx
      .update(album)
      .set({
        dateAdded: parseOptionalDate(input.dateAdded) ?? undefined,
        durationSec: input.durationSec ?? undefined,
        spotifyUrl: input.spotifyUrl ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(album.mediaItemId, id))

    for (const overrideEntry of buildAlbumOverrideEntries(input)) {
      await tx.insert(mediaOverride).values({
        id: nanoid(),
        mediaItemId: id,
        field: overrideEntry.field,
        value: overrideEntry.value,
        note: input.note ?? null,
        createdByUserId: userId,
      })
    }

    for (const override of input.referenceOverrides ?? []) {
      await tx
        .delete(providerReference)
        .where(
          and(
            eq(providerReference.mediaItemId, id),
            eq(providerReference.provider, override.provider),
            eq(providerReference.referenceType, override.referenceType),
          ),
        )

      await tx.insert(providerReference).values({
        id: createStableId(
          'pref',
          `${id}:${override.provider}:${override.referenceType}:${override.externalId}`,
        ),
        mediaItemId: id,
        provider: override.provider,
        referenceType: override.referenceType,
        externalId: override.externalId,
        isPrimary: true,
        metadata: {},
      })

      await tx.insert(providerReferenceOverride).values({
        id: nanoid(),
        mediaItemId: id,
        provider: override.provider,
        referenceType: override.referenceType,
        externalId: override.externalId,
        note: input.note ?? null,
        createdByUserId: userId,
      })
    }
  })
}

export async function patchFilm(
  id: string,
  input: FilmPatchInput,
  userId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(mediaItem)
      .set({
        title: input.title ?? undefined,
        originalTitle: input.originalTitle ?? undefined,
        summary: input.summary ?? undefined,
        artworkUrl: input.artworkUrl ?? undefined,
        releaseDate: parseOptionalDate(input.releaseDate) ?? undefined,
        sourceLabel: input.sourceLabel ?? undefined,
        slug: input.title ? slugifyParts(input.title, id) : undefined,
        updatedAt: new Date(),
      })
      .where(eq(mediaItem.id, id))

    await tx
      .update(film)
      .set({
        dateAdded:
          input.dateAdded === undefined
            ? undefined
            : parseOptionalDate(input.dateAdded),
        dateAddedSource:
          input.dateAdded === undefined
            ? undefined
            : input.dateAdded === null
              ? null
              : 'Manual',
        runtimeMinutes: input.runtimeMinutes ?? undefined,
        watched: input.watched ?? undefined,
        sourceKind: input.sourceKind ?? undefined,
        budget: input.budget ?? undefined,
        boxOffice: input.boxOffice ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(film.mediaItemId, id))

    for (const overrideEntry of buildFilmOverrideEntries(input)) {
      await tx.insert(mediaOverride).values({
        id: nanoid(),
        mediaItemId: id,
        field: overrideEntry.field,
        value:
          overrideEntry.value === null
            ? sql`'null'::jsonb`
            : overrideEntry.value,
        note: input.note ?? null,
        createdByUserId: userId,
      })
    }

    for (const override of input.referenceOverrides ?? []) {
      const shared =
        ['imdb', 'tmdb'].includes(override.referenceType) &&
        override.provider === override.referenceType
      if (shared) {
        const [conflict] = await tx
          .select({ title: mediaItem.title })
          .from(providerReference)
          .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
          .where(
            and(
              ne(mediaItem.id, id),
              eq(mediaItem.mediaType, 'film'),
              eq(providerReference.referenceType, override.referenceType),
              eq(providerReference.externalId, override.externalId),
              sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
            ),
          )
          .limit(1)
        if (conflict)
          throw new ServerError({
            statusCode: 409,
            message: `This ID already belongs to ${conflict.title}. Resolve the duplicate before assigning it.`,
          })
      }
      await tx
        .delete(providerReference)
        .where(
          and(
            eq(providerReference.mediaItemId, id),
            shared
              ? undefined
              : eq(providerReference.provider, override.provider),
            eq(providerReference.referenceType, override.referenceType),
          ),
        )

      await tx.insert(providerReference).values({
        id: createStableId(
          'pref',
          `${id}:${override.provider}:${override.referenceType}:${override.externalId}`,
        ),
        mediaItemId: id,
        provider: override.provider,
        referenceType: override.referenceType,
        externalId: override.externalId,
        isPrimary: true,
        metadata: {},
      })

      await tx.insert(providerReferenceOverride).values({
        id: nanoid(),
        mediaItemId: id,
        provider: override.provider,
        referenceType: override.referenceType,
        externalId: override.externalId,
        note: input.note ?? null,
        createdByUserId: userId,
      })
    }
  })
}
