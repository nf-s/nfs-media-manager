'use client'

import { useEffect, useState } from 'react'
import { cn } from '@repo/ui/lib/utils'

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
  const [hasImageError, setHasImageError] = useState(false)

  useEffect(() => {
    setHasImageError(false)
  }, [src])

  if (!src || hasImageError) {
    return (
      <div
        className={cn(
          'overflow-hidden bg-[hsl(var(--muted))]',
          containerClassName,
        )}
      >
        <div
          className={cn(
            'flex items-center justify-center text-xs text-[hsl(var(--muted-foreground))]',
            fallbackClassName,
          )}
        >
          {fallbackLabel}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'overflow-hidden bg-[hsl(var(--muted))]',
        containerClassName,
      )}
    >
      <img
        src={src}
        loading="lazy"
        decoding="async"
        alt={alt}
        className={imageClassName}
        onError={() => setHasImageError(true)}
      />
    </div>
  )
}
