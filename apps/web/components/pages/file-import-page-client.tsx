'use client'

import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@repo/ui/components/ui/button'
import { Notice } from '@repo/ui/components/ds/feedback'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import FilmImportWorkflow from '@/components/film-import-workflow'
import {
  ImportStatusNotice,
  useImportsWorkspace,
} from '@/components/imports-workspace'
import { resolveCsvFormat } from '@/utils/import-navigation'
import { useMediaScope } from '@/components/media-scope'
import AlbumImportPageClient from './album-import-page-client'

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
      <section className="sec-page">
        <PageHead title="NFO films" />
        <div className="sec-notices">
          <Notice
            action={
              <Button size="xs" asChild>
                <Link href="/imports/nfo?mediaType=film">
                  Open film NFO import
                </Link>
              </Button>
            }
          >
            NFO import is available for films only.
          </Notice>
        </div>
      </section>
    )
  return (
    <section className="sec-page">
      <PageHead
        title={
          kind === 'nfo'
            ? 'Find new NFO films'
            : (format?.label ?? 'Import CSV')
        }
      />
      <div className="sec-notices">
        <ImportStatusNotice />
        {kind === 'csv' && formats.isError && (
          <Notice
            tone="danger"
            action={
              <Button size="xs" onClick={() => formats.refetch()}>
                Retry
              </Button>
            }
          >
            Could not load CSV formats.
          </Notice>
        )}
        {kind === 'csv' && formats.isSuccess && !format && (
          <Notice tone="danger">
            {requested === null
              ? 'No CSV formats are available.'
              : 'This CSV format is unavailable. Choose another format from Imports navigation.'}
          </Notice>
        )}
      </div>
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
