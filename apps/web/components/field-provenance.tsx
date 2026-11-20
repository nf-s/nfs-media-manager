'use client'

import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { JsonValue } from '@repo/schemas/common'
import {
  MediaProvenanceSchema,
  type FieldSource,
  type MediaFieldProvenance,
} from '@repo/schemas/provenance'
import { Skeleton, State } from '@repo/ui/components/ds/feedback'
import {
  EmptyValue,
  Pill,
  Pills,
  ProviderMark,
} from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'
import { formatAge, formatDateTime } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import {
  fieldUpdatedAt,
  formatFieldValue,
  orderedFieldSources,
  providerLabel,
} from '@/utils/field-provenance'
import { providerLogoUrl } from '@/utils/provider-logos'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { useDetailView } from './detail-inspector-context'
import { useSourceCatalog } from './provider-sources'
import { useConfig } from './providers'
import { useTableWidths } from './secondary-table'

type Label = (provider: string) => string

/** Fits the 600px detail inspector; the value takes any room left. */
const fieldColumns = [
  { key: 'field', label: 'Field', width: 130 },
  { key: 'value', label: 'Value', width: 160, fill: true },
  { key: 'source', label: 'Source', width: 170 },
  { key: 'updated', label: 'Updated', width: 100 },
]

/** Stored fields of an album or film with the providers that supply them. */
export function useMediaProvenance(mediaItemId: string, enabled = true) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    // Under `history` so saving the item or its identifiers refreshes it.
    queryKey: ['history', mediaItemId, 'provenance'],
    enabled,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/media/${encodeURIComponent(mediaItemId)}/provenance`,
        MediaProvenanceSchema,
        { signal },
      ),
  })
}

function FieldValue({ value }: { value: JsonValue }) {
  const formatted = formatFieldValue(value)
  if (formatted.kind === 'empty') return <EmptyValue />
  if (formatted.kind === 'list')
    return (
      <Pills max={3}>
        {formatted.items.map((item, index) => (
          <Pill key={`${index}:${item}`} title={item}>
            {item}
          </Pill>
        ))}
      </Pills>
    )
  return (
    <span
      className={formatted.kind === 'text' ? undefined : 'ds-mono'}
      title={formatted.text}
    >
      {formatted.text}
    </span>
  )
}

function sourceTitle(source: FieldSource, label: Label) {
  const value = formatFieldValue(source.value)
  return [
    label(source.provider),
    source.scrapedAt ? formatDateTime(source.scrapedAt) : null,
    source.matchesCurrent
      ? 'matches the stored value'
      : `supplies ${value.kind === 'empty' ? 'no value' : value.kind === 'list' ? value.items.join(', ') : value.text}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function FieldSources({
  field,
  label,
  providerHref,
}: {
  field: MediaFieldProvenance
  label: Label
  providerHref: (provider: string) => string
}) {
  const sources = orderedFieldSources(field.sources)
  const matching = sources.filter((source) => source.matchesCurrent)
  const differing = sources.filter((source) => !source.matchesCurrent)
  if (!sources.length && !field.override) return <EmptyValue />
  return (
    <span className="ds-cell-id">
      {field.override && (
        <Pill
          tone="outline"
          title={`Edited ${formatDateTime(field.override.at)}${field.override.note ? ` · ${field.override.note}` : ''}`}
        >
          Edited
        </Pill>
      )}
      {matching.map((source) => (
        <span
          key={source.provider}
          title={sourceTitle(source, label)}
          {...workspaceTabLinkProps(
            providerHref(source.provider),
            label(source.provider),
          )}
          tabIndex={0}
        >
          <ProviderMark
            name={label(source.provider)}
            src={providerLogoUrl(source.provider)}
            hidden
          />
          <span className="sr-only">{sourceTitle(source, label)}</span>
        </span>
      ))}
      {differing.length > 0 && (
        <span
          className="ds-muted"
          title={differing
            .map((source) => sourceTitle(source, label))
            .join('\n')}
        >
          {matching.length || field.override
            ? `+${differing.length} differs`
            : `${differing.length} ${differing.length === 1 ? 'provider differs' : 'providers differ'}`}
          <span className="sr-only">
            : {differing.map((source) => sourceTitle(source, label)).join('; ')}
          </span>
        </span>
      )}
    </span>
  )
}

/** Every stored field of an album or film with the providers that supply it. */
export function FieldProvenance({
  mediaItemId,
  focusedField,
}: {
  mediaItemId: string
  focusedField?: string | null
}) {
  const provenance = useMediaProvenance(mediaItemId)
  const view = useDetailView()
  const catalog = useSourceCatalog()
  const label: Label = (provider) => providerLabel(provider, catalog.data)
  const widths = useTableWidths('field-provenance', fieldColumns)
  const data = provenance.data
  const focusedRow = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    focusedRow.current?.scrollIntoView({ block: 'nearest' })
  }, [data, focusedField])
  function providerHref(provider: string) {
    const params = new URLSearchParams(view.params)
    params.set('tab', 'sources')
    params.set('sourceProvider', provider)
    params.set('sourceMode', 'history')
    params.delete('sourceSnapshot')
    return view.workspaceHref(params)
  }
  if (!data) {
    if (provenance.isError)
      return (
        <State
          title="Could not load fields"
          error
          size="sm"
          action={
            <Button size="xs" onClick={() => provenance.refetch()}>
              Retry
            </Button>
          }
        />
      )
    return (
      <div className="data-stack" role="status" aria-busy="true">
        <span className="sr-only">Loading fields</span>
        <Skeleton height={28} />
        <Skeleton height={32} />
        <Skeleton height={32} />
      </div>
    )
  }
  if (!data.fields.length) return <State title="No stored fields" size="sm" />
  const layout = widths.layout(fieldColumns.map((column) => column.key))
  return (
    <Table aria-label="All fields" {...layout.table}>
      {layout.colgroup}
      <TableHeader>
        <TableRow>
          <TableHead sticky={0} stickyEdge resizer={widths.resizer('field')}>
            Field
          </TableHead>
          <TableHead resizer={widths.resizer('value')}>Value</TableHead>
          <TableHead resizer={widths.resizer('source')}>Source</TableHead>
          <TableHead resizer={widths.resizer('updated')}>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.fields.map((field) => {
          const updated = fieldUpdatedAt(field)
          return (
            <TableRow
              key={field.key}
              ref={field.key === focusedField ? focusedRow : undefined}
            >
              <TableCell sticky={0} stickyEdge className="ds-muted">
                <span title={field.label}>{field.label}</span>
              </TableCell>
              <TableCell>
                <FieldValue value={field.value} />
              </TableCell>
              <TableCell>
                <FieldSources
                  field={field}
                  label={label}
                  providerHref={providerHref}
                />
              </TableCell>
              <TableCell className="ds-muted">
                {updated ? (
                  <time dateTime={updated} title={formatDateTime(updated)}>
                    {formatAge(updated)}
                  </time>
                ) : (
                  <EmptyValue />
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
