'use client'

import { forwardRef } from 'react'
import { X } from 'lucide-react'
import type { BrowseFilter } from '@repo/schemas/browse'
import {
  subscriptionSourceUrl,
  subscriptionTypeLabels,
  type SubscriptionItem,
} from '@repo/schemas/subscriptions'
import ExternalLink from './external-link'
import MediaArtwork from './media-artwork'
import { formatCount } from '@/utils/youtube'
import {
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  subscriptionArtworkUrl,
  subscriptionOpenLabel,
  subscriptionTypeFilter,
} from '@/utils/subscriptions'
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

type DetailsProps = {
  /** Undefined while a directly linked item outside the loaded rows is read. */
  item: SubscriptionItem | undefined
  error: string | null
  onRetry: () => void
  onClose: () => void
  onFilter: (filter: BrowseFilter) => void
}

/** Drawer over the results from the right; a bottom sheet on phones. */
export const SubscriptionItemDetails = forwardRef<HTMLElement, DetailsProps>(
  function SubscriptionItemDetails(
    { item, error, onRetry, onClose, onFilter },
    ref,
  ) {
    return (
      <>
        <div className="inspector-backdrop" onClick={onClose} />
        <aside
          ref={ref}
          tabIndex={-1}
          aria-label={
            item?.type === 'spotify' ? 'Episode details' : 'Video details'
          }
          className="media-inspector"
        >
          <div className="detail-topbar">
            {item ? (
              <ExternalLink href={item.url}>
                {subscriptionOpenLabel(item.type)}
              </ExternalLink>
            ) : (
              <span />
            )}
            <button aria-label="Close details" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          <div className="inspector-scroll">
            {item ? (
              <ItemDetails item={item} onFilter={onFilter} />
            ) : error ? (
              <p className="browse-empty" role="alert">
                {error}{' '}
                <button type="button" className="underline" onClick={onRetry}>
                  Retry
                </button>
              </p>
            ) : (
              <p className="browse-empty" role="status">
                Loading...
              </p>
            )}
          </div>
        </aside>
      </>
    )
  },
)

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
      <a
        className={styles.detailThumb}
        href={item.url}
        target="_blank"
        rel="noreferrer"
        tabIndex={-1}
        aria-hidden="true"
      >
        <SubscriptionThumbnail item={item} />
      </a>
      <h1 className={styles.detailTitle}>{item.title}</h1>
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
        <ExternalLink href={subscriptionSourceUrl(item.type, item.sourceId)}>
          {item.type === 'youtube' ? 'Channel on YouTube' : 'Show on Spotify'}
        </ExternalLink>
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
