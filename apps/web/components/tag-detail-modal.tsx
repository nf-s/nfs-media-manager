'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import {
  formatTagName,
  TagDetailSchema,
  type SetTagParentsInput,
  type Tag,
  type TagDetail as TagDetailData,
} from '@repo/schemas/tags'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Pill, Pills } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  detailPageHref,
  tagDetailId,
  type DetailTarget,
} from '@/utils/detail-inspector'
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
import { useDetailInspector } from './detail-inspector-context'
import { DetailTabs, useDetailTab } from './detail-frame'
import { BrowseFilterPill } from './browse-controls'
import { errorMessage } from './lastfm-sync'
import { MediaInspector } from './media-inspector'
import { VirtualTagSources } from './metadata-source-list'
import TagActions from './tag-actions'
import { useSetTagParents } from './tag-parent-actions'
import { TagPicker } from './tag-picker'

type TagTab = 'overview' | 'sources'
const tagTabs: readonly [TagTab, ...TagTab[]] = ['overview', 'sources']

function TagManagement({ tag }: { tag: Tag }) {
  const [candidate, setCandidate] = useState<Tag | null>(null)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<{
    message: string
    interrupted: boolean
  } | null>(null)
  return (
    <Section title="Manage tag">
      <p className="ds-help">
        {tag.hidden
          ? 'Hidden from normal browsing. Unhide to restore it.'
          : 'Hiding removes this tag from normal browsing, not its source data.'}
      </p>
      <TagPicker
        mediaType={tag.mediaType}
        label="Find another tag to merge"
        inputLabel="Find tag to merge"
        listLabel="Tags to merge"
        disabled={pending}
        unavailable={(item) => (item.id === tag.id ? 'current tag' : null)}
        onPick={setCandidate}
      />
      {candidate && (
        <p className="ds-actions">
          <span>
            Merge with: <strong>{formatTagName(candidate.name)}</strong>
          </span>
          <Button
            variant="link"
            size="xs"
            disabled={pending}
            onClick={() => setCandidate(null)}
          >
            Remove
          </Button>
        </p>
      )}
      <TagActions
        key={`${tag.id}:${candidate?.id ?? ''}`}
        tags={candidate ? [tag, candidate] : [tag]}
        onPendingChange={setPending}
        onComplete={(_ids, message, interrupted) => {
          setCandidate(null)
          setOutcome({ message, interrupted })
        }}
      />
      {outcome &&
        (outcome.interrupted ? (
          <Notice tone="attention">{outcome.message}</Notice>
        ) : (
          <p role="status" className="ds-help">
            {outcome.message}
          </p>
        ))}
    </Section>
  )
}

/** Parent tags and subtags of one tag, each removable, with a picker to add one. */
function TagHierarchySections({ detail }: { detail: TagDetailData }) {
  const { tag, children } = detail
  const inspector = useDetailInspector()
  const parents = useSetTagParents()
  const pending = parents.isPending
  const parentIds = tag.parents.map((parent) => parent.id)
  const childIds = children.map((child) => child.id)
  function change(input: Omit<SetTagParentsInput, 'mediaType'>) {
    parents.mutate({ mediaType: tag.mediaType, ...input })
  }
  function tagActivation(id: string, name: string) {
    if (!inspector) return undefined
    const target: DetailTarget = {
      kind: 'tag',
      id: tagDetailId(tag.mediaType, id),
    }
    return {
      onActivate: () => inspector.open(target),
      destination: { href: detailPageHref(target), label: formatTagName(name) },
    }
  }
  const failure = parents.isError
    ? errorMessage(parents.error, 'Could not update parent tags.')
    : parents.data?.message
  return (
    <>
      <Section title="Parent tags" flush>
        {tag.parents.length ? (
          <Pills wrap label="Parent tags">
            {tag.parents.map((parent) => (
              <BrowseFilterPill
                key={parent.id}
                label={`Open ${formatTagName(parent.name)}`}
                {...tagActivation(parent.id, parent.name)}
                removeLabel={`Remove parent ${formatTagName(parent.name)}`}
                onRemove={() => {
                  if (pending) return
                  change({
                    tagIds: [tag.id],
                    parentIds: [parent.id],
                    mode: 'remove',
                  })
                }}
              >
                {formatTagName(parent.name)}
              </BrowseFilterPill>
            ))}
          </Pills>
        ) : (
          <p className="ds-help">No parent tags.</p>
        )}
        <TagPicker
          mediaType={tag.mediaType}
          label="Add parent tag"
          inputLabel="Find parent tag"
          listLabel="Tags to add as parent"
          disabled={pending}
          unavailable={(item) =>
            item.id === tag.id
              ? 'current tag'
              : parentIds.includes(item.id)
                ? 'parent'
                : null
          }
          onPick={(item) =>
            change({ tagIds: [tag.id], parentIds: [item.id], mode: 'add' })
          }
        />
      </Section>
      <Section title="Subtags" flush>
        {children.length ? (
          <Pills wrap label="Subtags">
            {children.map((child) => (
              <BrowseFilterPill
                key={child.id}
                label={`Open ${formatTagName(child.name)}`}
                {...tagActivation(child.id, child.name)}
                removeLabel={`Remove subtag ${formatTagName(child.name)}`}
                onRemove={() => {
                  if (pending) return
                  change({
                    tagIds: [child.id],
                    parentIds: [tag.id],
                    mode: 'remove',
                  })
                }}
              >
                {formatTagName(child.name)}
              </BrowseFilterPill>
            ))}
          </Pills>
        ) : (
          <p className="ds-help">No subtags.</p>
        )}
        <TagPicker
          mediaType={tag.mediaType}
          label="Add subtag"
          inputLabel="Find subtag"
          listLabel="Tags to add as subtag"
          disabled={pending}
          unavailable={(item) =>
            item.id === tag.id
              ? 'current tag'
              : childIds.includes(item.id)
                ? 'subtag'
                : null
          }
          onPick={(item) =>
            change({ tagIds: [item.id], parentIds: [tag.id], mode: 'add' })
          }
        />
        {pending && (
          <p role="status" className="ds-help">
            Updating tags...
          </p>
        )}
        {failure && <Notice tone="danger">{failure}</Notice>}
      </Section>
    </>
  )
}

