'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  AlbumCsvPreviewInputSchema,
  AlbumImportPreviewSchema,
  ConfirmAlbumImportSchema,
} from '@repo/schemas/album-imports'
import { FileImportFormatSchema, ImportRunSchema } from '@repo/schemas/imports'
import { albumBrowseFields, formatBrowseValue } from '@repo/schemas/browse'
import {
  SpotifyAccountStatusSchema,
  SpotifyAuthorizeResultSchema,
  SpotifyDisconnectResultSchema,
  SpotifySavedAlbumsInputSchema,
} from '@repo/schemas/spotify'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from './providers'
import { useImportsWorkspace } from './imports-workspace'
import {
  FilmProviderSelection,
  useMediaProviders,
} from './film-provider-selection'
import ImportPreviewTable from './import-preview-table'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import { spotifyCallbackSetup } from '@/utils/spotify-setup'

const addedDateField = albumBrowseFields.find(
  (field) => field.key === 'dateAdded',
)

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
  const [confirmed, setConfirmed] = useState(false)
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
      setConfirmed(false)
      setDiscoverBroad(false)
    },
  })
  const commit = useMutation({
    mutationFn: () =>
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
              confirmBroadRun: confirmed,
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
    setConfirmed(false)
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
  return (
    <section className="film-import-workflow">
      {kind === 'spotify' ? (
        <>
          {account.isPending && (
            <p className="muted">Loading Spotify connection...</p>
          )}
          {account.isError && (
            <p role="alert">
              Could not load Spotify connection.{' '}
              <button onClick={() => account.refetch()}>Retry</button>
            </p>
          )}
          {params.get('spotify') === 'error' && (
            <p role="alert">
              Spotify connection was not completed. Try connecting again.
            </p>
          )}
          {account.data && (
            <>
              <p className="muted">
                {account.data.connected
                  ? 'Spotify connected.'
                  : 'Spotify not connected.'}{' '}
                Saved albums are read only after Preview. Nothing is played or
                added to playlists.
              </p>
              {!account.data.configured && (
                <p role="alert">
                  Configure Client ID and Redirect URI in{' '}
                  <Link href="/providers?provider=spotify&mediaType=album">
                    Spotify provider settings
                  </Link>
                  .
                </p>
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
                  <code className="block break-all">{setup.callbackUrl}</code>
                  <p className="muted">
                    Keep using this app address. The callback returns to your
                    signed-in session automatically.
                  </p>
                </details>
              )}
              <div className="form-actions">
                <Button
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
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => disconnect.mutate()}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
              {account.data.connected && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (busy) return
                    reset()
                    preview.mutate(undefined)
                  }}
                >
                  <fieldset disabled={busy} className="edit-grid">
                    <label>
                      {discoverBroad
                        ? 'Newest additions to preview'
                        : 'Albums to preview'}
                      <Input
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
                    </label>
                  </fieldset>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={discoverBroad}
                      disabled={busy}
                      onChange={(event) =>
                        setDiscoverBroad(event.target.checked)
                      }
                    />
                    Read all saved albums to find newest additions
                  </label>
                  <p className="muted">
                    {discoverBroad
                      ? `Reads the full saved library under existing rate limits, then returns the newest ${limit || 'N'} by date added. This may take several minutes.`
                      : 'Reads only the requested batch, sorted by date added. It may not contain your newest additions. More than 50 requires the full-scan confirmation.'}{' '}
                    No albums are imported and no jobs are queued.
                  </p>
                  <Button type="submit" disabled={busy}>
                    {preview.isPending
                      ? 'Loading saved albums...'
                      : 'Preview saved albums'}
                  </Button>
                </form>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <label>
            CSV format
            <select
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
            </select>
          </label>
          {formats.isError && (
            <p role="alert">
              Could not load album CSV formats.{' '}
              <button onClick={() => formats.refetch()}>Retry</button>
            </p>
          )}
          <label
            className="csv-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              if (formats.data?.some((item) => item.id === format))
                void chooseFile(event.dataTransfer.files[0])
            }}
          >
            Drop an album CSV here or choose a file
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
          </label>
          <p className="muted">
            Preview only reads the file. Existing albums stay unchanged.
          </p>
        </>
      )}
      {(error ||
        preview.error ||
        commit.error ||
        connect.error ||
        disconnect.error) && (
        <p role="alert">
          {error ||
            preview.error?.message ||
            commit.error?.message ||
            connect.error?.message ||
            disconnect.error?.message}
        </p>
      )}
      {preview.data && (
        <div className="import-review">
          <div className="import-review-summary">
            <strong>{preview.data.items.length} albums</strong>
            <span>{preview.data.existing} unchanged</span>
            <span>{preview.data.skipped} skipped</span>
          </div>
          {discovery && (
            <p className="muted">
              {discovery.complete && discovery.order === 'dateAddedDesc' ? (
                <>
                  Scanned {discovery.scanned ?? discovery.total} of{' '}
                  {discovery.total} saved albums. Returned {discovery.received}{' '}
                  newest additions, newest saved first.
                </>
              ) : (
                <>
                  Read {discovery.scanned ?? discovery.received} of{' '}
                  {discovery.total} saved albums from offset {discovery.offset}.{' '}
                  This preview is not confirmed as globally newest. Run a
                  full-library preview to find newest additions.
                </>
              )}
            </p>
          )}
          <ImportPreviewTable
            key={preview.data.id}
            items={preview.data.items}
            selected={rows}
            onChange={(value) => {
              setRows(value)
              setConfirmed(false)
            }}
            disabled={busy || commit.isSuccess}
            actionable={(item) => item.action === 'new'}
            headings={
              <>
                <th scope="col">Album</th>
                <th scope="col">Artists</th>
                <th scope="col">Added</th>
                <th scope="col">Identifiers</th>
                <th scope="col">Changes</th>
              </>
            }
            cells={(item) => (
              <>
                <td>{item.title}</td>
                <td>{item.artists.join(', ')}</td>
                <td>
                  {item.dateAdded && addedDateField ? (
                    <time dateTime={item.dateAdded} title={item.dateAdded}>
                      {formatBrowseValue(
                        addedDateField,
                        Date.parse(item.dateAdded),
                      )}
                    </time>
                  ) : (
                    '-'
                  )}
                </td>
                <td>
                  {item.needsIdentification
                    ? 'Needs ID'
                    : item.identifiers.join(', ')}
                </td>
                <td>{item.action === 'new' ? 'New album' : 'Unchanged'}</td>
              </>
            )}
          />
          {!preview.data.items.length && (
            <p className="muted">No albums to import.</p>
          )}
          <div className="import-confirmation">
            <FilmProviderSelection
              providers={providers.providers}
              selected={providers.selected}
              onChange={(value) => {
                providers.setSelected(value)
                setConfirmed(false)
              }}
              disabled={busy || commit.isSuccess}
            />
            {providers.isError && (
              <p role="alert">
                Could not load metadata providers. Reload before importing.
              </p>
            )}
            <p className="muted">
              {jobs
                ? `Up to ${jobs} metadata jobs for selected new albums only.`
                : 'Import only. No metadata provider requests.'}{' '}
              Existing albums are never updated or queued by imports.
            </p>
            {jobs > 5 && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || commit.isSuccess}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Confirm up to {jobs} album/provider jobs
              </label>
            )}
            <Button
              disabled={
                busy ||
                commit.isSuccess ||
                !rows.length ||
                providers.isPending ||
                providers.isError ||
                (jobs > 5 && !confirmed)
              }
              onClick={() => commit.mutate()}
            >
              {commit.isPending
                ? 'Starting...'
                : `Import ${rows.length} albums`}
            </Button>
          </div>
          {!!preview.data.warnings.length && (
            <details>
              <summary>{preview.data.warnings.length} import warnings</summary>
              {preview.data.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          )}
          {commit.data && (
            <p role="status">
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
            </p>
          )}
        </div>
      )}
    </section>
  )
}
