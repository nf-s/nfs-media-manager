'use client'

import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { Layers3 } from 'lucide-react'
import {
  formatTagName,
  TagProvenancePageSchema,
  type SourceNavigationLink,
} from '@repo/schemas/tags'
import { fetchApiData } from '@/utils/api'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'
import styles from './metadata-source-control.module.css'
import { VirtualTagSources } from './metadata-source-list'
import TagDetailModal from './tag-detail-modal'

function TagSources({
  mediaId,
  mediaType,
  name,
  tagId,
  onManage,
}: {
  mediaId?: string
  mediaType?: 'album' | 'film'
  name: string
  tagId?: string
  onManage: (id: string, mediaType: 'album' | 'film') => void
}) {
  const { apiBaseUrl } = useConfig()
  const query = useVirtualTable({
    queryKey: ['tag-provenance', mediaType, mediaId, name],
    pageSize: 25,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tags/provenance?${new URLSearchParams({ ...(mediaId ? { mediaId } : {}), ...(mediaType ? { mediaType } : {}), name, page: String(page), size: String(size) })}`,
        TagProvenancePageSchema,
        { signal },
      ),
  })
  const canonicalId = tagId ?? query.firstPage?.tagId
  const scope = query.firstPage?.mediaType ?? mediaType
  return (
    <>
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={query.retry}>
              Retry
            </Button>
          }
        >
          Could not load sources.
        </Notice>
      )}
      <VirtualTagSources query={query} label="Source links" linksOnly />
      <span>
        <Button
          size="xs"
          variant="link"
          disabled={!canonicalId || !scope}
          onClick={() => {
            if (canonicalId && scope) onManage(canonicalId, scope)
          }}
        >
          Manage tag
        </Button>
      </span>
    </>
  )
}

function SourcePopover({
  name,
  inPill = false,
  children,
}: {
  name: string
  /** The trigger is an action inside a pill, not a button beside a value. */
  inPill?: boolean
  children: ReactNode | ((close: () => void) => ReactNode)
}) {
  const id = useId()
  const titleId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    function position() {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      panel.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`
      panel.current.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - box.height - 8))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])
  const triggerProps = {
    type: 'button',
    ref: trigger,
    popoverTarget: id,
    'aria-label': `Sources for ${name}`,
    title: `Sources for ${name}`,
    'aria-expanded': open,
    'aria-controls': id,
    onClick: (event) => event.stopPropagation(),
    onDoubleClick: (event) => event.stopPropagation(),
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        event.stopPropagation()
        panel.current?.hidePopover()
      }
    },
  } satisfies ComponentProps<'button'>
  return (
    <>
      {inPill ? (
        <button {...triggerProps} className="browse-pill-action">
          <Layers3 className="ds-i" aria-hidden="true" />
        </button>
      ) : (
        <Button
          {...triggerProps}
          size="xs"
          variant="ghost"
          icon
          className={styles.control}
        >
          <Layers3 className="ds-i" data-size="sm" aria-hidden="true" />
        </Button>
      )}
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="region"
        tabIndex={-1}
        aria-labelledby={titleId}
        className={`ds-pop data-stack ${styles.panel}`}
        onToggle={(event) => setOpen(event.newState === 'open')}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            panel.current?.hidePopover()
            trigger.current?.focus()
          }
        }}
      >
        <div className="ds-section-head">
          <h3 id={titleId}>{name}</h3>
          <span className="ds-section-aside">
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Close sources for ${name}`}
              onClick={() => {
                panel.current?.hidePopover()
                trigger.current?.focus()
              }}
            >
              Close
            </Button>
          </span>
        </div>
        {open &&
          (typeof children === 'function'
            ? children(() => {
                panel.current?.hidePopover()
                trigger.current?.focus()
              })
            : children)}
      </div>
    </>
  )
}

export default function MetadataSourceControl({
  field,
  name,
  mediaId,
  mediaType,
  collectionSources = [],
  tagId,
  onManage,
  inPill = false,
}: {
  field: string
  name: string
  mediaId?: string
  mediaType?: 'album' | 'film'
  collectionSources?: SourceNavigationLink[]
  tagId?: string
  onManage?: (id: string) => void
  /** Renders the control as an action inside the tag's pill. */
  inPill?: boolean
}) {
  const [managed, setManaged] = useState<{
    id: string
    mediaType: 'album' | 'film'
  } | null>(null)
  if (field === 'collection') {
    const links = collectionSources.filter((source) => source.name === name)
    const single = links.length === 1 ? links[0] : undefined
    if (single)
      return (
        <ServiceIconLinks
          links={[
            {
              provider: single.provider,
              label: single.providerLabel,
              url: single.url,
            },
          ]}
        />
      )
    return (
      <SourcePopover name={name}>
        {links.length ? (
          <ul className="data-picker">
            {links.map((link) => (
              <li key={link.url}>
                <span className="ds-cell-id">
                  {link.providerLabel}
                  <ServiceIconLinks
                    links={[
                      {
                        provider: link.provider,
                        label: link.providerLabel,
                        url: link.url,
                      },
                    ]}
                  />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ds-muted">No source link was saved.</p>
        )}
      </SourcePopover>
    )
  }
  if ((field !== 'genre' && field !== 'keyword') || (!mediaId && !mediaType))
    return null
  return (
    <>
      <SourcePopover name={formatTagName(name)} inPill={inPill}>
        {(close) => (
          <TagSources
            mediaId={mediaId}
            mediaType={mediaType}
            name={name}
            tagId={tagId}
            onManage={(id, scope) => {
              close()
              if (onManage) onManage(id)
              else setManaged({ id, mediaType: scope })
            }}
          />
        )}
      </SourcePopover>
      {managed && (
        <TagDetailModal
          id={managed.id}
          mediaType={managed.mediaType}
          onClose={() => setManaged(null)}
        />
      )}
    </>
  )
}
