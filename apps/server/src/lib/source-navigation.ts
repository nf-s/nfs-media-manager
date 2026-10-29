import { z } from 'zod'
import type { MediaPluginManifest } from '@repo/media-plugin-sdk'
import {
  SourceNavigationLinkSchema,
  type SourceNavigationLink,
} from '@repo/schemas/tags'

export function sourceLink(
  provider: string,
  providerLabel: string,
  name: string,
  url: string | undefined,
): SourceNavigationLink | null {
  const result = SourceNavigationLinkSchema.safeParse({
    provider,
    providerLabel,
    name,
    url,
  })
  return result.success ? result.data : null
}

export function expandSourceTemplate(
  template: string | undefined,
  values: { id?: string; name: string },
): string | undefined {
  if (!template || (template.includes('{id}') && !values.id)) return undefined
  const result = template
    .replaceAll('{id}', encodeURIComponent(values.id ?? ''))
    .replaceAll('{name}', encodeURIComponent(values.name))
  // Templates may substitute a path/query value, never a host or scheme.
  try {
    const base = new URL(template)
    const url = new URL(result)
    if (
      base.origin !== url.origin ||
      url.username ||
      url.password ||
      !['https:', 'http:'].includes(url.protocol) ||
      /[{}]/.test(result)
    )
      return undefined
    return url.href
  } catch {
    return undefined
  }
}

const CollectionSchema = z.object({
  id: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  name: z.string().min(1),
  url: z.string().optional(),
})
const DetailsSchema = z.object({ collections: z.array(z.unknown()) })

export function collectionSourceLinks(
  metadata: Record<string, unknown> | null,
  manifests: MediaPluginManifest[],
): SourceNavigationLink[] {
  const links = new Map<string, SourceNavigationLink>()
  for (const manifest of manifests) {
    const details = DetailsSchema.safeParse(
      metadata?.[`plugin.${manifest.id}.details`],
    )
    if (!details.success) continue
    for (const raw of details.data.collections) {
      const parsed = CollectionSchema.safeParse(raw)
      if (!parsed.success) continue
      const collection = parsed.data
      const link = sourceLink(
        manifest.id,
        manifest.displayName,
        collection.name,
        collection.url ??
          expandSourceTemplate(
            manifest.sourceNavigation?.collectionUrlTemplate,
            {
              id:
                collection.id === undefined ? undefined : String(collection.id),
              name: collection.name,
            },
          ),
      )
      if (link) links.set(JSON.stringify([link.name, link.url]), link)
    }
  }
  return [...links.values()]
}

export function tagSourceProvider(source: {
  source: string | null
  provider: string | null
  rawName: string
}): string | null {
  const prefix = /^(imdb|tmdb|trakt|mdblist)\.([^.]+)$/i.exec(
    source.rawName.trim(),
  )
  return source.source && source.source !== 'unknown'
    ? source.source
    : (prefix?.[1]?.toLowerCase() ?? source.provider)
}

export function sourceProviderLabel(
  provider: string | null,
  fallback: string | null,
): string {
  const labels: Record<string, string> = {
    imdb: 'IMDb',
    tmdb: 'TMDb',
    trakt: 'Trakt',
    mdblist: 'MDBList',
    lastfm: 'Last.fm',
    musicbrainz: 'MusicBrainz',
    discogs: 'Discogs',
    rym: 'Rate Your Music',
  }
  return (
    (provider ? labels[provider] : undefined) ??
    fallback ??
    provider ??
    'Unknown source'
  )
}

