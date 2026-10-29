import type { JsonValue, MediaPluginManifest } from '@repo/media-plugin-sdk'
import {
  AlbumProviderDetailsSchema,
  type AlbumProviderDetails,
} from '@repo/schemas/album-provider-details'
import { z } from 'zod'
import {
  AlbumCountSchema,
  AlbumHttpUrlSchema,
  AlbumMbidSchema,
} from '@/plugins/builtin/album-provider-helpers'

const NamedTagSchema = z.object({
  name: z.string().min(1),
  id: AlbumMbidSchema.optional(),
  count: z.number().int().safe().optional(),
})
export const MusicBrainzGroupIdentitySchema = z.object({
  id: AlbumMbidSchema,
  title: z.string().min(1),
  'artist-credit': z
    .array(
      z.object({
        name: z.string().min(1).optional(),
        artist: z.object({
          id: AlbumMbidSchema,
          name: z.string().min(1),
          country: z.string().optional(),
        }),
      }),
    )
    .min(1),
})
export const MusicBrainzReleaseGroupSchema =
  MusicBrainzGroupIdentitySchema.extend({
    'first-release-date': z.string().optional(),
    'primary-type': z.string().nullable().optional(),
    'secondary-types': z.array(z.string()).optional(),
    disambiguation: z.string().optional(),
    genres: z.array(NamedTagSchema).optional(),
    tags: z.array(NamedTagSchema).optional(),
    relations: z
      .array(
        z.object({
          type: z.string(),
          url: z.object({ resource: AlbumHttpUrlSchema }).optional(),
        }),
      )
      .optional(),
  })

const IdSchema = z.number().int().positive().safe()
const DiscogsCreditSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().min(1),
  role: z.string().optional(),
  tracks: z.string().optional(),
})
export const DiscogsRecordSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  artists: z.array(z.object({ id: IdSchema, name: z.string().min(1) })).min(1),
  main_release: IdSchema.optional(),
  master_id: z.number().int().nonnegative().safe().optional(),
  genres: z.array(z.string().min(1)).optional(),
  styles: z.array(z.string().min(1)).optional(),
  country: z.string().optional(),
  released: z.string().optional(),
  year: z.number().int().nonnegative().safe().optional(),
  notes: z.string().optional(),
  labels: z
    .array(
      z.object({
        id: IdSchema.optional(),
        name: z.string().min(1),
        catno: z.string().optional(),
      }),
    )
    .optional(),
  formats: z
    .array(
      z.object({
        name: z.string().min(1),
        qty: AlbumCountSchema.optional(),
        descriptions: z.array(z.string()).optional(),
        text: z.string().optional(),
      }),
    )
    .optional(),
  companies: z
    .array(
      z.object({
        id: IdSchema.optional(),
        name: z.string().min(1),
        entity_type_name: z.string().optional(),
        catno: z.string().optional(),
      }),
    )
    .optional(),
  extraartists: z.array(DiscogsCreditSchema).optional(),
  images: z
    .array(z.object({ uri: AlbumHttpUrlSchema, type: z.string().optional() }))
    .optional(),
  tracklist: z
    .array(
      z.object({
        type_: z.string(),
        title: z.string().min(1),
        position: z.string(),
        duration: z.string().optional(),
        extraartists: z.array(DiscogsCreditSchema).optional(),
      }),
    )
    .optional(),
  community: z
    .object({
      have: z.number().int().nonnegative().safe().optional(),
      want: z.number().int().nonnegative().safe().optional(),
      rating: z
        .object({
          count: z.number().int().nonnegative(),
          average: z.number().min(0).max(5),
        })
        .optional(),
    })
    .optional(),
})

