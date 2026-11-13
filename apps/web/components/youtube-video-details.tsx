'use client'

import { forwardRef } from 'react'
import { X } from 'lucide-react'
import {
  youtubeChannelUrl,
  youtubeThumbnailUrl,
  youtubeVideoUrl,
  type YoutubeVideo,
} from '@repo/schemas/youtube'
import ExternalLink from './external-link'
import MediaArtwork from './media-artwork'
import { ChannelAvatar } from './youtube-channels'
import { formatCount, youtubeDurationLabel } from '@/utils/youtube'
import styles from './youtube-videos.module.css'

export function VideoThumbnail({
  video,
  className,
}: {
  video: YoutubeVideo
  className?: string
}) {
  return (
    <a
      className={`${styles.thumb} ${className ?? ''}`}
      href={youtubeVideoUrl(video.id)}
      target="_blank"
      rel="noreferrer"
      tabIndex={-1}
      aria-hidden="true"
    >
      <MediaArtwork
        src={youtubeThumbnailUrl(video.id)}
        alt=""
        fallbackLabel=""
        containerClassName={styles.fill}
        imageClassName={styles.thumbImage ?? ''}
        fallbackClassName={styles.thumbImage ?? ''}
      />
      <span className={styles.badge}>{youtubeDurationLabel(video)}</span>
    </a>
  )
}

/** Drawer over the results from the right; a bottom sheet on phones. */
export const YoutubeVideoDetails = forwardRef<
  HTMLElement,
  {
    video: YoutubeVideo
    onClose: () => void
    onChannel: (channelId: string) => void
  }
>(function YoutubeVideoDetails({ video, onClose, onChannel }, ref) {
  return (
    <>
      <div className="inspector-backdrop" onClick={onClose} />
      <aside
        ref={ref}
        tabIndex={-1}
        aria-label="Video details"
        className="media-inspector"
      >
        <div className="detail-topbar">
          <ExternalLink href={youtubeVideoUrl(video.id)}>
            Watch on YouTube
          </ExternalLink>
          <button aria-label="Close details" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="inspector-scroll">
          <article className={styles.details}>
            <VideoThumbnail video={video} className={styles.detailThumb} />
            <h1 className={styles.detailTitle}>{video.title}</h1>
            <div className={styles.detailChannel}>
              <ChannelAvatar src={video.channelThumbnailUrl} size="large" />
              <ExternalLink href={youtubeChannelUrl(video.channelId)}>
                {video.channelTitle}
              </ExternalLink>
              <button
                type="button"
                className="metadata-tag"
                onClick={() => onChannel(video.channelId)}
              >
                Filter to channel
              </button>
            </div>
            <dl className="detail-metrics">
              <div>
                <dt>Published</dt>
                <dd>
                  <time dateTime={video.publishedAt}>
                    {new Date(video.publishedAt).toLocaleString()}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{youtubeDurationLabel(video)}</dd>
              </div>
              <div>
                <dt>Views</dt>
                <dd>{formatCount(video.viewCount)}</dd>
              </div>
              <div>
                <dt>Likes</dt>
                <dd>{formatCount(video.likeCount)}</dd>
              </div>
              <div>
                <dt>Comments</dt>
                <dd>{formatCount(video.commentCount)}</dd>
              </div>
            </dl>
            {video.description && (
              <p className={styles.description}>{video.description}</p>
            )}
          </article>
        </div>
      </aside>
    </>
  )
})
