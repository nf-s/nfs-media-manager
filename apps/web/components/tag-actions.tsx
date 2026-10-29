'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  MergeTagsResultSchema,
  SetTagVisibilityResultSchema,
  type Tag,
} from '@repo/schemas/tags'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  dispatchTagVisibility,
  invalidateTags,
  tagSelectionMediaType,
} from '@/utils/tag-actions'

export default function TagActions({
  tags,
  onComplete,
  onPendingChange,
}: {
  tags: Tag[]
  onComplete: (ids: string[], message: string, interrupted: boolean) => void
  onPendingChange?: (pending: boolean) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [targetId, setTargetId] = useState('')
  const [confirming, setConfirming] = useState(false)
  const target = tags.find((tag) => tag.id === targetId)
  const mediaType = tagSelectionMediaType(tags)
  const merge = useMutation({
    mutationFn: () => {
      if (!mediaType) throw new Error('Select tags from one library')
      return fetchApiData(
        apiBaseUrl,
        '/api/v1/tags/merge',
        MergeTagsResultSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            targetId,
            mediaType,
            sourceIds: tags
              .filter((tag) => tag.id !== targetId)
              .map((tag) => tag.id),
          }),
        },
      )
    },
    onMutate: () => onPendingChange?.(true),
    onSuccess: async () => {
      setConfirming(false)
      await invalidateTags(client)
      onComplete(
        tags.map((tag) => tag.id),
        'Tags merged. Original names and sources retained.',
        false,
      )
    },
    onSettled: () => onPendingChange?.(false),
  })
  const visibility = useMutation({
    mutationFn: (hidden: boolean) => {
      if (!mediaType) throw new Error('Select tags from one library')
      return dispatchTagVisibility(
        tags.filter((tag) => tag.hidden !== hidden).map((tag) => tag.id),
        (tagIds) =>
          fetchApiData(
            apiBaseUrl,
            '/api/v1/tags/visibility',
            SetTagVisibilityResultSchema,
            {
              method: 'POST',
              body: JSON.stringify({ mediaType, tagIds, hidden }),
            },
          ),
      )
    },
    onMutate: () => onPendingChange?.(true),
    onSuccess: async (result, hidden) => {
      const message = result.interrupted
        ? `${result.completed.length} tags updated. Stopped because the next batch could not be confirmed. Check the refreshed list before retrying.`
        : `${result.completed.length} tags ${hidden ? 'hidden' : 'unhidden'}.`
      await invalidateTags(client)
      onComplete(result.completed, message, result.interrupted)
    },
    onSettled: () => onPendingChange?.(false),
  })
  const pending = merge.isPending || visibility.isPending
  return (
    <div className="space-y-2" aria-label="Tag management">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !mediaType || !tags.some((tag) => !tag.hidden)}
          onClick={() => visibility.mutate(true)}
        >
          Hide
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !mediaType || !tags.some((tag) => tag.hidden)}
          onClick={() => visibility.mutate(false)}
        >
          Unhide
        </Button>
        {tags.length > 1 && (
          <>
            <select
              aria-label="Tag name to keep"
              className="h-7 max-w-64 border px-2 text-xs"
              value={target?.id ?? ''}
              disabled={pending}
              onChange={(event) => {
                setTargetId(event.target.value)
                setConfirming(false)
                merge.reset()
              }}
            >
              <option value="">Choose name to keep...</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!target || !mediaType || tags.length > 101 || pending}
              onClick={() => setConfirming(true)}
            >
              Review merge
            </Button>
          </>
        )}
      </div>
      {tags.length > 101 && (
        <p className="quiet text-xs">
          Merge supports up to 101 tags at a time. Hide and unhide apply to the
          entire selection.
        </p>
      )}
      {confirming && target && (
        <div
          className="space-y-2 text-sm"
          role="group"
          aria-label="Confirm tag merge"
        >
          <p>
            Merge {tags.length - 1} tags into <strong>{target.name}</strong> in
            the {mediaType === 'album' ? 'album' : 'film'} library only?
            Original names and sources are retained; future imports use this
            name.{' '}
            {tags.some((tag) => tag.hidden) &&
              'The merged tag will stay hidden until explicitly unhidden.'}
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => merge.mutate()}>
              {merge.isPending ? 'Merging...' : 'Confirm merge'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {pending && (
        <p role="status" className="quiet text-xs">
          Updating tags...
        </p>
      )}
      {merge.isError && <p role="alert">{merge.error.message}</p>}
      {visibility.isError && <p role="alert">{visibility.error.message}</p>}
    </div>
  )
}
