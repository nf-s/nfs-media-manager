'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { EntityRelationship } from '@repo/schemas/entity-relationships'
import { Pill, PillLabel, Pills } from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
import { DetailLink } from './detail-link'
import { useDetailInspector } from './detail-inspector-context'
import ManualMediaAdd from './manual-media-add'

function RelationshipPills({
  label,
  relationships,
}: {
  label: string
  relationships: EntityRelationship[]
}) {
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const client = useQueryClient()
  const inspector = useDetailInspector()
  return (
    <>
      <Pills wrap label={label}>
        {relationships.map(
          ({ targetType, targetId, name, externalId }, index) => {
            const key = `${targetId ?? externalId ?? name}:${index}`
            if (targetId)
              return (
                <Pill key={key} size="md" asChild>
                  <DetailLink kind={targetType} id={targetId}>
                    <PillLabel>{name}</PillLabel>
                  </DetailLink>
                </Pill>
              )
            if (targetType === 'artist')
              return (
                <Pill key={key} size="md">
                  {name}
                </Pill>
              )
            return (
              <Pill key={key} size="md" asChild>
                <span>
                  <PillLabel title={name}>{name}</PillLabel>
                  <Button
                    type="button"
                    size="xs"
                    variant="link"
                    aria-label={`Add to Library: ${name}`}
                    aria-haspopup="dialog"
                    onClick={() => setSearchQuery(name)}
                  >
                    Add to Library
                  </Button>
                </span>
              </Pill>
            )
          },
        )}
      </Pills>
      {searchQuery !== null && (
        <ManualMediaAdd
          mediaType="album"
          initialQuery={searchQuery}
          onClose={() => setSearchQuery(null)}
          onAdded={async (id) => {
            await Promise.all(
              ['album', 'artist', 'track', 'tracks'].map((key) =>
                client.invalidateQueries({ queryKey: [key] }),
              ),
            )
            setSearchQuery(null)
            if (inspector) inspector.open({ kind: 'album', id })
            else window.location.assign(`/albums/${encodeURIComponent(id)}`)
          }}
        />
      )}
    </>
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
