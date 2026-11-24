'use client'

import Link from 'next/link'
import { useId, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  AlbumCsvPreviewInputSchema,
  AlbumImportPreviewSchema,
  ConfirmAlbumImportSchema,
} from '@repo/schemas/album-imports'
import { FileImportFormatSchema, ImportRunSchema } from '@repo/schemas/imports'
import {
  SpotifyAccountStatusSchema,
  SpotifyAuthorizeResultSchema,
  SpotifyDisconnectResultSchema,
  SpotifySavedAlbumsInputSchema,
} from '@repo/schemas/spotify'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { KeyValues } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import { Select } from '@repo/ui/components/ds/toolbar'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatItemCount,
} from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { useImportsWorkspace } from './imports-workspace'
import {
  FilmProviderSelection,
  useMediaProviders,
} from './film-provider-selection'
import ImportPreviewTable from './import-preview-table'
import { SecondaryCell } from './secondary-table'
import { ConfirmAction } from './confirm-action'
import { DetailLink } from './detail-link'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import { spotifyCallbackSetup } from '@/utils/spotify-setup'

const ALBUMS = { one: 'album', other: 'albums' }

export default function AlbumImportWorkflow({
  kind,
}: {
  kind: 'csv' | 'spotify'
}) {
  const { apiBaseUrl, appUrl } = useConfig()
  const client = useQueryClient()
  const params = useSearchParams()
  const { running, status } = useImportsWorkspace()
  const providers = useMediaProviders('album')
  const [format, setFormat] = useState('album-csv')
  const [rows, setRows] = useState<number[]>([])
  const [dragging, setDragging] = useState(false)
  const formatId = useId()
  const limitId = useId()
  const [limit, setLimit] = useState('20')
  const [discoverBroad, setDiscoverBroad] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const formats = useQuery({
    queryKey: ['album-import-formats'],
    enabled: kind === 'csv',
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/album-imports/formats',
        z.array(FileImportFormatSchema),
      ),
  })
  const account = useQuery({
    queryKey: ['spotify-account'],
    enabled: kind === 'spotify',
    staleTime: 0,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/status',
        SpotifyAccountStatusSchema,
      ),
  })
  const connect = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/authorize',
        SpotifyAuthorizeResultSchema,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: (result) => {
      const url = new URL(result.url)
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'accounts.spotify.com'
      ) {
        setError('The authorization URL was not a Spotify URL.')
        return
      }
      window.location.assign(url.href)
    },
  })
  const disconnect = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/account',
        SpotifyDisconnectResultSchema,
        { method: 'DELETE' },
      ),
    onSuccess: async () => {
      reset()
      await client.invalidateQueries({ queryKey: ['spotify-account'] })
    },
  })
  const preview = useMutation({
    mutationFn: (file: { fileName: string; content: string } | undefined) => {
      const input = file
        ? AlbumCsvPreviewInputSchema.parse({ ...file, format })
        : SpotifySavedAlbumsInputSchema.parse({
            limit: Number(limit),
            offset: 0,
            scanAll: discoverBroad,
            confirmBroadRun: discoverBroad,
          })
      return fetchApiData(
        apiBaseUrl,
        file ? '/api/v1/album-imports/preview' : '/api/v1/spotify/preview',
        AlbumImportPreviewSchema,
        { method: 'POST', body: JSON.stringify(input) },
      )
    },
    onSuccess: () => {
      setRows([])
      setDiscoverBroad(false)
    },
  })
  const commit = useMutation({
    mutationFn: (confirmBroadRun: boolean) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/album-imports/commit',
        ImportRunSchema,
        {
          method: 'POST',
          body: JSON.stringify(
            ConfirmAlbumImportSchema.parse({
              previewId: preview.data?.id,
              rows,
              providers: providers.selected,
              confirmBroadRun,
            }),
          ),
        },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['imports'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
      await client.invalidateQueries({ queryKey: ['albums'] })
    },
  })
  const busy =
    reading ||
    preview.isPending ||
    commit.isPending ||
    running ||
    status.isPending ||
    status.isError ||
    connect.isPending ||
    disconnect.isPending
  function reset() {
    preview.reset()
    commit.reset()
    setRows([])
    setError('')
  }
  async function chooseFile(file: File | undefined) {
    if (!file || busy) return
    reset()
    if (!/\.csv$/i.test(file.name) || file.size > 20 * 1024 * 1024) {
      setError('Choose a CSV file smaller than 20 MB.')
      return
    }
    setReading(true)
    try {
      await preview.mutateAsync({
        fileName: file.name,
        content: await file.text(),
      })
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Could not read CSV file.',
      )
    } finally {
      setReading(false)
    }
  }
  const jobs = rows.length * providers.selected.length
  const discovery = preview.data?.discovery
  const setup = spotifyCallbackSetup(
    apiBaseUrl,
    appUrl,
    account.data?.redirectUri ?? null,
  )
  const summary = preview.data
    ? [
        formatItemCount(preview.data.items.length, ALBUMS),
        `${formatCount(preview.data.existing)} unchanged`,
        `${formatCount(preview.data.skipped)} skipped`,
      ].join(' · ')
    : ''
  return (
    <div className="sec-fill">
      <div className="ds-panelpad sec-form">
        {kind === 'spotify' ? (
          <>
            {account.isError && (
              <Notice
                tone="danger"
                action={
                  <Button size="xs" onClick={() => account.refetch()}>
                    Retry
                  </Button>
                }
              >
                Could not load Spotify connection.
              </Notice>
            )}
            {params.get('spotify') === 'error' && (
              <Notice tone="danger">
                Spotify connection was not completed. Try connecting again.
              </Notice>
            )}
            {account.isPending && <Skeleton width="50%" height={16} />}
            {account.data && (
              <>
                <KeyValues
                  items={[
                    {
                      label: 'Spotify',
                      value: account.data.connected ? (
                        <Status state="done">Connected</Status>
                      ) : (
                        <Status state="attention">Needs sign-in</Status>
                      ),
                    },
                  ]}
                />
                <p className="ds-help">
                  Saved albums are read only after Preview. Nothing is played or
                  added to playlists.
                </p>
                {!account.data.configured && (
                  <Notice tone="attention">
                    Configure Client ID and Redirect URI in{' '}
                    <Link href="/providers/spotify">
                      Spotify provider settings
                    </Link>
                    .
                  </Notice>
                )}
                {setup && (
                  <details>
                    <summary>Spotify connection setup</summary>
                    <p>
                      Register this exact Redirect URI in your{' '}
                      <a
                        href="https://developer.spotify.com/dashboard"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Spotify developer app
                      </a>
                      :
                    </p>
                    <code className="ds-mono block break-all">
                      {setup.callbackUrl}
                    </code>
                    <p className="ds-help">
                      Keep using this app address. The callback returns to your
                      signed-in session automatically.
                    </p>
                  </details>
                )}
                <span className="ds-actions">
                  <Button
                    size="md"
                    variant={account.data.connected ? 'default' : 'primary'}
                    disabled={busy || !account.data.configured}
                    onClick={() => connect.mutate()}
                  >
                    {connect.isPending
                      ? 'Connecting...'
                      : account.data.connected
                        ? 'Reconnect Spotify'
                        : 'Connect Spotify'}
                  </Button>
                  {account.data.connected && (
                    <ConfirmAction
                      size="md"
                      confirmVariant="danger"
                      question="Disconnect Spotify?"
                      details="Saved album previews stop until you reconnect. Imported albums stay."
                      confirmLabel="Disconnect"
                      disabled={busy}
                      onConfirm={() => disconnect.mutate()}
                    >
                      Disconnect
                    </ConfirmAction>
                  )}
                </span>
                {account.data.connected && (
                  <form
                    className="sec-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (busy) return
                      reset()
                      preview.mutate(undefined)
                    }}
                  >
                    <fieldset disabled={busy}>
                      <div className="ds-field">
                        <Label htmlFor={limitId}>
                          {discoverBroad
                            ? 'Newest additions to preview'
                            : 'Albums to preview'}
                        </Label>
                        <Input
                          id={limitId}
                          controlSize="md"
                          type="number"
                          min={1}
                          max={500}
                          required
                          value={limit}
                          onChange={(event) => {
                            setLimit(event.target.value)
                            setDiscoverBroad(false)
                            reset()
                          }}
                        />
                      </div>
                    </fieldset>
                    <label className="ds-checkrow">
                      <input
                        type="checkbox"
                        className="ds-check"
                        checked={discoverBroad}
                        disabled={busy}
                        onChange={(event) =>
                          setDiscoverBroad(event.target.checked)
                        }
                      />
                      Read all saved albums to find newest additions
                    </label>
                    <p className="ds-help">
                      {discoverBroad
                        ? `Reads the full saved library under existing rate limits, then returns the newest ${limit || 'N'} by date added. This may take several minutes.`
                        : 'Reads only the requested batch, sorted by date added. It may not contain your newest additions. More than 50 requires the full-scan confirmation.'}{' '}
                      No albums are imported and no jobs are queued.
                    </p>
                    <span className="ds-actions">
                      <Button
                        size="md"
                        variant={preview.data ? 'default' : 'primary'}
                        type="submit"
                        disabled={busy}
                      >
                        {preview.isPending
                          ? 'Loading saved albums...'
                          : 'Preview saved albums'}
                      </Button>
                    </span>
                  </form>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div className="ds-field">
              <Label htmlFor={formatId}>CSV format</Label>
              <Select
                id={formatId}
                controlSize="md"
                value={format}
                disabled={busy || formats.isPending}
                onChange={(event) => {
                  setFormat(event.target.value)
                  reset()
                }}
              >
                {formats.data?.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </div>
            {formats.isError && (
              <Notice
                tone="danger"
                action={
                  <Button size="xs" onClick={() => formats.refetch()}>
                    Retry
                  </Button>
                }
              >
                Could not load album CSV formats.
              </Notice>
            )}
            <label
              className="sec-drop"
              data-dragging={dragging || undefined}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                if (formats.data?.some((item) => item.id === format))
                  void chooseFile(event.dataTransfer.files[0])
              }}
            >
              <span>
                {reading || preview.isPending
                  ? 'Checking CSV...'
                  : 'Drop an album CSV here or choose a file'}
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="Choose album CSV file"
                disabled={
                  busy || !formats.data?.some((item) => item.id === format)
                }
                onChange={(event) => {
                  void chooseFile(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
              <span className="ds-help">
                Preview only reads the file. Existing albums stay unchanged.
              </span>
            </label>
          </>
        )}
        {(error ||
          preview.error ||
          commit.error ||
          connect.error ||
          disconnect.error) && (
          <Notice tone="danger">
            {error ||
              preview.error?.message ||
              commit.error?.message ||
              connect.error?.message ||
              disconnect.error?.message}
          </Notice>
        )}
      </div>
      {preview.data && (
        <div className="sec-fill sec-review">
          <p className="ds-help sec-pad" role="status">
            {summary}
          </p>
          {discovery && (
            <p className="ds-help sec-pad">
              {discovery.complete && discovery.order === 'dateAddedDesc' ? (
                <>
                  Scanned {formatCount(discovery.scanned ?? discovery.total)} of{' '}
                  {formatCount(discovery.total)} saved albums. Returned{' '}
                  {formatCount(discovery.received)} newest additions, newest
                  saved first.
                </>
              ) : (
                <>
                  Read {formatCount(discovery.scanned ?? discovery.received)} of{' '}
                  {formatCount(discovery.total)} saved albums from offset{' '}
                  {formatCount(discovery.offset)}. This preview is not confirmed
                  as globally newest. Run a full-library preview to find newest
                  additions.
                </>
              )}
            </p>
          )}
          <ImportPreviewTable
            key={preview.data.id}
            items={preview.data.items}
            selected={rows}
            onChange={setRows}
            disabled={busy || commit.isSuccess}
            actionable={(item) => item.action === 'new'}
            storageKey="album-import-preview"
            searchValue={(item) =>
              [item.title, ...item.artists, ...item.identifiers].join(' ')
            }
            filterColumn="changes"
            footer={
              <>
                <FilmProviderSelection
                  providers={providers.providers}
                  selected={providers.selected}
                  onChange={providers.setSelected}
                  disabled={busy || commit.isSuccess}
                />
                {providers.isError && (
                  <span role="alert">
                    Could not load metadata providers. Reload before importing.
                  </span>
                )}
                <span className="ds-muted">
                  {jobs
                    ? `Up to ${formatCount(jobs)} metadata jobs for selected new albums only.`
                    : 'Import only. No metadata provider requests.'}{' '}
                  Existing albums are never updated or queued by imports.
                </span>
                <span className="ds-actions ds-toolbar-end">
                  <ConfirmAction
                    variant="primary"
                    confirm={jobs > 5}
                    question={`Import ${formatItemCount(rows.length, ALBUMS)}?`}
                    details={`Queues up to ${formatCount(jobs)} album/provider metadata jobs.`}
                    confirmLabel="Import"
                    disabled={
                      busy ||
                      commit.isSuccess ||
                      !rows.length ||
                      providers.isPending ||
                      providers.isError
                    }
                    onConfirm={() => commit.mutate(jobs > 5)}
                  >
                    {commit.isPending
                      ? 'Starting...'
                      : `Import ${rows.length} albums`}
                  </ConfirmAction>
                </span>
              </>
            }
            filters={[
              {
                key: 'new',
                label: 'New',
                matches: (item) => item.action === 'new',
              },
              {
                key: 'imported',
                label: 'Already imported',
                matches: (item) => item.action === 'unchanged',
              },
            ]}
            columns={[
              {
                key: 'title',
                label: 'Album',
                width: 280,
                value: (item) => item.title,
                render: (item) =>
                  item.catalogMediaItemId ? (
                    <SecondaryCell text={item.title}>
                      <DetailLink
                        kind="album"
                        id={item.catalogMediaItemId}
                        className="ds-cell-title"
                      >
                        {item.title}
                      </DetailLink>
                    </SecondaryCell>
                  ) : (
                    <SecondaryCell text={item.title}>
                      {item.title}
                    </SecondaryCell>
                  ),
              },
              {
                key: 'artists',
                label: 'Artists',
                width: 200,
                value: (item) => item.artists.join(', '),
              },
              {
                key: 'added',
                label: 'Added',
                width: 110,
                value: (item) =>
                  item.dateAdded ? Date.parse(item.dateAdded) : null,
                render: (item) => (
                  <SecondaryCell text={item.dateAdded ?? undefined}>
                    {item.dateAdded ? (
                      <time dateTime={item.dateAdded}>
                        {formatDate(item.dateAdded)}
                      </time>
                    ) : (
                      EMPTY_VALUE
                    )}
                  </SecondaryCell>
                ),
              },
              {
                key: 'identifiers',
                label: 'Identifiers',
                width: 160,
                value: (item) =>
                  item.needsIdentification
                    ? 'Needs ID'
                    : item.identifiers.join(', '),
                render: (item) =>
                  item.needsIdentification ? (
                    <Status state="attention">Needs ID</Status>
                  ) : (
                    <SecondaryCell>{item.identifiers.join(', ')}</SecondaryCell>
                  ),
              },
              {
                key: 'changes',
                label: 'Changes',
                width: 140,
                value: (item) =>
                  item.action === 'new' ? 'New album' : 'Unchanged',
              },
              {
                key: 'row',
                label: 'Row',
                width: 70,
                defaultVisible: false,
                align: 'end',
                value: (item) => item.row,
                render: (item) => (
                  <SecondaryCell>{formatCount(item.row + 1)}</SecondaryCell>
                ),
              },
            ]}
          />
          {!preview.data.items.length && (
            <State size="sm" title="No albums to import" />
          )}
          {!!preview.data.warnings.length && (
            <details className="sec-pad">
              <summary>{preview.data.warnings.length} import warnings</summary>
              {preview.data.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          )}
          {commit.data && (
            <div className="sec-notices">
              <Notice>
                Import started.{' '}
                <Link href={scopedHref('/imports', 'album')}>
                  View import progress
                </Link>
                .{' '}
                <Link
                  href={scopedHref(`/jobs?batchId=${preview.data.id}`, 'album')}
                >
                  View metadata jobs
                </Link>
              </Notice>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
