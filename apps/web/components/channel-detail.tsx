'use client'

import Link from 'next/link'
import {
  SubscriptionSourceDetailSchema,
  subscriptionTypeLabels,
  type SubscriptionItem,
} from '@repo/schemas/subscriptions'
import { Button } from '@repo/ui/components/ui/button'
import { useSubscriptionSource } from '@/hooks/useSubscriptionSource'
import {
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  formatSubscriptionSourceSize,
  subscriptionSourceHref,
} from '@/utils/subscriptions'
import { CreatorDetailState } from './creator-detail-state'
import {
  CreatorLibraryTable,
  CreatorLibraryTitle,
  type CreatorLibraryColumn,
} from './creator-library-table'
import ServiceIconLinks from './service-icon-links'
import { SourceAvatar } from './subscription-item-details'

const itemPageSchema = SubscriptionSourceDetailSchema.transform(
  ({ items }) => items,
)
const itemColumns: CreatorLibraryColumn<SubscriptionItem>[] = [
  {
    key: 'title',
    label: 'Title',
    required: true,
    render: (item) => (
      <CreatorLibraryTitle
        kind="subscription"
        id={item.id}
        title={item.title}
      />
    ),
  },
  {
    key: 'publishedAt',
    label: 'Published',
    className: 'whitespace-nowrap',
    render: (item) => (
      <time dateTime={item.publishedAt}>
        {formatSubscriptionPublished(item.publishedAt, item.publishedPrecision)}
      </time>
    ),
  },
  {
    key: 'durationSec',
    label: 'Duration',
    className: 'numeric',
    render: formatSubscriptionDuration,
  },
]
const videoColumns: CreatorLibraryColumn<SubscriptionItem>[] = [
  ...itemColumns,
  {
    key: 'viewCount',
    label: 'Views',
    className: 'numeric',
    render: (item) =>
      item.type === 'youtube' ? (item.viewCount?.toLocaleString() ?? '-') : '-',
  },
]

export function ChannelDetail({ id }: { id: string }) {
  const path = `/api/v1/subscriptions/sources/${encodeURIComponent(id)}`
  const query = useSubscriptionSource(id)
  if (!query.data)
    return (
      <CreatorDetailState
        pending={query.isPending}
        retry={query.refetch}
        subject="channel"
      />
    )
  const { source } = query.data
  const isVideo = source.type === 'youtube'
  return (
    <article className="media-detail">
      {query.isRefetchError && (
        <CreatorDetailState stale retry={query.refetch} subject="channel" />
      )}
      <header className="mb-4">
        <div className="flex items-start gap-3">
          <SourceAvatar src={source.thumbnailUrl} size="large" />
          <div className="min-w-0">
            <h1 className="break-words text-xl font-semibold">
              {source.title}{' '}
              <ServiceIconLinks
                links={[
                  {
                    provider: source.type,
                    label: isVideo ? 'YouTube channel' : 'Spotify show',
                    url: source.url,
                  },
                ]}
              />
            </h1>
            <div className="detail-facts mt-1">
              <span>{subscriptionTypeLabels[source.type]}</span>
              {source.type === 'youtube' && source.handle && (
                <span>{source.handle}</span>
              )}
              <span>{formatSubscriptionSourceSize(source)}</span>
              {!source.historyComplete && <span>Reading history</span>}
            </div>
          </div>
        </div>
        {source.description && (
          <p className="detail-summary mt-3 whitespace-pre-line break-words">
            {source.description}
          </p>
        )}
        <div className="form-actions mt-2">
          <Button asChild variant="outline" size="sm">
            <Link href={subscriptionSourceHref(source.id)}>
              Filter subscriptions
            </Link>
          </Button>
        </div>
      </header>
      <CreatorLibraryTable
        kind="subscription"
        queryKey={['subscriptions', 'source', id, 'items']}
        path={path}
        schema={itemPageSchema}
        columns={isVideo ? videoColumns : itemColumns}
        label={isVideo ? 'videos' : 'episodes'}
        defaultSort={{ key: 'publishedAt', direction: 'desc' }}
      />
    </article>
  )
}