function normalizeSourceTagName(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

const MusicBrainzTagNameSchema = z
  .string()
  .transform(normalizeSourceTagName)
  .pipe(
    z
      .string()
      .min(1)
      .refine((name) => !/[\p{Cc}\p{Cs},]/u.test(name))
      // Dot segments would navigate away from the tag path after URL parsing.
      .refine((name) => name !== '.' && name !== '..'),
  )

export function tagSourceUrl(
  source: {
    source: string | null
    provider: string | null
    sourceId?: string | null
    rawName: string
    kind: string
  },
  manifest?: MediaPluginManifest,
  storedDiscogsPayloads: unknown[] = [],
): string | undefined {
  const upstream = tagSourceProvider(source)
  if (upstream === 'discogs')
    return storedDiscogsTagSourceUrl(source, storedDiscogsPayloads)
  if (
    upstream === 'musicbrainz' &&
    ['general', 'tag', 'genre'].includes(source.kind)
  ) {
    const name = MusicBrainzTagNameSchema.safeParse(source.rawName)
    return name.success
      ? `https://musicbrainz.org/tag/${encodeURIComponent(name.data)}`
      : undefined
  }
  if (
    upstream === 'tmdb' &&
    ['keyword', 'genre'].includes(source.kind) &&
    source.sourceId &&
    /^[1-9]\d*$/.test(source.sourceId)
  )
    return source.kind === 'genre'
      ? `https://www.themoviedb.org/genre/${encodeURIComponent(source.sourceId)}-${encodeURIComponent(source.rawName.trim().toLowerCase().replace(/\s+/g, '-'))}/movie`
      : `https://www.themoviedb.org/keyword/${encodeURIComponent(source.sourceId)}/movie`
  if (upstream === 'imdb' && source.kind === 'keyword') {
    const name = source.rawName
      .trim()
      .replace(/^imdb\./i, '')
      .replace(/\s+/g, '-')
    return `https://www.imdb.com/search/title/?keywords=${encodeURIComponent(name)}`
  }
  if (upstream === 'lastfm')
    return `https://www.last.fm/tag/${encodeURIComponent(source.rawName)}`
  // An aggregator's opaque ID must never be treated as an upstream tag ID.
  if (manifest && (!source.source || source.source === manifest.id))
    return expandSourceTemplate(manifest.sourceNavigation?.tagUrlTemplate, {
      id: source.sourceId ?? undefined,
      name: source.rawName,
    })
  return undefined
}

const StoredDiscogsTagsSchema = z.object({
  genres: z.unknown().optional(),
  styles: z.unknown().optional(),
})
const StoredDiscogsPayloadSchema = StoredDiscogsTagsSchema.extend({
  master: z.unknown().optional(),
  release: z.unknown().optional(),
  mainRelease: z.unknown().optional(),
  discogs: z.unknown().optional(),
})
const DiscogsTagNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim())
  .pipe(
    z
      .string()
      .min(1)
      .refine((name) => !/[\p{Cc}\p{Cs}]/u.test(name)),
  )

export function storedDiscogsTagSourceUrl(
  source: Parameters<typeof tagSourceUrl>[0],
  payloads: unknown[],
): string | undefined {
  if (
    tagSourceProvider(source) !== 'discogs' ||
    !['genre', 'style', 'general', 'tag'].includes(source.kind)
  )
    return undefined
  const name = DiscogsTagNameSchema.safeParse(source.rawName)
  if (!name.success) return undefined
  const matches = new Map<'genre' | 'style', string>()
  for (const payload of payloads) {
    const outer = StoredDiscogsPayloadSchema.safeParse(payload)
    if (!outer.success) continue
    const parsed = StoredDiscogsPayloadSchema.safeParse(
      outer.data.discogs ?? outer.data,
    )
    if (!parsed.success) continue
    for (const record of [
      parsed.data,
      parsed.data.master,
      parsed.data.release,
      parsed.data.mainRelease,
    ]) {
      const tags = StoredDiscogsTagsSchema.safeParse(record)
      if (!tags.success) continue
      for (const kind of ['genre', 'style'] satisfies Array<
        'genre' | 'style'
      >) {
        const entries = z
          .array(z.unknown())
          .safeParse(kind === 'genre' ? tags.data.genres : tags.data.styles)
        for (const entry of entries.success ? entries.data : []) {
          const tag = DiscogsTagNameSchema.safeParse(entry)
          if (
            tag.success &&
            normalizeSourceTagName(tag.data) ===
              normalizeSourceTagName(name.data)
          )
            matches.set(kind, tag.data)
        }
      }
    }
  }
  // Legacy import collapsed styles into genre; only explicit style is reliable alone.
  if (!matches.size && source.kind === 'style') matches.set('style', name.data)
  if (!matches.size) return undefined
  const url = new URL('https://www.discogs.com/search')
  for (const kind of ['genre', 'style'] satisfies Array<'genre' | 'style'>) {
    const match = matches.get(kind)
    if (match) url.searchParams.set(kind, match)
  }
  return url.href
}

const StoredTmdbTagsSchema = z.object({
  genres: z.unknown().optional(),
  keywords: z.unknown().optional(),
})
const StoredTmdbTagSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().min(1),
})

