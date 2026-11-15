'use client'

import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import type { BrowseFilter } from '@repo/schemas/browse'
import {
  subscriptionSourceUrl,
  SubscriptionItemSchema,
  subscriptionTypeLabels,
  type SubscriptionItem,
} from '@repo/schemas/subscriptions'
import ServiceIconLinks from './service-icon-links'
import MediaArtwork from './media-artwork'
import { formatCount } from '@/utils/youtube'
import {
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  subscriptionArtworkUrl,
  subscriptionsHref,
  subscriptionTypeFilter,
} from '@/utils/subscriptions'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import styles from './subscription-browser.module.css'

export function SourceAvatar({
  src,
  size = 'small',
}: {
  src: string | null
  size?: 'small' | 'large'
}) {
  return (
    <MediaArtwork
      src={src}
      alt=""
      fallbackLabel=""
      containerClassName={`${styles.avatar} ${size === 'large' ? styles.avatarLarge : ''}`}
      imageClassName={styles.avatarImage ?? ''}
      fallbackClassName={styles.avatarImage ?? ''}
    />
  )
}

/** A 16:9 frame with the video thumbnail or episode artwork; badges show the type and the length or live state. */
export function SubscriptionThumbnail({
  item,
  badges = true,
}: {
  item: SubscriptionItem
  badges?: boolean
}) {
  const duration = formatSubscriptionDuration(item)
  return (
    <span className={styles.thumb}>
      <MediaArtwork
        src={subscriptionArtworkUrl(item)}
        alt=""
        fallbackLabel=""
        containerClassName={styles.fill}
        imageClassName={
          (item.type === 'spotify' ? styles.thumbContain : styles.thumbImage) ??
          ''
        }
        fallbackClassName={styles.thumbImage ?? ''}
      />
      {badges && (
        <span className={styles.typeLabel}>
          {subscriptionTypeLabels[item.type]}
        </span>
      )}
      {badges && duration !== '-' && (
        <span className={styles.badge}>{duration}</span>
      )}
    </span>
  )
}

export function SubscriptionItemDetails({
  id,
  initialItem,
  onFilter,
}: {
  id: string
  initialItem?: SubscriptionItem
  onFilter?: (filter: BrowseFilter) => void
}) {
  const { apiBaseUrl } = useConfig()
  const router = useRouter()
  const query = useQuery({
    queryKey: ['subscriptions', 'item', id],
    initialData: initialItem,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/subscriptions/${encodeURIComponent(id)}`,
        SubscriptionItemSchema,
        { signal },
      ),
  })
  if (query.data)
    return (
      <ItemDetails
        item={query.data}
        onFilter={
          onFilter ?? ((filter) => router.push(subscriptionsHref([filter])))
        }
      />
    )
  if (query.isError)
    return (
      <p className="browse-empty" role="alert">
        Could not load this item.{' '}
        <button
          type="button"
          className="underline"
          onClick={() => query.refetch()}
        >
          Retry
        </button>
      </p>
    )
  return (
    <p className="browse-empty" role="status">
      Loading...
    </p>
  )
}

function ItemDetails({
  item,
  onFilter,
}: {
  item: SubscriptionItem
  onFilter: (filter: BrowseFilter) => void
}) {
  const typeLabel = subscriptionTypeLabels[item.type]
  return (
    <article className={styles.details}>
      <div className={styles.detailThumb}>
        <SubscriptionThumbnail item={item} />
      </div>
      <h1 className={styles.detailTitle}>
        {item.title}{' '}
        <ServiceIconLinks
          links={[
            {
              provider: item.type,
              label: item.type === 'youtube' ? 'YouTube' : 'Spotify',
              url: item.url,
            },
          ]}
        />
      </h1>
      <div className={styles.detailChannel}>
        <SourceAvatar src={item.sourceThumbnailUrl} size="large" />
        <button
          type="button"
          className="metadata-tag"
          title={`Filter Channel: ${item.sourceTitle}`}
          onClick={() => onFilter({ field: 'source', value: item.sourceTitle })}
        >
          {item.sourceTitle}
        </button>
        <ServiceIconLinks
          links={[
            {
              provider: item.type,
              label:
                item.type === 'youtube' ? 'YouTube channel' : 'Spotify show',
              url: subscriptionSourceUrl(item.type, item.sourceId),
            },
          ]}
        />
      </div>
      <dl className="detail-metrics">
        <div>
          <dt>Type</dt>
          <dd>
            <button
              type="button"
              className="metadata-tag"
              title={`Filter Type: ${typeLabel}`}
              onClick={() => onFilter(subscriptionTypeFilter(item.type))}
            >
              {typeLabel}
            </button>
          </dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>
            <time dateTime={item.publishedAt}>
              {formatSubscriptionPublished(
                item.publishedAt,
                item.publishedPrecision,
                { detail: true },
              )}
            </time>
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatSubscriptionDuration(item)}</dd>
        </div>
        {item.type === 'youtube' && (
          <>
            <div>
              <dt>Views</dt>
              <dd>{formatCount(item.viewCount)}</dd>
            </div>
            <div>
              <dt>Likes</dt>
              <dd>{formatCount(item.likeCount)}</dd>
            </div>
            <div>
              <dt>Comments</dt>
              <dd>{formatCount(item.commentCount)}</dd>
            </div>
          </>
        )}
      </dl>
      {item.tags.length > 0 && (
        <div
          className={`detail-tags ${styles.detailTags}`}
          aria-label="Tags"
          role="group"
        >
          {item.tags.map((tag) => (
            <button
              type="button"
              key={tag}
              className="metadata-tag"
              title={`Filter Tags: ${tag}`}
              onClick={() => onFilter({ field: 'genre', value: tag })}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {item.description && (
        <p className={styles.description}>{item.description}</p>
      )}
    </article>
  )
}