/** A tag in the shared detail drawer: its use, management and sources. */
export function TagDetail({
  id,
  mediaType,
}: {
  id: string
  mediaType: 'album' | 'film'
}) {
  const { apiBaseUrl } = useConfig()
  const { tab, setTab } = useDetailTab(tagTabs, {
    aliases: { provenance: 'sources' },
  })
  const detail = useVirtualTable({
    queryKey: ['tag-detail', mediaType, id],
    loadPage: async (page, size, signal) => {
      const result = await fetchApiData(
        apiBaseUrl,
        `/api/v1/tags/${encodeURIComponent(id)}?${new URLSearchParams({ mediaType, page: String(page), size: String(size) })}`,
        TagDetailSchema,
        { signal },
      )
      return { ...result.provenance, summary: result }
    },
  })
  const data = detail.firstPage?.summary
  if (!data)
    return (
      <CreatorDetailState
        pending={!detail.isError}
        retry={detail.retry}
        subject="tag"
      />
    )
  const library = data.tag.mediaType === 'album' ? 'albums' : 'films'
  return (
    <article className="dtl-detail">
      <DetailHeader
        kind="Tag"
        title={formatTagName(data.tag.name)}
        by={data.tag.mediaType === 'album' ? 'Album tag' : 'Film tag'}
        facts={[
          data.tag.mediaType === 'album'
            ? `${formatCount(data.tag.mediaCount)} albums`
            : `${formatCount(data.tag.mediaCount)} items`,
          data.tag.mediaType === 'album'
            ? `${formatCount(data.tag.trackCount)} tracks`
            : null,
          `${formatCount(data.tag.sourceCount)} sources`,
          data.children.length
            ? formatItemCount(data.children.length, {
                one: 'subtag',
                other: 'subtags',
              })
            : null,
          data.tag.hidden ? <Status state="paused">Hidden</Status> : null,
        ]}
        actions={
          <>
            <DetailActionsSpacer />
            <DetailMore
              crumb={{ title: formatTagName(data.tag.name) }}
              items={[
                {
                  label: `Browse ${library} with this tag`,
                  href: `/${library}?${new URLSearchParams({ filters: JSON.stringify([{ field: 'genre', value: data.tag.name }]) })}`,
                },
                ...(data.tag.mediaType === 'album'
                  ? [
                      {
                        label: 'Browse tracks with this tag',
                        href: `/tracks?${new URLSearchParams({ filters: JSON.stringify([{ field: 'trackTag', value: data.tag.name }]) })}`,
                      },
                    ]
                  : []),
              ]}
            />
          </>
        }
      />
      <DetailTabs
        label="Tag details"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          <Section title="Merged names" flush>
            {data.aliases.length ? (
              <Pills wrap label="Merged names">
                {data.aliases.map((alias) => (
                  <Pill key={alias.id} size="md" title={alias.kind}>
                    {alias.name}
                  </Pill>
                ))}
              </Pills>
            ) : (
              <p className="ds-help">No merged aliases.</p>
            )}
          </Section>
          <TagHierarchySections
            key={`hierarchy:${data.tag.id}`}
            detail={data}
          />
          <TagManagement key={data.tag.id} tag={data.tag} />
        </TabsContent>
        <TabsContent value="sources">
          <TagManagement key={data.tag.id} tag={data.tag} />
          <Section title="Detailed provenance" flush>
            <VirtualTagSources query={detail} label="Detailed provenance" />
          </Section>
        </TabsContent>
      </DetailTabs>
    </article>
  )
}

/**
 * Opens a tag in the shared detail drawer. Inside the app the tag joins the
 * drawer's history, so Back returns to the item it was opened from; without
 * the drawer's navigation it is shown in a drawer of its own.
 */
export default function TagDetailModal({
  id,
  mediaType,
  onClose,
}: {
  id: string
  mediaType: 'album' | 'film'
  onClose: () => void
}) {
  const nav = useDetailInspector()
  useEffect(() => {
    if (!nav) return
    nav.open({ kind: 'tag', id: tagDetailId(mediaType, id) })
    onClose()
  }, [nav, id, mediaType, onClose])
  useEffect(() => {
    if (nav) return
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [nav, onClose])
  if (nav) return null
  return (
    <>
      <div className="inspector-backdrop" onClick={onClose} />
      <MediaInspector
        aria-label="Tag details"
        onDismiss={onClose}
        headerClassName="ds-inspector-bar dtl-bar"
        header={
          <>
            <div className="dtl-bar-start">
              <div className="ds-crumbs">
                <b>Tag</b>
              </div>
            </div>
            <span className="dtl-bar-end">
              <Button
                variant="ghost"
                icon
                aria-label="Close tag details"
                onClick={onClose}
              >
                <X className="ds-i" aria-hidden="true" />
              </Button>
            </span>
          </>
        }
      >
        <div className="inspector-scroll dtl-body">
          <TagDetail id={id} mediaType={mediaType} />
        </div>
      </MediaInspector>
    </>
  )
}