export const LastFmUrlSchema = AlbumHttpUrlSchema.refine((value) => {
  try {
    const url = new URL(value)
    const segments = url.pathname.replace(/\/$/, '').split('/')
    const names = segments.slice(segments[2] === '+noredirect' ? 3 : 2)
    return (
      ['www.last.fm', 'last.fm'].includes(url.hostname) &&
      segments[1] === 'music' &&
      names.length === 2 &&
      names.every((name) => name.length > 0)
    )
  } catch {
    return false
  }
}, 'Expected a Last.fm album URL')
const LastFmTagSchema = z.object({
  name: z.string().min(1),
  url: AlbumHttpUrlSchema.optional(),
  count: AlbumCountSchema.optional(),
})
const TagListSchema = z.union([
  z.object({
    tag: z.union([
      z.array(LastFmTagSchema),
      LastFmTagSchema.transform((tag) => [tag]),
    ]),
  }),
  // Last.fm represents an empty tag collection as an empty string.
  z.literal('').transform(() => ({ tag: [] })),
  z.strictObject({}).transform(() => ({ tag: [] })),
])
const LastFmTrackSchema = z.object({
  name: z.string().min(1),
  duration: AlbumCountSchema.nullish().transform(
    (duration) => duration ?? undefined,
  ),
  url: AlbumHttpUrlSchema.optional(),
})
export const LastFmAlbumSchema = z.object({
  name: z.string().min(1),
  artist: z.union([z.string().min(1), z.object({ name: z.string().min(1) })]),
  mbid: z.union([AlbumMbidSchema, z.literal('')]).optional(),
  url: LastFmUrlSchema,
  listeners: AlbumCountSchema.optional(),
  playcount: AlbumCountSchema.optional(),
  userplaycount: AlbumCountSchema.optional(),
  tags: TagListSchema.optional(),
  toptags: TagListSchema.optional(),
  image: z
    .array(
      z.object({
        '#text': z.union([AlbumHttpUrlSchema, z.literal('')]),
        size: z.string(),
      }),
    )
    .optional(),
  wiki: z
    .object({
      summary: z.string().optional(),
      content: z.string().optional(),
      published: z.string().optional(),
    })
    .optional(),
  tracks: z
    .object({
      track: z.union([
        z.array(LastFmTrackSchema),
        LastFmTrackSchema.transform((track) => [track]),
      ]),
    })
    .optional(),
})

const nullableText = (value: string | null | undefined) =>
  value?.trim() ? value : null

function musicBrainzAlbumDetails(
  group: z.infer<typeof MusicBrainzReleaseGroupSchema>,
) {
  return {
    provider: 'musicbrainz',
    sourceLabel: 'MusicBrainz',
    title: group.title,
    artists: group['artist-credit'].map(
      (credit) => credit.name ?? credit.artist.name,
    ),
    releaseGroupId: group.id,
    firstReleaseDate: nullableText(group['first-release-date']),
    primaryType: nullableText(group['primary-type']),
    secondaryTypes: group['secondary-types'] ?? [],
    disambiguation: nullableText(group.disambiguation),
    artistCountries: [
      ...new Set(
        group['artist-credit'].flatMap((credit) =>
          credit.artist.country ? [credit.artist.country] : [],
        ),
      ),
    ],
    relations: (group.relations ?? []).flatMap((relation) =>
      relation.url ? [{ type: relation.type, url: relation.url.resource }] : [],
    ),
    tags: [
      ...(group.genres ?? []).map((tag) => ({
        name: tag.name,
        rawName: tag.name,
        source: 'musicbrainz',
        sourceKind: 'genre',
        count: tag.count ?? null,
        sourceId: tag.id ?? null,
        url: null,
      })),
      ...(group.tags ?? []).map((tag) => ({
        name: tag.name,
        rawName: tag.name,
        source: 'musicbrainz',
        sourceKind: 'tag',
        count: tag.count ?? null,
        sourceId: tag.id ?? null,
        url: null,
      })),
    ],
  } satisfies Record<string, JsonValue> & { provider: 'musicbrainz' }
}

