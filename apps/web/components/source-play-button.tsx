'use client'

import { useRef, useState, type ReactNode } from 'react'
import { PlayHeaderButtons, PlayPair } from '@repo/ui/components/ds/play'
import type { ButtonFeedback } from '@repo/ui/components/ui/button'
import { formatCount } from '@repo/ui/lib/format'
import type { PlayableItem, PlaybackSource } from '@/utils/playback'
import { errorMessage } from './lastfm-sync'
import { usePlayback, usePlaybackControls } from './playback-provider'
import { queueButtonRequest, usePlaybackPair } from './playback-button-feedback'

/** Add to queue stops once this many tracks are queued. */
export const SOURCE_QUEUE_MAX = 500

type Action = 'play' | 'queue'

/**
 * Play and Add to queue for a list that is read when pressed, such as a
 * library playlist or a smart playlist's view: Play starts at the first
 * playable entry with the whole list as its source, Add to queue queues the
 * list's tracks in order up to `SOURCE_QUEUE_MAX`. `compact` is the row pair
 * (with `more` after it); otherwise the labelled buttons of a detail header.
 */
export function SourcePlayButton({
  title,
  feedbackKey,
  count,
  emptyReason,
  loadSource,
  compact = true,
  more,
}: {
  title: string
  /** Names the pair's playback feedback, unique to the list. */
  feedbackKey: string
  /** The list's length when known; none disables the pair. */
  count?: number
  /** Why the pair is disabled when the list is empty: "No tracks." */
  emptyReason: string
  loadSource: () => Promise<PlaybackSource>
  compact?: boolean
  more?: ReactNode
}) {
  const view = usePlayback()
  const controls = usePlaybackControls()
  const playback = usePlaybackPair(feedbackKey)
  const loadingActions = useRef(new Set<Action>())
  const [loading, setLoading] = useState<Record<Action, boolean>>({
    play: false,
    queue: false,
  })
  const [error, setError] = useState('')
  const [failedAction, setFailedAction] = useState<Action | null>(null)
  const hasEntries = count === undefined || count > 0
  async function play(action: Action) {
    if (loadingActions.current.has(action)) return
    loadingActions.current.add(action)
    setLoading((current) => ({ ...current, [action]: true }))
    setError('')
    setFailedAction(null)
    try {
      const source = await loadSource()
      const queued: PlayableItem[] = []
      for (let index = 0; index < source.length; index += 1) {
        const items = await source.load(index)
        if (action === 'queue') {
          queued.push(...items)
          if (queued.length >= SOURCE_QUEUE_MAX) break
          continue
        }
        const [first] = items
        if (!first) continue
        playback.start(first, false, () =>
          controls.play(first, { ...source, startIndex: index }),
        )
        return
      }
      const queue = queued.slice(0, SOURCE_QUEUE_MAX)
      if (queue.length) {
        playback.queue.run(
          queueButtonRequest(
            (next, previous) =>
              next.queue.filter(
                (item) => !previous.queue.some(({ key }) => key === item.key),
              ).length >= queue.length,
            `${formatCount(queue.length)} queued in app`,
            'Adding to queue…',
          ),
          () => queue.forEach((item) => controls.enqueue(item)),
        )
      } else {
        setFailedAction(action)
        setError('No playable tracks.')
      }
    } catch (error) {
      setFailedAction(action)
      setError(errorMessage(error, 'Could not load tracks.'))
    } finally {
      loadingActions.current.delete(action)
      setLoading((current) => ({ ...current, [action]: false }))
    }
  }
  function feedback(action: Action): ButtonFeedback | undefined {
    if (loading[action]) return { phase: 'pending', label: 'Loading tracks…' }
    if (failedAction === action)
      return {
        phase: 'failed',
        label:
          error === 'No playable tracks.'
            ? 'No playable tracks'
            : 'Load failed · retry',
      }
    return playback[action].feedback
  }
  const pair = {
    title,
    disabled: !hasEntries || !view.enabled,
    disabledReason: !hasEntries
      ? emptyReason
      : !view.enabled
        ? 'Connect Spotify playback in the player.'
        : undefined,
    playDisabled: loading.play || playback.play.pending,
    queueDisabled: loading.queue,
    playFeedback: feedback('play'),
    queueFeedback: feedback('queue'),
    onPlay: () => void play('play'),
    onQueue: () => void play('queue'),
  }
  return (
    <>
      {compact ? (
        <PlayPair place="row" {...pair} more={more} />
      ) : (
        <PlayHeaderButtons {...pair} />
      )}
      {error && error !== 'No playable tracks.' && (
        <span role="alert" className="ds-muted">
          {error}
        </span>
      )}
    </>
  )
}
