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
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import { TagPicker } from './tag-picker'

type TrackTagEdit =
  | { kind: 'add'; tagId: string }
  | { kind: 'create'; name: string }
  | { kind: 'remove'; tagId: string }
  | { kind: 'reset' }

/**
 * Adds, removes and restores a track's own tags and resets them to
 * Sonovault's (TTAG-12). Refreshes the track, Browse and the tag pages after.
 */
export function useTrackTagEdits(trackId: string) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const path = `/api/v1/tracks/${encodeURIComponent(trackId)}/tags`
  const send = (method: 'POST' | 'DELETE', tagId: string) =>
    fetchApiData(apiBaseUrl, path, TrackTagChangeSchema, {
      method,
      body: JSON.stringify({ tagId }),
    })
  return useMutation({
    retry: false,
    mutationFn: async (edit: TrackTagEdit) => {
      switch (edit.kind) {
        case 'add':
          return send('POST', edit.tagId)
        case 'remove':
          return send('DELETE', edit.tagId)
        case 'create': {
          const created = await fetchApiData(
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
          return send('POST', created.id)
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
    onSettled: async () => {
      for (const queryKey of [
        ['track', trackId],
        ['tracks'],
        ['tags'],
        ['tag-detail'],
        ['tag-provenance'],
      ])
        await client.invalidateQueries({ queryKey })
    },
  })
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
        onPick={(tag) => edits.mutate({ kind: 'add', tagId: tag.id })}
        onCreate={(name) => edits.mutate({ kind: 'create', name })}
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
      {edits.isError && (
        <Notice tone="danger">
          {errorMessage(edits.error, 'Could not change the track’s tags.')}
        </Notice>
      )}
    </div>
  )
}