function discogsAlbumDetails(
  record: z.infer<typeof DiscogsRecordSchema>,
  release: z.infer<typeof DiscogsRecordSchema>,
  recordType: 'master' | 'release',
) {
  const creditDetails = (
    credit: z.infer<typeof DiscogsCreditSchema>,
    tracks = credit.tracks,
  ) => ({
    id: credit.id === undefined ? null : String(credit.id),
    name: credit.name,
    role: nullableText(credit.role),
    tracks: nullableText(tracks),
  })
  return {
    provider: 'discogs',
    sourceLabel: 'Discogs',
    title: record.title,
    artists: record.artists.map((artist) => artist.name),
    recordType,
    recordId: String(record.id),
    releaseId: String(release.id),
    releaseCountry: nullableText(release.country),
    released: nullableText(release.released),
    year: release.year || null,
    notes: nullableText(release.notes),
    labels: (release.labels ?? []).map((label) => ({
      id: label.id === undefined ? null : String(label.id),
      name: label.name,
      catalogNumber: nullableText(label.catno),
    })),
    formats: (release.formats ?? []).map((format) => ({
      name: format.name,
      quantity: format.qty ?? null,
      descriptions: format.descriptions ?? [],
      text: nullableText(format.text),
    })),
    companies: (release.companies ?? []).map((company) => ({
      id: company.id === undefined ? null : String(company.id),
      name: company.name,
      role: nullableText(company.entity_type_name),
      catalogNumber: nullableText(company.catno),
    })),
    credits: [
      ...(release.extraartists ?? []).map((credit) => creditDetails(credit)),
      ...(release.tracklist ?? []).flatMap((track) =>
        (track.extraartists ?? []).map((credit) =>
          creditDetails(credit, credit.tracks || track.position),
        ),
      ),
    ],
    tracks: (release.tracklist ?? []).map((track) => ({
      title: track.title,
      position: track.position,
      type: track.type_,
      duration: nullableText(track.duration),
    })),
    have: release.community?.have ?? null,
    want: release.community?.want ?? null,
    tags: [
      ...(record.genres ?? []).map((name) => ({
        name,
        rawName: name,
        source: 'discogs',
        sourceKind: 'genre',
        count: null,
        sourceId: null,
        url: null,
      })),
      ...(record.styles ?? []).map((name) => ({
        name,
        rawName: name,
        source: 'discogs',
        sourceKind: 'style',
        count: null,
        sourceId: null,
        url: null,
      })),
    ],
  } satisfies Record<string, JsonValue> & { provider: 'discogs' }
}

function lastFmAlbumDetails(album: z.infer<typeof LastFmAlbumSchema>) {
  return {
    provider: 'lastfm',
    sourceLabel: 'Last.fm',
    title: album.name,
    url: album.url,
    artists: [
      typeof album.artist === 'string' ? album.artist : album.artist.name,
    ],
    wiki: album.wiki
      ? {
          summary: nullableText(album.wiki.summary),
          content: nullableText(album.wiki.content),
          published: nullableText(album.wiki.published),
        }
      : null,
    tracks: (album.tracks?.track ?? []).map((track, index) => ({
      title: track.name,
      position: index + 1,
      url: track.url ?? null,
    })),
    tags: [
      ...(album.tags?.tag ?? []).map((tag) => ({
        name: tag.name,
        rawName: tag.name,
        source: 'lastfm',
        sourceKind: 'tag',
        count: tag.count ?? null,
        sourceId: null,
        url: tag.url ?? null,
      })),
      ...(album.toptags?.tag ?? []).map((tag) => ({
        name: tag.name,
        rawName: tag.name,
        source: 'lastfm',
        sourceKind: 'toptag',
        count: tag.count ?? null,
        sourceId: null,
        url: tag.url ?? null,
      })),
    ],
  } satisfies Record<string, JsonValue> & { provider: 'lastfm' }
}

