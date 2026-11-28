'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Check, History, X } from 'lucide-react'
import type { LibraryPlaylistLibrary } from '@repo/schemas/library-playlists'
import { Button, type ButtonFeedback } from '@repo/ui/components/ui/button'
import {
  TableSelectionBar,
  TableSelectionResult,
} from '@repo/ui/components/ui/table'
import { undoneResultText } from '@/utils/library-playlists'

/** A library playlist an action changed, for **Open playlist**. */
export type ResultPlaylist = { id: string; library: LibraryPlaylistLibrary }

/** What an action reports on the result line. */
export type ResultReport = {
  text: string
  /** Offers **Open playlist** for the playlist the action changed. */
  playlist?: ResultPlaylist
  /** Another way to follow the result, in place of Open playlist. */
  action?: { label: string; onSelect: () => void }
  /** Reverses the action; the line then reads "Undone: …". */
  undo?: () => Promise<unknown>
}

type Line = ResultReport & { key: number; undone: boolean }
type Host = { id: string; place: ResultLinePlace }
/**
 * `content` is the foot of a page's content; `panel` the foot of a drawer or
 * the detail inspector, which takes the line while it is open.
 */
export type ResultLinePlace = 'content' | 'panel'

const ReportContext = createContext<(report: ResultReport) => void>(() => {})
const LineContext = createContext<{
  line: Line | null
  active: string | undefined
  register: (host: Host) => () => void
  update: (key: number, next: Partial<Line>) => void
  dismiss: (key: number) => void
  openPlaylist?: (playlist: ResultPlaylist) => void
}>({
  line: null,
  active: undefined,
  register: () => () => {},
  update: () => {},
  dismiss: () => {},
})

/** Reports an action's result on the one result line. */
export const useReportResult = () => useContext(ReportContext)

/**
 * Holds the latest result line for the whole shell, so any surface can
 * report: Browse bars, row menus inside details, the player. The line is
 * drawn by the open drawer's or inspector's slot, else the page's.
 * `onOpenPlaylist` opens a library playlist; without it Open playlist is
 * left out.
 */
export function ResultLineProvider({
  children,
  onOpenPlaylist,
}: {
  children: ReactNode
  onOpenPlaylist?: (playlist: ResultPlaylist) => void
}) {
  const [line, setLine] = useState<Line | null>(null)
  const [hosts, setHosts] = useState<Host[]>([])
  const report = useCallback(
    (next: ResultReport) =>
      setLine((current) => ({
        ...next,
        key: (current?.key ?? 0) + 1,
        undone: false,
      })),
    [],
  )
  const register = useCallback((host: Host) => {
    setHosts((current) => [...current, host])
    return () =>
      setHosts((current) => current.filter((entry) => entry.id !== host.id))
  }, [])
  const update = useCallback(
    (key: number, next: Partial<Line>) =>
      setLine((current) =>
        current?.key === key ? { ...current, ...next } : current,
      ),
    [],
  )
  const dismiss = useCallback(
    (key: number) =>
      setLine((current) => (current?.key === key ? null : current)),
    [],
  )
  const panels = hosts.filter((host) => host.place === 'panel')
  const active = (panels.at(-1) ?? hosts.at(-1))?.id
  const value = useMemo(
    () => ({
      line,
      active,
      register,
      update,
      dismiss,
      openPlaylist: onOpenPlaylist,
    }),
    [line, active, register, update, dismiss, onOpenPlaylist],
  )
  return (
    <ReportContext.Provider value={report}>
      <LineContext.Provider value={value}>{children}</LineContext.Provider>
    </ReportContext.Provider>
  )
}

/**
 * Where the result line is drawn: at the foot of a page's content, in place
 * of its selection bar (`hidden` while that bar shows a selection), or at the
 * foot of a drawer or the inspector. One slot draws it at a time.
 */
export function ResultLineSlot({
  place,
  hidden = false,
}: {
  place: ResultLinePlace
  hidden?: boolean
}) {
  const id = useId()
  const { line, active, register, update, dismiss, openPlaylist } =
    useContext(LineContext)
  useEffect(() => register({ id, place }), [id, place, register])
  if (!line || hidden || active !== id) return null
  const { playlist } = line
  const follow = line.undone
    ? undefined
    : (line.action ??
      (playlist && openPlaylist
        ? { label: 'Open playlist', onSelect: () => openPlaylist(playlist) }
        : undefined))
  const undo = line.undone ? undefined : line.undo
  return (
    <ResultLineBar
      key={line.key}
      text={line.text}
      undone={line.undone}
      follow={follow}
      undo={
        undo &&
        (async () => {
          await undo()
          update(line.key, {
            undone: true,
            text: undoneResultText(line.text),
          })
        })
      }
      onDismiss={() => dismiss(line.key)}
    />
  )
}

/**
 * The result line: a tick (a history mark once undone), the text cut to one
 * line, then the follow-up action, Undo and Dismiss.
 */
export function ResultLineBar({
  text,
  undone,
  follow,
  undo,
  onDismiss,
}: {
  text: string
  undone: boolean
  follow?: { label: string; onSelect: () => void }
  undo?: () => Promise<void>
  onDismiss: () => void
}) {
  const [feedback, setFeedback] = useState<ButtonFeedback>()
  return (
    <TableSelectionBar className="sec-selectbar">
      <TableSelectionResult
        icon={
          undone ? (
            <History className="ds-i" data-size="sm" aria-hidden="true" />
          ) : (
            <Check className="ds-i" data-size="sm" aria-hidden="true" />
          )
        }
      >
        <span title={text}>{text}</span>
      </TableSelectionResult>
      <span className="ds-actions ds-toolbar-end">
        {follow && <Button onClick={follow.onSelect}>{follow.label}</Button>}
        {undo && (
          <Button
            feedback={feedback}
            disabled={feedback?.phase === 'pending'}
            onClick={async () => {
              setFeedback({ phase: 'pending', label: 'Undoing…' })
              try {
                await undo()
              } catch {
                setFeedback({ phase: 'failed', label: 'Undo failed · retry' })
              }
            }}
          >
            Undo
          </Button>
        )}
        <Button icon aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <X className="ds-i" aria-hidden="true" />
        </Button>
      </span>
    </TableSelectionBar>
  )
}
