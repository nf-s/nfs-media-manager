'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  formatTagName,
  SetTagParentsResultSchema,
  type SetTagParentsInput,
  type Tag,
} from '@repo/schemas/tags'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { formatItemCount } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import { TagPicker } from './tag-picker'
import { fetchApiData } from '@/utils/api'
import {
  dispatchTagParents,
  invalidateTags,
  tagSelectionMediaType,
} from '@/utils/tag-actions'

const TAGS = { one: 'tag', other: 'tags' }
const SELECTED = { one: 'selected tag', other: 'selected tags' }

/**
 * Sets the parents of tags, 100 tags per request. Stops at the first failed
 * request and reports the server's message; refreshes tag data afterwards.
 */
export function useSetTagParents() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (input: SetTagParentsInput) => {
      const result = await dispatchTagParents(input, (body) =>
        fetchApiData(
          apiBaseUrl,
          '/api/v1/tags/parents',
          SetTagParentsResultSchema,
          { method: 'POST', body: JSON.stringify(body) },
        ),
      )
      if (result.completed.length) await invalidateTags(client)
      return {
        completed: result.completed,
        interrupted: result.interrupted,
        message: result.interrupted
          ? errorMessage(result.error, 'Could not update parent tags.')
          : null,
      }
    },
  })
}

/** Parent tag changes for the tags selected in the All tags table. */
export default function TagParentActions({
  tags,
  disabled = false,
  onComplete,
  onPendingChange,
}: {
  tags: Tag[]
  disabled?: boolean
  onComplete: (ids: string[], message: string, interrupted: boolean) => void
  onPendingChange?: (pending: boolean) => void
}) {
  const [parent, setParent] = useState<Tag | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const mediaType = tagSelectionMediaType(tags)
  const parents = useSetTagParents()
  const pending = parents.isPending
  const selectedIds = tags.map((tag) => tag.id)
  function run(mode: SetTagParentsInput['mode'], target: Tag | null) {
    if (!mediaType) return
    setFailure(null)
    onPendingChange?.(true)
    parents.mutate(
      {
        mediaType,
        tagIds: selectedIds,
        parentIds: target ? [target.id] : [],
        mode,
      },
      {
        onSuccess: (result) => {
          const updated = formatItemCount(result.completed.length, TAGS)
          if (result.interrupted) {
            setFailure(result.message)
            onComplete(
              result.completed,
              `${updated} updated. Stopped: ${result.message ?? 'Could not update parent tags.'}`,
              true,
            )
            return
          }
          setParent(null)
          onComplete(
            result.completed,
            mode === 'add' && target
              ? `Added parent ${formatTagName(target.name)} to ${updated}.`
              : target
                ? `Moved ${updated} under ${formatTagName(target.name)}.`
                : `Removed parents from ${updated}.`,
            false,
          )
        },
        onSettled: () => onPendingChange?.(false),
      },
    )
  }
  const busy = disabled || pending || !mediaType
  return (
    <div className="dtl-stack" role="group" aria-label="Parent tags">
      {parent ? (
        <p className="ds-actions">
          <span>
            Parent tag: <strong>{formatTagName(parent.name)}</strong>
          </span>
          <Button
            variant="link"
            size="xs"
            disabled={busy}
            onClick={() => setParent(null)}
          >
            Remove
          </Button>
        </p>
      ) : (
        mediaType && (
          <TagPicker
            mediaType={mediaType}
            label={`Parent tag for ${formatItemCount(tags.length, SELECTED)}`}
            inputLabel="Find parent tag"
            listLabel="Tags to choose as parent"
            disabled={busy}
            unavailable={(tag) =>
              selectedIds.includes(tag.id) ? 'selected' : null
            }
            onPick={setParent}
          />
        )
      )}
      <div className="ds-actions dtl-wrap">
        <Button disabled={busy || !parent} onClick={() => run('add', parent)}>
          Add parent
        </Button>
        <Button
          disabled={busy || !parent}
          onClick={() => run('replace', parent)}
        >
          Move under
        </Button>
        <Button
          disabled={busy || !tags.some((tag) => tag.parents.length > 0)}
          onClick={() => run('replace', null)}
        >
          Remove all parents
        </Button>
      </div>
      {failure && <Notice tone="danger">{failure}</Notice>}
      {parents.isError && (
        <Notice tone="danger">
          {errorMessage(parents.error, 'Could not update parent tags.')}
        </Notice>
      )}
    </div>
  )
}
