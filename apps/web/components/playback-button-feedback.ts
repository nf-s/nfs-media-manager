'use client'

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from 'react'
import type { ButtonFeedback } from '@repo/ui/components/ui/button'
import type { PlaybackState } from '@/utils/playback-engine'
import { playbackReportsTrack, type PlayableItem } from '@/utils/playback'

type PlaybackCommand = {
  pending: string
  unconfirmedLabel?: string
  lane?: string
  repeated?: boolean
  observe: (
    next: PlaybackState,
    previous: PlaybackState,
  ) => ButtonFeedback | undefined
}

type PendingCommand = {
  before: PlaybackState
  request: PlaybackCommand
}

const waitForReport = 12_000
const receiptDuration = 3500
const noFeedback = () => undefined
const noSubscription = () => () => undefined

export function createPlaybackButtonFeedback() {
  let state: PlaybackState | undefined
  const feedback = new Map<string, ButtonFeedback>()
  const listeners = new Map<string, Set<() => void>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const commands = new Map<string, PendingCommand>()

  function publish(key: string, next: ButtonFeedback | undefined) {
    const previous = feedback.get(key)
    if (previous?.phase === next?.phase && previous?.label === next?.label)
      return
    if (next) feedback.set(key, next)
    else feedback.delete(key)
    for (const listen of listeners.get(key) ?? []) listen()
  }

  function clearTimer(key: string) {
    const timer = timers.get(key)
    if (timer) clearTimeout(timer)
    timers.delete(key)
  }

  function finish(key: string, next: ButtonFeedback) {
    commands.delete(key)
    clearTimer(key)
    publish(key, next)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        publish(key, undefined)
      }, receiptDuration),
    )
  }

  return {
    needsObservation: () =>
      [...commands.values()].some(({ request }) => Boolean(request.lane)),
    get(key: string) {
      return feedback.get(key)
    },
    subscribe(key: string, listener: () => void) {
      const subscribers = listeners.get(key) ?? new Set<() => void>()
      listeners.set(key, subscribers)
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
        if (!subscribers.size) listeners.delete(key)
      }
    },
    run(
      key: string,
      request: PlaybackCommand,
      command: () => void | Promise<void>,
    ) {
      if (!state) {
        void command()
        return
      }
      if (!request.repeated && commands.has(key)) return
      if (request.lane) {
        for (const [otherKey, other] of commands)
          if (otherKey !== key && other.request.lane === request.lane)
            finish(otherKey, {
              phase: 'cancelled',
              label: 'Replaced by a newer command',
            })
      }
      const operation = { before: state, request }
      commands.set(key, operation)
      clearTimer(key)
      publish(key, { phase: 'pending', label: request.pending })
      timers.set(
        key,
        setTimeout(() => {
          finish(key, {
            phase: 'unconfirmed',
            label: request.unconfirmedLabel ?? 'Result unconfirmed',
          })
        }, waitForReport),
      )
      function error() {
        if (commands.get(key) === operation)
          finish(key, { phase: 'failed', label: 'Command failed' })
      }
      try {
        const sent = command()
        if (sent) void sent.catch(error)
      } catch {
        error()
      }
    },
    observe(next: PlaybackState) {
      state = next
      for (const [key, { before, request }] of commands) {
        const result = request.observe(next, before)
        if (result) {
          if (
            result.phase === 'running' ||
            result.phase === 'waiting' ||
            result.phase === 'queued'
          )
            publish(key, result)
          else finish(key, result)
        } else if (
          next.failure &&
          next.failure !== before.failure &&
          request.lane
        ) {
          finish(key, { phase: 'failed', label: 'Device command failed' })
        }
      }
    },
    clear() {
      for (const key of timers.keys()) clearTimer(key)
      commands.clear()
      for (const key of feedback.keys()) publish(key, undefined)
      state = undefined
    },
  }
}

export const PlaybackButtonFeedbackContext = createContext<ReturnType<
  typeof createPlaybackButtonFeedback
> | null>(null)

export function usePlaybackCommand(key: string) {
  const store = useContext(PlaybackButtonFeedbackContext)
  const subscribe = useCallback(
    (listener: () => void) =>
      store?.subscribe(key, listener) ?? noSubscription(),
    [key, store],
  )
  const read = useCallback(() => store?.get(key), [key, store])
  const feedback = useSyncExternalStore(subscribe, read, noFeedback)
  return {
    feedback,
    pending:
      feedback?.phase === 'pending' ||
      feedback?.phase === 'running' ||
      feedback?.phase === 'waiting',
    run: (request: PlaybackCommand, command: () => void | Promise<void>) =>
      store ? store.run(key, request, command) : void command(),
  }
}

export function playButtonRequest(
  item: PlayableItem,
  pause = false,
): PlaybackCommand {
  return {
    pending: pause ? 'Pausing…' : 'Starting…',
    lane: 'transport',
    observe(next, previous) {
      const snapshot = next.observation?.snapshot
      const expected =
        item.kind === 'track' || item.startUri
          ? snapshot &&
            playbackReportsTrack(snapshot, item.startUri ?? item.uri)
          : next.current?.uri === item.uri ||
            snapshot?.contextUri === item.uri ||
            snapshot?.albumUri === item.uri
      if (
        snapshot &&
        expected &&
        snapshot.paused === pause &&
        next.observation !== previous.observation &&
        !next.starting
      )
        return { phase: 'done', label: pause ? 'Paused' : 'Playing' }
      if (
        !pause &&
        next.current?.uri === item.uri &&
        next.starting &&
        next.startAccepted
      )
        return { phase: 'running', label: 'Accepted · waiting for device' }
      return undefined
    },
  }
}

export function playbackItemFeedbackKey(item: PlayableItem | null) {
  if (!item) return ''
  return item.kind === 'album' && item.albumId && !item.startUri
    ? `album:${item.albumId}`
    : (item.startUri ?? item.uri)
}

export function usePlaybackPair(playKey: string, queueKey = playKey) {
  const play = usePlaybackCommand(`play:${playKey}`)
  const queue = usePlaybackCommand(`queue:${queueKey}`)
  return {
    play,
    queue,
    buttons: {
      playFeedback: play.feedback,
      queueFeedback: queue.feedback,
      playDisabled: play.pending,
    },
    start: (item: PlayableItem, pause: boolean, send: () => void) =>
      play.run(playButtonRequest(item, pause), send),
    enqueue: (item: PlayableItem, send: () => void) =>
      queue.run(
        queueButtonRequest(
          (next, previous) => {
            const keys = new Set(previous.queue.map(({ key }) => key))
            return next.queue.some(
              ({ key, item: queued }) =>
                queued.uri === item.uri && !keys.has(key),
            )
          },
          'Queued in app',
          'Adding to queue…',
        ),
        send,
      ),
  }
}

export function queueButtonRequest(
  changed: (next: PlaybackState, previous: PlaybackState) => boolean,
  done: string,
  pending = 'Updating queue…',
): PlaybackCommand {
  return {
    pending,
    repeated: true,
    observe(next, previous) {
      if (!changed(next, previous)) return undefined
      return next.queueSync === 'pending'
        ? { phase: 'running', label: `${done} · syncing…` }
        : next.queueSync === 'unconfirmed'
          ? { phase: 'unconfirmed', label: `${done} · sync unconfirmed` }
          : { phase: 'done', label: done }
    },
  }
}
