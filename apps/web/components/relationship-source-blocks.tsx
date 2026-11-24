'use client'

import type { EntityRelationship } from '@repo/schemas/entity-relationships'
import { Pill, PillLabel, Pills } from '@repo/ui/components/ds/pill'
import { DetailLink } from './detail-link'

function RelationshipPills({
  label,
  relationships,
}: {
  label: string
  relationships: EntityRelationship[]
}) {
  return (
    <Pills wrap label={label}>
      {relationships.map(
        ({ targetType, targetId, name, externalId, url }, index) => {
          const key = `${targetId ?? externalId ?? name}:${index}`
          if (targetId)
            return (
              <Pill key={key} size="md" asChild>
                <DetailLink kind={targetType} id={targetId}>
                  <PillLabel>{name}</PillLabel>
                </DetailLink>
              </Pill>
            )
          if (targetType === 'album' && url)
            return (
              <Pill key={key} size="md" asChild>
                <a href={url} target="_blank" rel="noreferrer">
                  <PillLabel>{name}</PillLabel>
                </a>
              </Pill>
            )
          return (
            <Pill key={key} size="md">
              {name}
            </Pill>
          )
        },
      )}
    </Pills>
  )
}

/** Group a provider's stored relationships by how they read in Sources. */
export function relationshipSourceBlocks(
  relationships: readonly EntityRelationship[] = [],
) {
  const groups = new Map<string, EntityRelationship[]>()
  for (const relationship of relationships) {
    const title = `${relationship.kind === 'similar' ? 'Similar' : 'Related'} ${relationship.targetType}s`
    const group = groups.get(title)
    if (group) group.push(relationship)
    else groups.set(title, [relationship])
  }
  return [...groups].map(([title, group]) => ({
    title,
    content: <RelationshipPills label={title} relationships={group} />,
  }))
}
