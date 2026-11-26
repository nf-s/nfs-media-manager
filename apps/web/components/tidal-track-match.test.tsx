import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  TidalTrackCandidateSchema,
  TidalTrackMatchJobSchema,
  TidalTrackMatchReviewSchema,
  TidalTrackMatchSchema,
  type TidalTrackMatchReview,
} from '@repo/schemas/tidal'
import { ConfigContext } from './providers'
import {
  TidalTrackCandidates,
  TidalTrackMatchBody,
  TidalTrackMatchCell,
  TidalTrackMatchJobStatus,
} from './tidal-track-match'

const createdAt = '2026-01-01T00:00:00.000Z'
const job = TidalTrackMatchJobSchema.parse({
  jobId: 'example-job',
  status: 'succeeded',
  isrc: 'QZFX12700004',
  reason: 'ambiguous',
  acceptedTidalTrackId: null,
  candidateCount: 2,
  errorMessage: null,
  createdAt,
  finishedAt: createdAt,
})
const candidate = (id: string, barcodeId: string, version: string | null) =>
  TidalTrackCandidateSchema.parse({
    tidalTrackId: id,
    title: 'Example recording',
    isrc: 'QZFX12700004',
    url: `https://tidal.com/browse/track/${id}`,
    version,
    durationSec: 192,
    popularity: 0.4,
    streamable: true,
    albums: [
      {
        tidalAlbumId: `9${id}`,
        title: 'Example album',
        albumType: 'EP',
        barcodeId,
        releaseDate: '2020-01-01',
      },
    ],
  })
const track = {
  id: 'example-track',
  title: 'Example recording',
  artists: ['Example artist'],
  albumName: 'Example album',
  durationSec: 192,
  isrc: 'QZFX12700004',
  album: { id: 'example-album', title: 'Example album' },
}

function render(element: React.ReactNode, client = new QueryClient()) {
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          {element}
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

const albumMatch = TidalTrackMatchSchema.parse({
  tidalTrackId: '800009',
  url: 'https://tidal.com/browse/track/800009',
  version: null,
  durationSec: 192,
  popularity: 0.4,
  source: 'tidal-album',
  matchReason: null,
  alignment: 'position-duration',
})
const status = (
  values: Partial<Pick<TidalTrackMatchReview, 'job' | 'match'>>,
) =>
  TidalTrackMatchReviewSchema.parse({
    trackId: track.id,
    job: null,
    match: null,
    candidates: [],
    ...values,
  })

test('a TIDAL cell offers Review only for an unresolved ambiguous lookup', () => {
  const onReview = () => assert.fail('Rendering must not open review')
  const cell = (
    values: Parameters<typeof status>[0],
    isrc: string | null = track.isrc,
  ) =>
    render(
      <TidalTrackMatchCell
        status={status(values)}
        isrc={isrc}
        onReview={onReview}
      />,
    )
  assert.match(cell({ job }), />Review</)
  const matched = cell({
    job: { ...job, reason: 'album-upc', acceptedTidalTrackId: '800001' },
    match: { ...albumMatch, source: 'tidal-track-match' },
  })
  assert.match(matched, /Matched/)
  assert.match(matched, /sourceProvider=tidal/)
  assert.match(matched, /href="https:\/\/tidal.com\/browse\/track\/800009"/)
  assert.doesNotMatch(matched, />Review</)
  // An album job's match shows without any track job.
  const album = cell({ match: albumMatch })
  assert.match(album, /Matched/)
  assert.doesNotMatch(album, /Never/)
  // An album match also settles an ambiguous lookup.
  assert.doesNotMatch(cell({ job, match: albumMatch }), />Review</)
  assert.match(cell({}), /Never/)
  assert.doesNotMatch(cell({}, null), /Never/)
})

test('a current match from an album job shows its TIDAL track', () => {
  const html = render(
    <TidalTrackMatchBody
      track={track}
      review={status({ match: albumMatch })}
      upcs={new Set()}
    />,
  )
  assert.match(html, /TIDAL track 800009 · 3:12 · Album track list/)
})

test('a match job link and its error detail can appear without repeating its status', () => {
  const errorMessage = 'The provider did not return this recording.'
  const failed = TidalTrackMatchJobSchema.parse({
    ...job,
    status: 'failed',
    errorMessage,
  })
  const html = render(
    <>
      <TidalTrackMatchJobStatus job={failed} showStatus={false} />
      <TidalTrackMatchBody
        track={track}
        review={status({ job: failed })}
        upcs={new Set()}
        showJob={false}
      />
    </>,
  )
  assert.match(html, /href="\/jobs\/example-job"[^>]*>View match job<\/a>/)
  assert.equal(html.split(errorMessage).length - 1, 1)
  assert.doesNotMatch(html, />Failed</)
})

test('candidates show version, album, type, date, duration and the library UPC', () => {
  const html = render(
    <TidalTrackCandidates
      candidates={[
        candidate('800001', '000000000017', 'Extended Mix'),
        candidate('800002', '000000000099', null),
      ]}
      upcs={new Set(['00000000000017'])}
      onChoose={() => assert.fail('Rendering must not choose')}
    />,
  )
  assert.match(html, /Example recording \(Extended Mix\)/)
  assert.match(html, /Library album UPC · Example album · EP · /)
  assert.match(html, /3:12/)
  assert.equal(html.match(/Library album UPC/g)?.length, 1)
  assert.equal(
    html.match(/aria-label="Review Example recording[^"]* from Example album"/g)
      ?.length,
    2,
  )
  assert.match(html, /href="https:\/\/tidal.com\/browse\/track\/800001"/)
})

test('a chosen match lists the TIDAL track without Choose', () => {
  const review = TidalTrackMatchReviewSchema.parse({
    trackId: track.id,
    match: null,
    job: { ...job, acceptedTidalTrackId: '800002' },
    candidates: [candidate('800002', '000000000099', null)],
  })
  const html = render(
    <TidalTrackMatchBody track={track} review={review} upcs={new Set()} />,
  )
  assert.match(html, /Example recording/)
  assert.doesNotMatch(html, /<button/)
})
