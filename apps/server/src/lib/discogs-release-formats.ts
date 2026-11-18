import { z } from 'zod'
import { albumNameKey } from './album-import-candidates'
import { DiscogsRecordSchema } from './album-provider-details'
import { DiscogsReferenceIdSchema } from '@/plugins/builtin/album-provider-helpers'

export const StoredDiscogsIdSchema = z.union([
  DiscogsRecordSchema.shape.id.transform(String),
  DiscogsReferenceIdSchema,
])

export const DiscogsReleaseEnvelopeSchema = z.object({
  master: z.unknown().optional(),
  mainRelease: z.unknown().optional(),
  release: z.unknown().optional(),
  releases: z.unknown().optional(),
  versions: z.unknown().optional(),
})

const FormatLabelSchema = z.string().trim().min(1).max(250)
const ReleaseFormatsSchema = z.object({
  id: StoredDiscogsIdSchema,
  master_id: StoredDiscogsIdSchema.optional(),
  title: z.string().trim().min(1).max(500),
  formats: z
    .array(
      z.object({ descriptions: z.array(FormatLabelSchema).max(30).optional() }),
    )
    .max(30)
    .optional(),
  major_formats: z.array(FormatLabelSchema).max(30).optional(),
  format: FormatLabelSchema.optional(),
})
const VersionsSchema = z.array(z.unknown()).max(500)
const VersionsPageSchema = z
  .object({
    pagination: z.object({
      page: z.literal(1),
      pages: z.literal(1),
      items: z.number().int().positive(),
    }),
    versions: VersionsSchema,
  })
  .refine(({ versions, pagination }) => versions.length === pagination.items)
const ReleaseTypeSchema = z.enum(['album', 'single', 'ep'])

export function discogsMasterReleaseType(
  envelope: z.infer<typeof DiscogsReleaseEnvelopeSchema>,
  master: { id: string; title: string; main_release?: unknown },
) {
  const mainReleaseId = StoredDiscogsIdSchema.safeParse(
    master.main_release,
  ).data
  const releases = VersionsSchema.safeParse(envelope.releases).data ?? []
  const versions =
    VersionsPageSchema.safeParse(envelope.versions).data?.versions ?? []
  const masterTitle = albumNameKey(master.title.normalize('NFC'))
  const types = new Set<z.infer<typeof ReleaseTypeSchema>>()

  function addRelease(value: unknown, expectedId?: string) {
    const release = ReleaseFormatsSchema.safeParse(value).data
    if (
      !release ||
      (expectedId !== undefined && release.id !== expectedId) ||
      (release.master_id !== undefined && release.master_id !== master.id) ||
      albumNameKey(release.title.normalize('NFC')) !== masterTitle
    )
      return

    const labels = [
      ...(release.formats?.flatMap(({ descriptions }) => descriptions ?? []) ??
        []),
      ...(release.major_formats ?? []),
      ...(release.format?.split(',') ?? []),
    ]
    for (const label of labels) {
      const type = ReleaseTypeSchema.safeParse(albumNameKey(label)).data
      if (type) types.add(type)
    }
  }

  if (mainReleaseId) {
    addRelease(envelope.mainRelease, mainReleaseId)
    addRelease(envelope.release, mainReleaseId)
  }
  // Stored versions are already scoped to this master. Guard their title and
  // any explicit master ID before reading their classification.
  for (const release of [...releases, ...versions]) addRelease(release)
  return types.size === 1 ? [...types][0] : undefined
}
