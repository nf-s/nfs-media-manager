'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Film, Disc3, ListMusic, Music, User, Video } from 'lucide-react'
import {
  Art,
  ArtFallback,
  Thumb,
  type ArtRatio,
} from '@repo/ui/components/ds/artwork'
import { cn } from '@repo/ui/lib/utils'

export type ArtworkKind =
  | 'album'
  | 'film'
  | 'track'
  | 'artist'
  | 'person'
  | 'video'
  | 'playlist'

const ratios: Record<ArtworkKind, ArtRatio | undefined> = {
  album: undefined,
  track: undefined,
  playlist: undefined,
  film: 'poster',
  video: 'video',
  artist: 'round',
  person: 'round',
}

/** The artwork shape the design system draws for each kind of item. */
export function artworkRatio(kind: ArtworkKind): ArtRatio | undefined {
  return ratios[kind]
}

/** The neutral placeholder glyph for an item without artwork. */
export function ArtworkIcon({ kind }: { kind: ArtworkKind }) {
  const props = { className: 'ds-i', 'aria-hidden': true }
  switch (kind) {
    case 'film':
      return <Film {...props} />
    case 'track':
      return <Music {...props} />
    case 'artist':
    case 'person':
      return <User {...props} />
    case 'video':
      return <Video {...props} />
    case 'playlist':
      return <ListMusic {...props} />
    default:
      return <Disc3 {...props} />
  }
}

/** The image, or nothing once it has failed to load. */
function useArtworkSource(src: string | null | undefined) {
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => setFailed(null), [src])
  return {
    src: src && failed !== src ? src : null,
    onError: () => setFailed(src ?? null),
  }
}

/**
 * Card and header artwork. The shape follows `kind`; a missing or broken
 * image shows the kind's placeholder glyph.
 */
export function MediaArt({
  kind,
  src,
  alt = '',
  size,
  badge,
  overlay,
  className,
  children,
}: {
  kind: ArtworkKind
  src: string | null | undefined
  alt?: string
  size?: 'sm'
  badge?: ReactNode
  overlay?: ReactNode
  className?: string
  /** Wraps the image, for example in a link that opens the item. */
  children?: (image: ReactNode) => ReactNode
}) {
  const image = useArtworkSource(src)
  const content = image.src ? (
    <img
      className="ds-artimg"
      src={image.src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={image.onError}
    />
  ) : (
    <ArtFallback>
      <ArtworkIcon kind={kind} />
    </ArtFallback>
  )
  return (
    <Art
      ratio={artworkRatio(kind)}
      size={size}
      badge={badge}
      overlay={overlay}
      className={className}
    >
      {children ? children(content) : content}
    </Art>
  )
}

/** Row and table artwork: 24px, or `size` px (40 in a list row). */
export function MediaThumb({
  kind,
  src,
  alt = '',
  size,
  className,
}: {
  kind: ArtworkKind
  src: string | null | undefined
  alt?: string
  size?: number
  className?: string
}) {
  const image = useArtworkSource(src)
  return (
    <Thumb ratio={artworkRatio(kind)} size={size} className={className}>
      {image.src ? (
        <img
          className="ds-artimg"
          src={image.src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={image.onError}
        />
      ) : (
        <ArtworkIcon kind={kind} />
      )}
    </Thumb>
  )
}

export default function MediaArtwork({
  alt,
  src,
  fallbackLabel,
  containerClassName,
  imageClassName,
  fallbackClassName,
}: {
  alt: string
  src: string | null | undefined
  fallbackLabel: string
  containerClassName?: string
  imageClassName: string
  fallbackClassName: string
}) {
  const image = useArtworkSource(src)
  return (
    <div className={cn('browse-artwork', containerClassName)}>
      {image.src ? (
        <img
          src={image.src}
          loading="lazy"
          decoding="async"
          alt={alt}
          className={imageClassName}
          onError={image.onError}
        />
      ) : (
        <div className={cn('browse-artwork-fallback', fallbackClassName)}>
          {fallbackLabel}
        </div>
      )}
    </div>
  )
}
