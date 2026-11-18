import { z } from 'zod'
import { CreatorIdSchema } from './common'
import { SourceNavigationLinkSchema } from './tags'

export const EntityRelationshipCandidateSchema = z.object({
  kind: z
    .string()
    .max(80)
    .regex(/^[a-z][a-z0-9-]*$/),
  targetType: z.enum(['artist', 'album']),
  name: z.string().trim().min(1).max(1000),
  externalId: z.string().trim().min(1).max(1000).optional(),
  referenceType: z.string().trim().min(1).max(80).optional(),
  url: SourceNavigationLinkSchema.shape.url.optional(),
})
export type EntityRelationshipCandidate = z.infer<
  typeof EntityRelationshipCandidateSchema
>

export const EntityRelationshipSchema =
  EntityRelationshipCandidateSchema.extend({
    targetId: CreatorIdSchema.optional(),
  })
export type EntityRelationship = z.infer<typeof EntityRelationshipSchema>

export const EntityRelationshipSourceSchema = z.object({
  provider: z.string(),
  snapshotId: z.string(),
  jobId: z.string().nullable(),
  createdAt: z.string().datetime(),
  relationships: z.array(EntityRelationshipSchema).max(100),
})
export type EntityRelationshipSource = z.infer<
  typeof EntityRelationshipSourceSchema
>
