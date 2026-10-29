import { z } from 'zod'
import {
  JsonValueSchema,
  PluginTagSchema,
  type PluginTag,
} from '@repo/media-plugin-sdk'
import { createStableId } from '@/lib/media-utils'
import { normalizeMdblistPayload } from '@/lib/mdblist-normalizer'
import {
  isJsonRecord,
  normalizeOmdbPayload,
  normalizeTmdbPayload,
} from '@/lib/provider-normalizers'
import {
  sourceLink,
  sourceProviderLabel,
  storedItemSourceLink,
  tagSourceProvider,
  tagSourceUrl,
} from '@/lib/source-navigation'
import { normalizeTagName } from '@/services/tag-state'

const MediaTypeSchema = z.enum(['album', 'film'])
export const BackfillMembershipSchema = z.object({
  mediaItemId: z.string(),
  mediaType: MediaTypeSchema,
  tagId: z.string(),
  name: z.string(),
  kind: z.string(),
})
export const BackfillOccurrenceSchema = z.object({
  id: z.string(),
  mediaItemId: z.string(),
  tagId: z.string(),
  provider: z.string().nullable(),
  source: z.string().nullable(),
  sourceId: z.string().nullable(),
  rawName: z.string(),
  kind: z.string(),
})
export const BackfillSnapshotSchema = z.object({
  id: z.string(),
  mediaItemId: z.string(),
  mediaType: MediaTypeSchema,
  provider: z.string(),
  checksum: z.string(),
  source: z.string(),
  payload: JsonValueSchema,
  normalizedData: JsonValueSchema.nullable(),
})
type Snapshot = z.infer<typeof BackfillSnapshotSchema>
type Occurrence = z.infer<typeof BackfillOccurrenceSchema>
type Membership = z.infer<typeof BackfillMembershipSchema>
type Evidence = {
  snapshotId: string
  checksum: string
  path: string
  raw: unknown
}
type Candidate = { provider: string; tag: PluginTag; evidence: Evidence }
const ObjectSchema = z.record(z.string(), z.unknown())
const NamedSchema = z.object({
  name: z.string().min(1),
  id: z.unknown().optional(),
})

