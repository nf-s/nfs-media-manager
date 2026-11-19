'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  formatTagName,
  MergeTagsResultSchema,
  SetTagVisibilityResultSchema,
  type Tag,
} from '@repo/schemas/tags'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import {
  dispatchTagBatches,
  invalidateTags,
  tagSelectionMediaType,
} from '@/utils/tag-actions'

export default function TagActions({
  tags,
  parentsOpen = false,
  onParentsToggle,
  onComplete,
  onPendingChange,
}: {
  tags: Tag[]
  /** Offers parent tag changes for the selection; the caller shows the form. */
  parentsOpen?: boolean
  onParentsToggle?: () => void
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
      return dispatchTagBatches(
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
    <div className="dtl-stack" aria-label="Tag management">
      <div className="ds-actions dtl-wrap">
        <Button
          disabled={pending || !mediaType || !tags.some((tag) => !tag.hidden)}
          onClick={() => visibility.mutate(true)}
        >
          Hide
        </Button>
        <Button
          disabled={pending || !mediaType || !tags.some((tag) => tag.hidden)}
          onClick={() => visibility.mutate(false)}
        >
          Unhide
        </Button>
        {tags.length > 1 && (
          <>
            <Select
              aria-label="Tag name to keep"
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
                  {formatTagName(tag.name)}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              disabled={!target || !mediaType || tags.length > 101 || pending}
              onClick={() => setConfirming(true)}
            >
              Review merge
            </Button>
          </>
        )}
        {onParentsToggle && (
          <Button
            aria-expanded={parentsOpen}
            disabled={pending}
            onClick={onParentsToggle}
          >
            Parent tags
          </Button>
        )}
      </div>
      {tags.length > 101 && (
        <p className="ds-help">
          Merge supports up to 101 tags at a time. Hide and unhide apply to the
          entire selection.
        </p>
      )}
      {confirming && target && (
        <div className="dtl-stack" role="group" aria-label="Confirm tag merge">
          <p>
            Merge {tags.length - 1} tags into{' '}
            <strong>{formatTagName(target.name)}</strong> in the{' '}
            {mediaType === 'album' ? 'album' : 'film'} library only? Original
            names and sources are retained; future imports use this name.{' '}
            {tags.some((tag) => tag.hidden) &&
              'The merged tag will stay hidden until explicitly unhidden.'}
          </p>
          <div className="ds-actions">
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => merge.mutate()}
            >
              {merge.isPending ? 'Merging...' : 'Confirm merge'}
            </Button>
            <Button disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {pending && (
        <p role="status" className="ds-help">
          Updating tags...
        </p>
      )}
      {merge.isError && <Notice tone="danger">{merge.error.message}</Notice>}
      {visibility.isError && (
        <Notice tone="danger">{visibility.error.message}</Notice>
      )}
    </div>
  )
}
