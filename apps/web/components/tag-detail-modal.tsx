'use client'

import { useDeferredValue, useEffect, useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { TagDetailSchema, TagPageSchema, type Tag } from '@repo/schemas/tags'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Pill, Pills } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { TableBody, TableCell, TableRow } from '@repo/ui/components/ui/table'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import { formatCount } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { tagDetailId } from '@/utils/detail-inspector'
import { CreatorDetailState } from './creator-detail-state'
import { useDetailInspector } from './detail-inspector-context'
import { DetailTabs, useDetailTab } from './detail-frame'
import { MediaInspector } from './media-inspector'
import { VirtualTagSources } from './metadata-source-list'
import { SecondaryTableScroll, SecondaryVirtualRows } from './secondary-table'
import TagActions from './tag-actions'

type TagTab = 'overview' | 'sources'
const tagTabs: readonly [TagTab, ...TagTab[]] = ['overview', 'sources']

function TagManagement({ tag }: { tag: Tag }) {
  const { apiBaseUrl } = useConfig()
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim())
  const [candidate, setCandidate] = useState<Tag | null>(null)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<{
    message: string
    interrupted: boolean
  } | null>(null)
  const matches = useVirtualTable({
    queryKey: ['tags', 'merge-search', tag.mediaType, query],
    enabled: query.length > 0 && !candidate && !pending,
    pageSize: 25,
    headerHeight: 0,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tags?${new URLSearchParams({ mediaType: tag.mediaType, q: query, visibility: 'all', page: String(page), size: String(size) })}`,
        TagPageSchema,
        { signal },
      ),
  })
  return (
    <Section title="Manage tag">
      <p className="ds-help">
        {tag.hidden
          ? 'Hidden from normal browsing. Unhide to restore it.'
          : 'Hiding removes this tag from normal browsing, not its source data.'}
      </p>
      <label className="ds-field">
        <span className="ds-label">Find another tag to merge</span>
        <Input
          aria-label="Find tag to merge"
          placeholder="Search tags..."
          value={search}
          maxLength={200}
          disabled={pending}
          onChange={(event) => {
            setSearch(event.target.value)
            setCandidate(null)
          }}
        />
      </label>
      {query && !candidate && !pending && (
        <>
          {matches.isError && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={matches.retry}>
                  Retry
                </Button>
              }
            >
              Could not find tags.
            </Notice>
          )}
          <SecondaryTableScroll
            ref={matches.scroller}
            onScroll={matches.onScroll}
            className="dtl-matches"
            role="region"
            aria-label="Tags to merge"
            aria-busy={matches.isFetching}
          >
            <table
              className="ds-table"
              aria-label="Tags to merge"
              aria-rowcount={matches.hasTotal ? matches.total : undefined}
            >
              <TableBody>
                {matches.hasTotal && !matches.total && (
                  <TableRow>
                    <TableCell className="ds-muted">
                      No matching tags.
                    </TableCell>
                  </TableRow>
                )}
                <SecondaryVirtualRows
                  window={matches}
                  colSpan={1}
                  renderRow={(item, index) => (
                    <TableRow key={item.id} aria-rowindex={index + 1}>
                      <TableCell>
                        <Button
                          variant="link"
                          size="xs"
                          disabled={pending || item.id === tag.id}
                          onClick={() => setCandidate(item)}
                        >
                          {item.name}
                          {item.hidden ? ' (hidden)' : ''}
                          {item.id === tag.id ? ' (current tag)' : ''}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )}
                />
              </TableBody>
            </table>
          </SecondaryTableScroll>
        </>
      )}
      {candidate && (
        <p className="ds-actions">
          <span>
            Merge with: <strong>{candidate.name}</strong>
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
          setSearch('')
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
        title={data.tag.name}
        by={data.tag.mediaType === 'album' ? 'Album tag' : 'Film tag'}
        facts={[
          `${formatCount(data.tag.mediaCount)} items`,
          `${formatCount(data.tag.sourceCount)} sources`,
          data.tag.hidden ? <Status state="paused">Hidden</Status> : null,
        ]}
        actions={
          <>
            <Button asChild size="md">
              <Link
                href={`/${library}?${new URLSearchParams({ filters: JSON.stringify([{ field: 'genre', value: data.tag.name }]) })}`}
              >
                Browse {library} with this tag
              </Link>
            </Button>
            <DetailActionsSpacer />
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
          <TagManagement key={data.tag.id} tag={data.tag} />
        </TabsContent>
        <TabsContent value="sources">
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