export function storedTmdbTagSourceUrl(
  source: Parameters<typeof tagSourceUrl>[0],
  payloads: unknown[],
): string | undefined {
  if (
    tagSourceProvider(source) !== 'tmdb' ||
    !['genre', 'keyword'].includes(source.kind)
  )
    return undefined
  const name =
    source.provider === 'mdblist'
      ? source.rawName.replace(/^tmdb\./i, '').replace(/-/g, ' ')
      : source.rawName
  const matches = new Map<number, string>()
  for (const payload of payloads) {
    const parsed = StoredTmdbTagsSchema.safeParse(payload)
    if (!parsed.success) continue
    const keywords = z
      .object({ keywords: z.array(z.unknown()) })
      .safeParse(parsed.data.keywords)
    const entries = z
      .array(z.unknown())
      .safeParse(
        source.kind === 'genre'
          ? parsed.data.genres
          : keywords.success
            ? keywords.data.keywords
            : undefined,
      )
    for (const entry of entries.success ? entries.data : []) {
      const tag = StoredTmdbTagSchema.safeParse(entry)
      if (
        tag.success &&
        normalizeSourceTagName(tag.data.name) === normalizeSourceTagName(name)
      )
        matches.set(tag.data.id, tag.data.name)
    }
  }
  // Conflicting historical IDs are not resolved by guessing which snapshot is right.
  if (matches.size !== 1) return undefined
  const match = matches.entries().next().value
  if (!match) return undefined
  return tagSourceUrl({
    ...source,
    source: 'tmdb',
    sourceId: String(match[0]),
    rawName: match[1],
  })
}

const StoredMovieIdsSchema = z.object({
  ids: z
    .object({
      imdb: z.unknown().optional(),
      tmdb: z.unknown().optional(),
      trakt: z.unknown().optional(),
    })
    .optional(),
  imdb_id: z.unknown().optional(),
  imdbid: z.unknown().optional(),
  tmdbid: z.unknown().optional(),
})

/** Resolve only stored film identities; aggregator tag IDs are never film/upstream IDs. */
export function storedItemSourceLink(
  source: { source: string | null; provider: string | null; rawName: string },
  links: { provider: string; url: string }[],
  references: { referenceType: string; externalId: string }[],
  payload: unknown,
  providerLabel: string | null,
  manifest?: MediaPluginManifest,
): { link: SourceNavigationLink; kind: 'item' | 'provider-item' } | undefined {
  const parsed = StoredMovieIdsSchema.safeParse(payload)
  const ids = parsed.success ? parsed.data : undefined
  const imdb = z
    .string()
    .regex(/^tt\d+$/)
    .safeParse(
      references.find((ref) => ref.referenceType === 'imdb')?.externalId ??
        ids?.ids?.imdb ??
        ids?.imdb_id ??
        ids?.imdbid,
    )
  const tmdb = z
    .union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive()])
    .safeParse(
      references.find((ref) => ref.referenceType === 'tmdb')?.externalId ??
        ids?.ids?.tmdb ??
        ids?.tmdbid,
    )
  const trakt = z.number().int().positive().safeParse(ids?.ids?.trakt)
  const generated: Record<string, string | undefined> = {
    imdb: imdb.success
      ? `https://www.imdb.com/title/${imdb.data}/keywords/`
      : undefined,
    tmdb: tmdb.success
      ? `https://www.themoviedb.org/movie/${tmdb.data}`
      : undefined,
    trakt: trakt.success ? `https://trakt.tv/movies/${trakt.data}` : undefined,
    mdblist: imdb.success
      ? `https://mdblist.com/movie/${imdb.data}`
      : undefined,
  }
  const hosts: Record<string, string> = {
    imdb: 'imdb.com',
    tmdb: 'themoviedb.org',
    trakt: 'trakt.tv',
    mdblist: 'mdblist.com',
    lastfm: 'last.fm',
    musicbrainz: 'musicbrainz.org',
    discogs: 'discogs.com',
    rym: 'rateyourmusic.com',
  }
  const prefix = /^(imdb|tmdb|trakt|mdblist)\.([^.]+)$/i.exec(
    source.rawName.trim(),
  )
  const upstream =
    source.source && source.source !== 'unknown'
      ? source.source
      : prefix?.[1]?.toLowerCase()
  for (const provider of [...new Set([upstream, source.provider])]) {
    if (!provider || provider === 'unknown') continue
    const template =
      manifest?.id === provider
        ? (manifest.sourceNavigation?.tagUrlTemplate ??
          manifest.sourceNavigation?.collectionUrlTemplate)
        : undefined
    let host = hosts[provider]
    if (!host && template) {
      try {
        host = new URL(template).hostname.replace(/^www\./, '')
      } catch {
        /* Invalid templates cannot establish a trusted source host. */
      }
    }
    // Link ownership identifies the importing adapter, not necessarily the destination.
    const saved = links.find((item) => {
      if (!host) return false
      try {
        const url = new URL(item.url)
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.hostname.replace(/^www\./, '') === host
        )
      } catch {
        return false
      }
    })
    const link = sourceLink(
      provider,
      sourceProviderLabel(
        provider,
        provider === source.provider ? providerLabel : null,
      ),
      source.rawName,
      generated[provider] ?? saved?.url,
    )
    if (link)
      return {
        link,
        kind:
          provider === source.provider && provider !== upstream
            ? 'provider-item'
            : 'item',
      }
  }
  return undefined
}
