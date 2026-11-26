'use client'

import { ReadButton } from '@/components/read-button'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useVirtualRows, useVirtualTable } from '@/hooks/useVirtualTable'
import {
  libraryAdditionUnavailable,
  saveLibraryAddition,
  useLibraryAddition,
} from '@/hooks/use-library-addition'
import {
  skipToken,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { X } from 'lucide-react'
import {
  ManualMediaSearchInputSchema,
  ManualMediaSearchResultSchema,
  type ManualMediaSearchInput,
  type ManualMediaSearchItem,
  type ManualMediaSearchResult,
} from '@repo/schemas/manual-add'
import { SPOTIFY_TRACK_SEARCH_LIMIT } from '@repo/schemas/spotify-track-search'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { fetchApiData } from '@/utils/api'
import {
  addManualMediaItem,
  describeSearchItem,
  loadManualSearchPage,
  invalidateManualMediaAddition,
  manualMediaAdditionsKey,
  orderSearchItems,
  rememberManualMediaAddition,
  type ManualMediaAdditions,
} from '@/utils/manual-media-add'
import { useAnnounceLibraryAddition, useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import { MediaThumb } from './media-artwork'
import ServiceIconLinks from './service-icon-links'
import { DetailLink } from './detail-link'

/** One result row: the 48px list row with its bottom border. */
const RESULT_ROW_HEIGHT = 49

const searchFields = {
  album: { provider: 'Spotify', placeholder: 'Album or artist', pageSize: 10 },
  film: { provider: 'TMDb', placeholder: 'Film title', pageSize: 20 },
  track: {
    provider: 'Spotify',
    placeholder: 'Track or artist',
    pageSize: SPOTIFY_TRACK_SEARCH_LIMIT,
  },
}

function manualAdditionTarget(
  kind: ManualMediaSearchInput['mediaType'],
  item: ManualMediaSearchItem,
) {
  return {
    kind,
    catalogId: item.catalogMediaItemId,
    externalId: item.externalId,
  }
}

function ManualResultAdd({
  kind,
  item,
  saved,
  disabled,
  onAdd,
}: {
  kind: ManualMediaSearchInput['mediaType']
  item: ManualMediaSearchItem
  saved: boolean
  disabled: boolean
  onAdd: () => void
}) {
  const client = useQueryClient()
  const target = manualAdditionTarget(kind, item)
  const receipt = useLibraryAddition(target, Boolean(item.mediaItemId))
  return (
    <LibraryAction
      kind={kind}
      name={item.title}
      short
      saved={saved || Boolean(receipt?.committedId)}
      disabled={disabled}
      feedback={receipt?.feedback}
      receiptId={receipt?.committedId}
      onAdd={() => {
        if (!libraryAdditionUnavailable(client, target)) onAdd()
      }}
    />
  )
}

export function ManualMediaSearch({
  mediaType,
  initialQuery = '',
  onAdded,
  existingActionLabel = 'Open',
  disabled = false,
  onPendingChange,
  autoSearch = false,
  initialResult,
  onSearchResult,
  onChoose,
  tracksPlayed,
}: {
  mediaType: ManualMediaSearchInput['mediaType']
  initialQuery?: string
  onAdded: (id: string) => void | Promise<void>
  existingActionLabel?: string
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
  autoSearch?: boolean
  initialResult?: ManualMediaSearchResult
  onSearchResult?: (query: string, result: ManualMediaSearchResult) => void
  onChoose?: (item: ManualMediaSearchItem) => void
  /**
   * How many different tracks were played from the album being looked for.
   * Results with fewer tracks say so and are listed last.
   */
  tracksPlayed?: number
}) {
  const { apiBaseUrl } = useConfig()
  const announceAddition = useAnnounceLibraryAddition()
  const client = useQueryClient()
  const [query, setQuery] = useState(initialQuery.slice(0, 200))
  const automaticallySearched = useRef(false)
  const [showInitialResult, setShowInitialResult] = useState(true)
  const [lastResult, setLastResult] = useState<ManualMediaSearchResult>()
  const { provider, placeholder } = searchFields[mediaType]
  const inputId = useId()
  const additionKey = ['manual-add-panel', inputId]
  const openAddedFor = useRef<string | null>(null)
  const isLinking = Boolean(onChoose) || existingActionLabel !== 'Open'
  const exactMembership = isLinking ? undefined : true
  const { data: additions } = useQuery<ManualMediaAdditions>({
    queryKey: manualMediaAdditionsKey(mediaType),
    queryFn: skipToken,
  })
  const search = useMutation({
    retry: false,
    mutationFn: (input: ManualMediaSearchInput) =>
      client.fetchQuery({
        queryKey: [
          'manual-media-search',
          input.mediaType,
          input.q,
          input.page ?? 1,
          input.exactMembership ?? false,
        ],
        staleTime: 0,
        retry: false,
        queryFn: () =>
          fetchApiData(
            apiBaseUrl,
            '/api/v1/manual-add/search',
            ManualMediaSearchResultSchema,
            {
              method: 'POST',
              body: JSON.stringify(ManualMediaSearchInputSchema.parse(input)),
            },
          ),
      }),
    onSuccess: (result, input) => {
      setLastResult(result)
      onSearchResult?.(input.q, result)
    },
  })
  function libraryIdFor(item: ManualMediaSearchItem) {
    const added = additions?.get(item.externalId)
    return (
      item.mediaItemId ??
      (added && added.addedAt >= search.submittedAt ? added.id : undefined)
    )
  }
  const add = useMutation({
    mutationKey: additionKey,
    retry: false,
    mutationFn: async (item: ManualMediaSearchItem) => {
      let id = libraryIdFor(item)
      if (!id) {
        id = await saveLibraryAddition(
          client,
          manualAdditionTarget(mediaType, item),
          () => addManualMediaItem(apiBaseUrl, mediaType, item),
        )
        rememberManualMediaAddition(client, mediaType, item.externalId, id)
        announceAddition(
          mediaType,
          item.title,
          isLinking || openAddedFor.current === item.externalId
            ? undefined
            : id,
        )
        void invalidateManualMediaAddition(client, mediaType)
      }
      if (isLinking || openAddedFor.current === item.externalId)
        await onAdded(id)
    },
  })
  const adding = useIsMutating({ mutationKey: additionKey, exact: true }) > 0
  function choose(item: ManualMediaSearchItem) {
    openAddedFor.current = item.externalId
    add.mutate(item)
  }
  const found =
    search.data ?? lastResult ?? (showInitialResult ? initialResult : undefined)
  const result = useMemo(
    () =>
      found && { ...found, items: orderSearchItems(found.items, tracksPlayed) },
    [found, tracksPlayed],
  )
  const liveSearch = search.isSuccess && result?.page === 1
  const { mutate: searchMedia } = search
  useEffect(() => {
    if (
      !autoSearch ||
      disabled ||
      initialResult ||
      automaticallySearched.current ||
      !initialQuery.trim()
    )
      return
    automaticallySearched.current = true
    searchMedia({
      mediaType,
      q: initialQuery.trim().slice(0, 200),
      page: 1,
      exactMembership,
    })
  }, [
    autoSearch,
    disabled,
    exactMembership,
    initialQuery,
    initialResult,
    mediaType,
    searchMedia,
  ])
  const busy = disabled || search.isPending || (isLinking && adding)
  useEffect(() => {
    onPendingChange?.(adding)
  }, [adding, onPendingChange])

  const [searchControl, setSearchControl] = useState<
    'search' | 'previous' | 'next'
  >('search')
  const noMatches =
    search.data?.items.length === 0 &&
    !search.data.totalCount &&
    !search.data.hasMore &&
    search.data.page === 1
  const searchFeedback = mutationFeedback(search, {
    pending:
      searchControl === 'search'
        ? result
          ? 'Searching… · previous results shown'
          : 'Searching…'
        : result
          ? 'Loading page… · previous results shown'
          : 'Loading page…',
    success: noMatches
      ? 'No matches'
      : searchControl === 'search'
        ? 'Results loaded'
        : `Page ${search.data?.page ?? 1} loaded`,
    error: 'Search failed · retry',
  })

  function find(page = 1, control: typeof searchControl = 'search') {
    if (busy || !query.trim()) return
    openAddedFor.current = null
    add.reset()
    setShowInitialResult(false)
    setSearchControl(control)
    search.mutate({
      mediaType,
      q: query.trim(),
      page,
      exactMembership,
    })
  }

  return (
    <div className="sec-stack">
      <form
        className="sec-form-row"
        onSubmit={(event) => {
          event.preventDefault()
          find()
        }}
      >
        <div className="ds-field">
          <Label htmlFor={inputId}>Search {provider}</Label>
          <Input
            id={inputId}
            controlSize="md"
            value={query}
            maxLength={200}
            placeholder={placeholder}
            disabled={busy}
            onChange={(event) => {
              setQuery(event.target.value)
              setShowInitialResult(false)
              setLastResult(undefined)
              openAddedFor.current = null
              search.reset()
              add.reset()
            }}
          />
        </div>
        <Button
          size="md"
          variant="primary"
          type="submit"
          disabled={busy || !query.trim()}
          feedback={searchControl === 'search' ? searchFeedback : undefined}
        >
          Search
        </Button>
      </form>
      {search.isError && (
        <Notice tone="danger">
          {errorMessage(search.error, `Could not search ${provider}.`)}
        </Notice>
      )}
      {add.isError && (
        <Notice tone="danger">
          {errorMessage(add.error, `Could not add ${mediaType}.`)}
        </Notice>
      )}
      {(result || search.isPending || search.isError) && (
        <>
          <ManualSearchResults
            mediaType={mediaType}
            query={search.variables?.q ?? initialQuery}
            result={result}
            revision={search.submittedAt}
            loading={search.isPending}
            showEmpty={
              !search.isSuccess || !noMatches || searchControl !== 'search'
            }
            liveSearch={liveSearch}
            exactMembership={exactMembership}
            tracksPlayed={tracksPlayed}
            disabled={busy}
            renderItem={(item) => {
              const libraryId = libraryIdFor(item)
              const detailId = libraryId ?? item.catalogMediaItemId
              const inLibrary = Boolean(libraryId)
              const pending =
                add.isPending && add.variables?.externalId === item.externalId
              return (
                <ListRow
                  title={
                    <RowTitle>
                      {detailId ? (
                        <DetailLink
                          kind={mediaType}
                          id={detailId}
                          title={item.title}
                          onClick={(event) => {
                            if (
                              isLinking ||
                              event.defaultPrevented ||
                              event.button !== 0 ||
                              event.metaKey ||
                              event.altKey ||
                              event.ctrlKey ||
                              event.shiftKey
                            )
                              return
                            event.preventDefault()
                            if (!busy) {
                              openAddedFor.current = null
                              void onAdded(detailId)
                            }
                          }}
                        >
                          {item.title}
                        </DetailLink>
                      ) : (
                        <span title={item.title}>{item.title}</span>
                      )}
                    </RowTitle>
                  }
                  thumb={
                    <MediaThumb
                      kind={mediaType}
                      src={item.artworkUrl}
                      size={40}
                    />
                  }
                  by={describeSearchItem(item, { inLibrary, tracksPlayed })}
                  play={
                    <span className="ds-actions">
                      <ServiceIconLinks
                        links={[{ provider, label: provider, url: item.url }]}
                        itemTitle={item.title}
                      />
                      {isLinking ? (
                        <Button
                          type="button"
                          size="xs"
                          disabled={busy}
                          aria-label={`${inLibrary ? existingActionLabel : 'Add'} ${item.title}`}
                          onClick={() =>
                            onChoose ? onChoose(item) : choose(item)
                          }
                        >
                          {pending
                            ? 'Saving…'
                            : inLibrary
                              ? existingActionLabel
                              : 'Add'}
                        </Button>
                      ) : !item.membershipAmbiguous ? (
                        <ManualResultAdd
                          kind={mediaType}
                          item={item}
                          saved={inLibrary}
                          disabled={busy}
                          onAdd={() => choose(item)}
                        />
                      ) : null}
                    </span>
                  }
                />
              )
            }}
          />
          {result &&
            (result.totalCount === undefined || !liveSearch) &&
            (result.page > 1 || result.hasMore) && (
              <span className="sec-line">
                <Button
                  type="button"
                  disabled={busy || result.page <= 1}
                  feedback={
                    searchControl === 'previous' ? searchFeedback : undefined
                  }
                  onClick={() => find(result.page - 1, 'previous')}
                >
                  Previous
                </Button>
                <span className="ds-muted">Page {result.page}</span>
                <Button
                  type="button"
                  disabled={busy || !result.hasMore || result.page >= 50}
                  feedback={
                    searchControl === 'next' ? searchFeedback : undefined
                  }
                  onClick={() => find(result.page + 1, 'next')}
                >
                  Next
                </Button>
              </span>
            )}
        </>
      )}
    </div>
  )
}

/** Stored searches stay bounded until the user explicitly searches again. */
function ManualSearchResults({
  mediaType,
  query,
  result,
  revision,
  loading,
  showEmpty,
  liveSearch,
  exactMembership,
  tracksPlayed,
  disabled,
  renderItem,
}: {
  mediaType: ManualMediaSearchInput['mediaType']
  query: string
  result: ManualMediaSearchResult | undefined
  revision: number
  loading: boolean
  showEmpty: boolean
  liveSearch: boolean
  exactMembership?: boolean
  tracksPlayed: number | undefined
  disabled: boolean
  renderItem: (item: ManualMediaSearchItem) => ReactNode
}) {
  const { apiBaseUrl } = useConfig()
  const { pageSize, provider } = searchFields[mediaType]
  const rowHeight = RESULT_ROW_HEIGHT
  const storedOnly = Boolean(
    result && (!liveSearch || result.totalCount === undefined),
  )
  const storedRows = useVirtualRows({
    rows: storedOnly ? (result?.items ?? []) : [],
    identity: `${mediaType}:${query}:${revision}`,
    rowHeight,
    headerHeight: 0,
  })
  const results = useVirtualTable({
    queryKey: [
      'manual-media-search-window',
      mediaType,
      query,
      revision,
      liveSearch,
      exactMembership,
    ],
    pageSize,
    rowHeight,
    headerHeight: 0,
    enabled:
      Boolean(result) && !storedOnly && !loading && liveSearch && !disabled,
    loadPage: (page, _size, signal) =>
      loadManualSearchPage({
        apiBaseUrl,
        mediaType,
        query,
        page,
        stored: result,
        liveSearch,
        exactMembership,
        tracksPlayed,
        signal,
      }),
  })
  const window = storedOnly ? storedRows : results
  return (
    <>
      <div
        ref={window.scroller}
        onScroll={window.onScroll}
        className="sec-bounded sec-results"
        role="region"
        aria-label={`${provider} results`}
        aria-busy={loading || (!storedOnly && results.isFetching)}
        tabIndex={0}
      >
        {showEmpty &&
          !loading &&
          (storedOnly || results.hasTotal) &&
          window.total === 0 && (
            <State
              size="sm"
              title={
                mediaType === 'track' &&
                result &&
                (result.hasMore || result.page > 1)
                  ? 'No available tracks on this page'
                  : `No ${mediaType}s match`
              }
            />
          )}
        <List compact>
          {window.padTop > 0 && (
            <div aria-hidden="true" style={{ height: window.padTop }} />
          )}
          {window.slots.map(({ item, index }) =>
            item ? (
              <div
                key={index}
                className="sec-result-slot"
                style={{ height: RESULT_ROW_HEIGHT }}
              >
                {renderItem(item)}
              </div>
            ) : (
              <div
                key={index}
                className="sec-result-slot"
                style={{ height: RESULT_ROW_HEIGHT }}
                aria-hidden="true"
              >
                <Skeleton height={RESULT_ROW_HEIGHT - 16} />
              </div>
            ),
          )}
          {window.padBottom > 0 && (
            <div aria-hidden="true" style={{ height: window.padBottom }} />
          )}
        </List>
      </div>
      {!storedOnly && results.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={results.retry}>
              Retry
            </ReadButton>
          }
        >
          Could not load results.
        </Notice>
      )}
    </>
  )
}

export default function ManualMediaAdd({
  mediaType,
  initialQuery,
  onClose,
  onAdded,
}: {
  mediaType: ManualMediaSearchInput['mediaType']
  initialQuery?: string
  onClose: () => void
  onAdded: (id: string) => void | Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [pending, setPending] = useState(false)
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    element?.querySelector('input')?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="sec-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!pending) onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!pending && event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="ds-inspector">
        <div className="ds-inspector-bar">
          <h2 id={titleId} className="ds-crumbs">
            <b>Add {mediaType}</b>
          </h2>
          <Button
            variant="ghost"
            icon
            aria-label={`Close add ${mediaType}`}
            disabled={pending}
            onClick={onClose}
          >
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="ds-inspector-body">
          <ManualMediaSearch
            mediaType={mediaType}
            initialQuery={initialQuery}
            onAdded={onAdded}
            onPendingChange={setPending}
          />
        </div>
      </div>
    </dialog>
  )
}