function object(value: unknown): Record<string, unknown> {
  const parsed = ObjectSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

/** Read only explicit structured tags, never prose, search snippets or artist tags. */
export function snapshotTagEvidence(snapshot: Snapshot): Candidate[] {
  const candidates: Candidate[] = []
  function add(provider: string, tag: PluginTag, path: string, raw: unknown) {
    if (!normalizeTagName(tag.name)) return
    candidates.push({
      provider,
      tag,
      evidence: {
        snapshotId: snapshot.id,
        checksum: snapshot.checksum,
        path,
        raw,
      },
    })
  }
  if (!['legacy-record', 'legacy-browser'].includes(snapshot.provider)) {
    const tags = object(snapshot.normalizedData)['tags']
    if (Array.isArray(tags))
      tags.forEach((raw, index) => {
        const parsed = PluginTagSchema.safeParse(raw)
        if (parsed.success)
          add(
            snapshot.provider,
            parsed.data,
            `normalizedData.tags[${index}]`,
            raw,
          )
      })
  }
  function read(provider: string, value: unknown, prefix: string) {
    const payload = object(value)
    function list(value: unknown, path: string, kind: string, idType?: 'uuid') {
      if (!Array.isArray(value)) return
      value.forEach((raw, index) => {
        const parsed = NamedSchema.safeParse(
          typeof raw === 'string' ? { name: raw } : raw,
        )
        if (!parsed.success) return
        const id =
          idType === 'uuid'
            ? z.string().uuid().safeParse(parsed.data.id)
            : undefined
        add(
          provider,
          {
            name: parsed.data.name,
            rawName: parsed.data.name,
            kind,
            source: provider,
            ...(id?.success ? { sourceId: id.data } : {}),
          },
          `${prefix}.${path}[${index}]`,
          raw,
        )
      })
    }
    if (snapshot.mediaType === 'album') {
      if (provider === 'musicbrainz') {
        const group =
          'releaseGroup' in payload ? object(payload['releaseGroup']) : payload
        const path = 'releaseGroup' in payload ? 'releaseGroup.' : ''
        list(group['genres'], `${path}genres`, 'genre', 'uuid')
        list(group['tags'], `${path}tags`, 'general')
      } else if (provider === 'discogs') {
        const key = payload['master']
          ? 'master'
          : payload['release']
            ? 'release'
            : null
        const record = key ? object(payload[key]) : payload
        for (const field of ['genres', 'styles'])
          list(record[field], `${key ? `${key}.` : ''}${field}`, 'genre')
      } else if (provider === 'lastfm') {
        const wrapped = 'album' in payload
        const album = wrapped ? object(payload['album']) : payload
        const legacy = snapshot.source.startsWith('legacy')
        for (const field of ['tags', 'toptags']) {
          const raw = object(album[field])['tag']
          const path = `${wrapped ? 'album.' : ''}${field}.tag`
          list(raw, path, legacy ? 'genre' : 'general')
          // The legacy cleaner wrapped album tags.tag singleton objects before merging genres.
          if (legacy && field === 'tags') {
            const parsed = NamedSchema.safeParse(raw)
            if (parsed.success)
              add(
                provider,
                {
                  name: parsed.data.name,
                  rawName: parsed.data.name,
                  kind: 'genre',
                  source: provider,
                },
                `${prefix}.${path}`,
                raw,
              )
          }
        }
      } else if (provider === 'google-custom-search') {
        const genres = z
          .array(z.string().min(1))
          .safeParse(object(payload['rymGoogle'])['genres'])
        // Preserve the legacy import namespace, not the modern plugin's source='rym'.
        if (genres.success) list(genres.data, 'rymGoogle.genres', 'genre')
      } else if (provider === 'spotify') {
        const key =
          'spotify' in payload ? 'spotify' : 'album' in payload ? 'album' : null
        list(
          (key ? object(payload[key]) : payload)['genres'],
          `${key ? `${key}.` : ''}genres`,
          'genre',
        )
      }
    } else if (['tmdb', 'omdb', 'mdblist'].includes(provider)) {
      const parsed = JsonValueSchema.safeParse(value)
      if (!parsed.success || !isJsonRecord(parsed.data)) return
      try {
        const normalized =
          provider === 'tmdb'
            ? normalizeTmdbPayload(parsed.data)
            : provider === 'omdb'
              ? normalizeOmdbPayload(parsed.data)
              : normalizeMdblistPayload(parsed.data)
        for (const tag of normalized.normalized.tags) {
          // Preserve the exact structured array/string used by the existing normalizer.
          const field =
            tag.kind === 'keyword'
              ? 'keywords'
              : provider === 'omdb' && 'Genre' in payload
                ? 'Genre'
                : 'genres'
          add(provider, tag, `${prefix}.${field}`, payload[field])
        }
      } catch {
        // Invalid retained provider payloads are not evidence.
      }
    }
  }
  if (snapshot.provider === 'legacy-record') {
    const payload = object(snapshot.payload)
    for (const [field, provider] of [
      ['mb', 'musicbrainz'],
      ['discogs', 'discogs'],
      ['lastFm', 'lastfm'],
      ['spotify', 'spotify'],
      ['tmdb', 'tmdb'],
      ['omdb', 'omdb'],
    ]) {
      if (field && provider && payload[field])
        read(provider, payload[field], `payload.${field}`)
    }
    read('google-custom-search', payload, 'payload')
  } else read(snapshot.provider, snapshot.payload, 'payload')
  return candidates
}

export function planTagProvenanceBackfill(input: {
  memberships: Membership[]
  occurrences: Occurrence[]
  snapshots: Snapshot[]
  links?: { mediaItemId: string; provider: string; url: string }[]
  references?: {
    mediaItemId: string
    referenceType: string
    externalId: string
  }[]
}) {
  const additions: {
    occurrence: Occurrence
    mediaType: 'album' | 'film'
    evidence: Evidence[]
    link: ReturnType<typeof sourceLink>
  }[] = []
  const unresolved: {
    mediaItemId: string
    tagId: string
    name: string
    kind: string
    reason: string
  }[] = []
  let missing = 0
  let alreadyPresent = 0
  const extracted = new Map(
    input.snapshots.map((snapshot) => [
      snapshot.id,
      snapshotTagEvidence(snapshot),
    ]),
  )
  for (const membership of input.memberships) {
    const stored = input.occurrences.filter(
      (row) =>
        row.mediaItemId === membership.mediaItemId &&
        row.tagId === membership.tagId,
    )
    const unknown = stored.filter(
      (row) => !row.provider && !row.source && !row.sourceId,
    )
    const targets = stored.length
      ? unknown
      : [{ rawName: membership.name, kind: membership.kind }]
    if (!targets.length) continue
    missing++
    for (const target of targets) {
      const matches = input.snapshots
        .filter(
          (snapshot) =>
            snapshot.mediaItemId === membership.mediaItemId &&
            snapshot.mediaType === membership.mediaType,
        )
        .flatMap((snapshot) => extracted.get(snapshot.id) ?? [])
        .filter(
          (candidate) =>
            candidate.tag.kind === target.kind &&
            normalizeTagName(candidate.tag.name) ===
              normalizeTagName(target.rawName),
        )
      const groups = new Map<string, Candidate[]>()
      for (const candidate of matches) {
        const key = JSON.stringify([
          candidate.provider,
          candidate.tag.source ?? candidate.provider,
          normalizeTagName(candidate.tag.rawName ?? candidate.tag.name),
          candidate.tag.kind,
        ])
        groups.set(key, [...(groups.get(key) ?? []), candidate])
      }
      if (!groups.size)
        unresolved.push({
          ...membership,
          name: target.rawName,
          kind: target.kind,
          reason: 'No exact structured snapshot evidence',
        })
      for (const group of groups.values()) {
        const ids = new Set(
          group
            .map((item) => item.tag.sourceId)
            .filter((id) => id !== undefined),
        )
        if (ids.size > 1) {
          unresolved.push({
            ...membership,
            name: target.rawName,
            kind: target.kind,
            reason: 'Conflicting snapshot source IDs',
          })
          continue
        }
        const candidate = group.find((item) => item.tag.sourceId) ?? group[0]
        if (!candidate) continue
        const { tag, provider } = candidate
        const source = tag.source ?? provider
        const rawName = tag.rawName ?? tag.name
        const sourceId = tag.sourceId ?? null
        const existing = stored.filter(
          (row) =>
            row.provider === provider &&
            (row.source ?? provider) === source &&
            row.kind === tag.kind &&
            normalizeTagName(row.rawName) === normalizeTagName(rawName),
        )
        if (existing.length) {
          alreadyPresent++
          if (
            existing.some(
              (row) => row.sourceId && sourceId && row.sourceId !== sourceId,
            )
          )
            unresolved.push({
              ...membership,
              name: target.rawName,
              kind: target.kind,
              reason: 'Existing source ID differs; preserved unchanged',
            })
          continue
        }
        const occurrence = {
          id: createStableId(
            'tagocc',
            JSON.stringify([
              membership.mediaItemId,
              provider,
              source,
              sourceId,
              rawName,
              tag.kind,
              normalizeTagName(tag.name),
            ]),
          ),
          mediaItemId: membership.mediaItemId,
          tagId: membership.tagId,
          provider,
          source,
          sourceId,
          rawName,
          kind: tag.kind,
        }
        if (additions.some((item) => item.occurrence.id === occurrence.id))
          continue
        const upstream = tagSourceProvider(occurrence) ?? provider
        const link =
          sourceLink(
            upstream,
            sourceProviderLabel(upstream, null),
            rawName,
            tagSourceUrl(occurrence),
          ) ??
          storedItemSourceLink(
            occurrence,
            (input.links ?? []).filter(
              (row) => row.mediaItemId === membership.mediaItemId,
            ),
            (input.references ?? []).filter(
              (row) => row.mediaItemId === membership.mediaItemId,
            ),
            null,
            sourceProviderLabel(provider, null),
          )?.link ??
          null
        additions.push({
          occurrence,
          mediaType: membership.mediaType,
          evidence: group.map((item) => item.evidence),
          link,
        })
      }
    }
  }
  return {
    scannedMemberships: input.memberships.length,
    missingMemberships: missing,
    alreadyPresent,
    additions,
    unresolved,
  }
}