/** Read only the selected provider's current snapshot; malformed data is not evidence. */
function readNativeAlbumDetails(provider: string, payload: unknown) {
  if (provider === 'musicbrainz') {
    const wrapped = z
      .object({ releaseGroup: MusicBrainzReleaseGroupSchema })
      .safeParse(payload)
    const group = MusicBrainzReleaseGroupSchema.safeParse(
      wrapped.success ? wrapped.data.releaseGroup : payload,
    )
    return group.success ? musicBrainzAlbumDetails(group.data) : null
  }
  if (provider === 'lastfm') {
    const wrapped = z.object({ album: LastFmAlbumSchema }).safeParse(payload)
    const album = LastFmAlbumSchema.safeParse(
      wrapped.success ? wrapped.data.album : payload,
    )
    return album.success ? lastFmAlbumDetails(album.data) : null
  }
  if (provider === 'discogs') {
    const master = z
      .object({ master: DiscogsRecordSchema, mainRelease: DiscogsRecordSchema })
      .safeParse(payload)
    if (master.success) {
      const { master: record, mainRelease: release } = master.data
      if (
        record.main_release !== release.id ||
        (release.master_id !== undefined && release.master_id !== record.id)
      )
        return null
      return discogsAlbumDetails(record, release, 'master')
    }
    const wrapped = z
      .object({ release: DiscogsRecordSchema })
      .safeParse(payload)
    const release = DiscogsRecordSchema.safeParse(
      wrapped.success ? wrapped.data.release : payload,
    )
    if (!release.success || release.data.main_release !== undefined) return null
    return discogsAlbumDetails(release.data, release.data, 'release')
  }
  return null
}

function fact(label: string, value: string | number | null | undefined) {
  return value === null ||
    value === undefined ||
    (typeof value === 'string' && !value.trim())
    ? []
    : [{ label, value: String(value) }]
}

function note(label: string, text: string | null | undefined) {
  return text?.trim() ? [{ label, text }] : []
}

function projectAlbumDetails(
  details: NonNullable<ReturnType<typeof readNativeAlbumDetails>>,
): AlbumProviderDetails {
  const common = {
    provider: details.provider,
    facts: [
      ...fact('Source title', details.title),
      ...fact('Source artists', details.artists.join(', ')),
    ],
    tags: details.tags.map((tag) => ({
      name: tag.rawName,
      kind: tag.sourceKind,
      ...(tag.count === null
        ? {}
        : {
            count: tag.count,
            countLabel:
              details.provider === 'musicbrainz' ? 'votes' : 'tag count',
          }),
    })),
  }
  if (details.provider === 'musicbrainz') {
    return AlbumProviderDetailsSchema.parse({
      ...common,
      url: `https://musicbrainz.org/release-group/${details.releaseGroupId}`,
      facts: [
        ...common.facts,
        ...fact('Primary type', details.primaryType),
        ...fact('Secondary types', details.secondaryTypes.join(', ')),
        ...fact('First release date', details.firstReleaseDate),
        ...fact('Artist countries', details.artistCountries.join(', ')),
      ],
      notes: note('Disambiguation', details.disambiguation),
      links: details.relations.map((relation) => ({
        label: relation.type,
        url: relation.url,
      })),
    })
  }
  if (details.provider === 'discogs') {
    return AlbumProviderDetailsSchema.parse({
      ...common,
      url: `https://www.discogs.com/${details.recordType}/${details.recordId}`,
      facts: [
        ...common.facts,
        ...fact(
          'Edition scope',
          `${details.recordType === 'master' ? 'Main release' : 'Release'} ${details.releaseId} only`,
        ),
        ...fact('Release country', details.releaseCountry),
        ...fact('Released', details.released),
        ...fact('Release year', details.year),
        ...fact('Have (release)', details.have),
        ...fact('Want (release)', details.want),
        ...details.labels.map((label) => ({
          label: 'Label',
          value: [label.name, label.catalogNumber].filter(Boolean).join(' / '),
        })),
        ...details.formats.map((format) => ({
          label: 'Format',
          value: [
            format.quantity === null ? null : `${format.quantity} x`,
            format.name,
            ...format.descriptions,
            format.text,
          ]
            .filter(Boolean)
            .join(' / '),
        })),
        ...details.companies.map((company) => ({
          label: company.role || 'Company',
          value: [company.name, company.catalogNumber]
            .filter(Boolean)
            .join(' / '),
        })),
      ],
      notes: note('Release notes', details.notes),
      credits: details.credits.flatMap((credit) =>
        credit.role
          ? [
              {
                name: credit.name,
                role: credit.tracks
                  ? `${credit.role} (${credit.tracks})`
                  : credit.role,
              },
            ]
          : [],
      ),
      links: [
        {
          label: 'Release edition',
          url: `https://www.discogs.com/release/${details.releaseId}`,
        },
      ],
      tracks: details.tracks.map((track) => ({
        title: track.title,
        position: track.position,
      })),
    })
  }
  return AlbumProviderDetailsSchema.parse({
    ...common,
    url: details.url,
    facts: [
      ...common.facts,
      ...fact('Wiki published', details.wiki?.published),
    ],
    notes: [
      ...note('Wiki summary', details.wiki?.summary),
      ...note('Wiki content', details.wiki?.content),
    ],
    links: details.tags.flatMap((tag) =>
      tag.url
        ? [{ label: `${tag.sourceKind}: ${tag.rawName}`, url: tag.url }]
        : [],
    ),
    tracks: details.tracks.map((track) => ({
      title: track.title,
      position: String(track.position),
      ...(track.url ? { url: track.url } : {}),
    })),
  })
}

