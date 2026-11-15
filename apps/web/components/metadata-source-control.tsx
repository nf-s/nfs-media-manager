'use client'

import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Layers3 } from 'lucide-react'
import {
  TagProvenancePageSchema,
  type SourceNavigationLink,
} from '@repo/schemas/tags'
import { fetchApiData } from '@/utils/api'
import { useVirtualTable } from '@/hooks/useVirtualTable'
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
        <p role="alert">
          Could not load sources.{' '}
          <button type="button" onClick={query.retry} className="underline">
            Retry
          </button>
        </p>
      )}
      <VirtualTagSources query={query} label="Source links" linksOnly />
      <div className="mt-3 border-t pt-2">
        <button
          type="button"
          className="text-xs underline disabled:opacity-50"
          disabled={!canonicalId || !scope}
          onClick={() => {
            if (canonicalId && scope) onManage(canonicalId, scope)
          }}
        >
          Manage tag
        </button>
      </div>
    </>
  )
}

function SourcePopover({
  name,
  children,
}: {
  name: string
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
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={styles.control}
        popoverTarget={id}
        aria-label={`Sources for ${name}`}
        title={`Sources for ${name}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ')
            event.stopPropagation()
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            panel.current?.hidePopover()
          }
        }}
      >
        <Layers3 size={12} aria-hidden="true" />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="region"
        tabIndex={-1}
        aria-labelledby={titleId}
        className={styles.panel}
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
        <div className="mb-2 flex items-start justify-between gap-3">
          <h3 id={titleId} className="break-words font-semibold">
            {name}
          </h3>
          <button
            type="button"
            className="quiet text-xs"
            aria-label={`Close sources for ${name}`}
            onClick={() => {
              panel.current?.hidePopover()
              trigger.current?.focus()
            }}
          >
            Close
          </button>
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
}: {
  field: string
  name: string
  mediaId?: string
  mediaType?: 'album' | 'film'
  collectionSources?: SourceNavigationLink[]
  tagId?: string
  onManage?: (id: string) => void
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
          <ul className={styles.sources}>
            {links.map((link) => (
              <li key={link.url}>
                <span className="inline-flex items-center gap-1">
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
          <p className="quiet">No source link was saved.</p>
        )}
      </SourcePopover>
    )
  }
  if ((field !== 'genre' && field !== 'keyword') || (!mediaId && !mediaType))
    return null
  return (
    <>
      <SourcePopover name={name}>
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
