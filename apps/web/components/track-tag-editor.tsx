'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CreateTagResultSchema } from '@repo/schemas/tags'
import {
  TrackTagChangeSchema,
  TrackTagResetSchema,
  type TrackTagGroups,
} from '@repo/schemas/tracks'
import { Notice } from '@repo/ui/components/ds/feedback'
import {
  Button,
  mutationFeedback,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import { TagPicker } from './tag-picker'

type TrackTagEdit =
  | { kind: 'add' | 'restore'; tagId: string; name: string }
  | { kind: 'create'; name: string }
  | { kind: 'remove'; tagId: string; name: string }
  | { kind: 'reset' }

/**
 * Adds, removes and restores a track's own tags and resets them to
 * Sonovault's (TTAG-12). Refreshes the track, Browse and the tag pages after.
 */
export function useTrackTagEdits(trackId: string) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  )
  const path = `/api/v1/tracks/${encodeURIComponent(trackId)}/tags`
  const send = (method: 'POST' | 'DELETE', tagId: string) =>
    fetchApiData(apiBaseUrl, path, TrackTagChangeSchema, {
      method,
      body: JSON.stringify({ tagId }),
    })
  const editTag = useMutation({
    retry: false,
    mutationFn: async (edit: TrackTagEdit) => {
      switch (edit.kind) {
        case 'add':
        case 'restore':
          return send('POST', edit.tagId)
        case 'remove':
          return send('DELETE', edit.tagId)
        case 'create': {
          if (created?.name === edit.name) return send('POST', created.id)
          const tag = await fetchApiData(
            apiBaseUrl,
            '/api/v1/tags',
            CreateTagResultSchema,
            {
              method: 'POST',
              body: JSON.stringify({
                mediaType: 'album',
                name: edit.name,
                parentIds: [],
              }),
            },
          )
          setCreated({ id: tag.id, name: edit.name })
          return send('POST', tag.id)
        }
        case 'reset':
          return fetchApiData(
            apiBaseUrl,
            `${path}/reset`,
            TrackTagResetSchema,
            { method: 'POST' },
          )
      }
    },
    onSuccess: () => setCreated(null),
    onSettled: () => {
      for (const queryKey of [
        ['track', trackId],
        ['tracks'],
        ['tags'],
        ['tag-detail'],
        ['tag-provenance'],
      ])
        void client.invalidateQueries({ queryKey })
    },
  })
  const matchingCreated =
    editTag.variables?.kind === 'create' &&
    created?.name === editTag.variables.name
  const feedback: ButtonFeedback | undefined =
    matchingCreated && editTag.isPending
      ? { phase: 'pending', label: 'Tag created · attaching…' }
      : matchingCreated && editTag.isError
        ? { phase: 'partial', label: 'Tag created · retry attachment' }
        : mutationFeedback(
            editTag,
            editTag.variables?.kind === 'remove'
              ? {
                  pending: 'Removing tag…',
                  success: 'Tag removed',
                  error: 'Could not remove tag',
                }
              : editTag.variables?.kind === 'reset'
                ? {
                    pending: 'Resetting tags…',
                    success: 'Tags reset',
                    error: 'Could not reset tags',
                  }
                : editTag.variables?.kind === 'create'
                  ? {
                      pending: 'Creating tag…',
                      success: 'Tag added',
                      error: 'Could not create tag',
                    }
                  : editTag.variables?.kind === 'restore'
                    ? {
                        pending: 'Restoring tag…',
                        success: 'Tag restored',
                        error: 'Could not restore tag',
                      }
                    : {
                        pending: 'Adding tag…',
                        success: 'Tag added',
                        error: 'Could not add tag',
                      },
          )
  return {
    ...editTag,
    feedback,
    retryAttachment: matchingCreated && editTag.isError ? created : null,
  }
}

export function TrackTagEditReceipt({
  edits,
}: {
  edits: ReturnType<typeof useTrackTagEdits>
}) {
  return edits.isError ? (
    <Notice
      tone="danger"
      action={
        edits.retryAttachment && (
          <Button
            feedback={edits.feedback}
            onClick={() => {
              if (edits.retryAttachment)
                edits.mutate({
                  kind: 'create',
                  name: edits.retryAttachment.name,
                })
            }}
          >
            Retry attachment
          </Button>
        )
      }
    >
      {errorMessage(edits.error, 'Could not change the track’s tags.')}
    </Notice>
  ) : null
}

/** The Edit tags controls under a track's own tags. */
export function TrackTagEditor({
  tags,
  edits,
}: {
  tags: TrackTagGroups
  edits: ReturnType<typeof useTrackTagEdits>
}) {
  const [confirmReset, setConfirmReset] = useState(false)
  const own = new Set(tags.own.map((tag) => tag.id))
  const ownerChanges =
    tags.own.some((tag) => tag.added) || tags.removed.length > 0
  return (
    <div className="dtl-stack">
      <TagPicker
        mediaType="album"
        label="Add a tag"
        inputLabel="Find a tag to add"
        listLabel="Tags to add"
        disabled={edits.isPending}
        unavailable={(tag) => (own.has(tag.id) ? 'on this track' : null)}
        onPick={(tag) =>
          edits.mutate({ kind: 'add', tagId: tag.id, name: tag.name })
        }
        onCreate={(name) => edits.mutate({ kind: 'create', name })}
        pickFeedback={(tag) =>
          !edits.isSuccess &&
          edits.variables?.kind === 'add' &&
          edits.variables.tagId === tag.id
            ? edits.feedback
            : undefined
        }
        createFeedback={(name) =>
          !edits.isSuccess &&
          edits.variables?.kind === 'create' &&
          edits.variables.name === name
            ? edits.feedback
            : undefined
        }
      />
      {ownerChanges &&
        (confirmReset ? (
          <div className="dtl-stack">
            <p className="ds-help">
              Your added and removed tags on this track are cleared.
              Sonovault&rsquo;s tags stay.
            </p>
            <span className="ds-actions">
              <Button
                variant="danger"
                size="xs"
                disabled={edits.isPending}
                feedback={
                  !edits.isSuccess && edits.variables?.kind === 'reset'
                    ? edits.feedback
                    : undefined
                }
                onClick={() =>
                  edits.mutate(
                    { kind: 'reset' },
                    { onSettled: () => setConfirmReset(false) },
                  )
                }
              >
                Reset
              </Button>
              <Button size="xs" onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
            </span>
          </div>
        ) : (
          <span>
            <Button
              size="xs"
              disabled={edits.isPending}
              onClick={() => setConfirmReset(true)}
            >
              Reset to Sonovault
            </Button>
          </span>
        ))}
    </div>
  )
}