export function readAlbumProviderDetails(
  provider: string,
  payload: unknown,
): AlbumProviderDetails | null {
  const details = readNativeAlbumDetails(provider, payload)
  return details ? projectAlbumDetails(details) : null
}

export const albumProviderDetailBrowseFields = {
  musicbrainz: [
    {
      key: 'plugin.musicbrainz.primaryType',
      label: 'MusicBrainz primary type',
      type: 'text',
      filterable: true,
    },
    {
      key: 'plugin.musicbrainz.secondaryTypes',
      label: 'MusicBrainz secondary types',
      type: 'text',
      filterable: true,
    },
    {
      key: 'plugin.musicbrainz.artistCountries',
      label: 'MusicBrainz artist countries',
      type: 'text',
      filterable: true,
    },
  ],
  discogs: [
    {
      key: 'plugin.discogs.labels',
      label: 'Discogs labels',
      type: 'text',
      filterable: true,
    },
    {
      key: 'plugin.discogs.formats',
      label: 'Discogs formats',
      type: 'text',
      filterable: true,
    },
    {
      key: 'plugin.discogs.releaseCountry',
      label: 'Discogs release country',
      type: 'text',
      filterable: true,
    },
    {
      key: 'plugin.discogs.have',
      label: 'Discogs have (release)',
      type: 'number',
      format: 'number',
      filterable: true,
    },
    {
      key: 'plugin.discogs.want',
      label: 'Discogs want (release)',
      type: 'number',
      format: 'number',
      filterable: true,
    },
  ],
  lastfm: [],
} satisfies Record<string, NonNullable<MediaPluginManifest['browseFields']>>

/** Metadata-only projection shared by readonly details and future user-requested jobs. */
export function albumProviderDetailsMetadata(
  provider: string,
  payload: unknown,
): Record<string, JsonValue> & { browse: Record<string, JsonValue> } {
  const browse: Record<string, JsonValue> = {}
  const details = readNativeAlbumDetails(provider, payload)
  if (!details) return { browse }
  if (details.provider === 'musicbrainz') {
    if (details.primaryType)
      browse['plugin.musicbrainz.primaryType'] = details.primaryType
    if (details.secondaryTypes.length)
      browse['plugin.musicbrainz.secondaryTypes'] = details.secondaryTypes
    if (details.artistCountries.length)
      browse['plugin.musicbrainz.artistCountries'] = details.artistCountries
  }
  if (details.provider === 'discogs') {
    if (details.labels.length)
      browse['plugin.discogs.labels'] = [
        ...new Set(details.labels.map((label) => label.name)),
      ]
    if (details.formats.length)
      browse['plugin.discogs.formats'] = [
        ...new Set(
          details.formats.map((format) =>
            [format.name, ...format.descriptions].join(', '),
          ),
        ),
      ]
    if (details.releaseCountry)
      browse['plugin.discogs.releaseCountry'] = details.releaseCountry
    if (details.have !== null) browse['plugin.discogs.have'] = details.have
    if (details.want !== null) browse['plugin.discogs.want'] = details.want
  }
  return {
    [`plugin.${details.provider}.details`]: projectAlbumDetails(details),
    [`plugin.${details.provider}.tagEvidence`]: details.tags,
    browse,
  }
}
