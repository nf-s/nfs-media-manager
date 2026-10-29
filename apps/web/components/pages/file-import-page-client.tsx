'use client'

import { useSearchParams } from 'next/navigation'
import FilmImportWorkflow from '@/components/film-import-workflow'
import {
  ImportStatusNotice,
  useImportsWorkspace,
} from '@/components/imports-workspace'
import { resolveCsvFormat } from '@/utils/import-navigation'
import { useMediaScope } from '@/components/media-scope'
import AlbumImportPageClient from './album-import-page-client'
import Link from 'next/link'

export default function FileImportPageClient({
  kind,
}: {
  kind: 'csv' | 'nfo'
}) {
  const { status, formats, running } = useImportsWorkspace()
  const params = useSearchParams()
  const mediaType = useMediaScope()
  const requested = params.get('format')
  const format = resolveCsvFormat(formats.data ?? [], requested)
  const ready = kind === 'nfo' || !!format
  if (mediaType === 'album')
    return kind === 'csv' ? (
      <AlbumImportPageClient kind="csv" />
    ) : (
      <section className="admin-page">
        <h1>NFO films</h1>
        <p>
          NFO import is available for films only.{' '}
          <Link href="/imports/nfo?mediaType=film">Open film NFO import</Link>
        </p>
      </section>
    )
  return (
    <section className="admin-page imports-page">
      <h1>
        {kind === 'nfo'
          ? 'Find new NFO films'
          : (format?.label ?? 'Import CSV')}
      </h1>
      <ImportStatusNotice />
      {kind === 'csv' && formats.isPending && (
        <p role="status" className="muted">
          Loading CSV formats...
        </p>
      )}
      {kind === 'csv' && formats.isError && (
        <p role="alert">
          Could not load CSV formats.{' '}
          <button onClick={() => formats.refetch()}>Retry</button>
        </p>
      )}
      {kind === 'csv' && formats.isSuccess && !format && (
        <p role="alert">
          {requested === null
            ? 'No CSV formats are available.'
            : 'This CSV format is unavailable. Choose another format from Imports navigation.'}
        </p>
      )}
      {ready && (
        <FilmImportWorkflow
          key={kind === 'csv' ? format?.id : 'nfo'}
          running={running || status.isPending || status.isError}
          initialKind={kind}
          initialFormat={format?.id}
          showSourcePicker={false}
        />
      )}
    </section>
  )
}
