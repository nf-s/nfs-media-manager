import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ImportRunSchema, type ImportRun } from '@repo/schemas/imports'
import { ImportProgress, resultSummary } from './pages/imports-page-client'
import { importRunFeedback } from '../utils/import-cache'

function run(overrides: Partial<ImportRun>): ImportRun {
  return ImportRunSchema.parse({
    id: 'import-1',
    mediaType: 'album',
    status: 'running',
    stage: 'Importing albums',
    processed: 40,
    total: 128,
    errorMessage: null,
    result: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  })
}

test('a queued or running import shows a progress bar with done and total counts', () => {
  const statuses: ImportRun['status'][] = ['queued', 'running']
  for (const status of statuses) {
    const html = renderToStaticMarkup(<ImportProgress run={run({ status })} />)
    assert.match(html, /role="progressbar"/)
    assert.match(html, /aria-valuenow="40"/)
    assert.match(html, /aria-valuetext="40 of 128"/)
    assert.match(html, /40 \/ 128/)
  }
})

test('a finished import shows its counts in words and no bar', () => {
  const html = renderToStaticMarkup(
    <ImportProgress
      run={run({ status: 'failed', processed: 60, total: 128 })}
    />,
  )
  assert.doesNotMatch(html, /progressbar/)
  assert.equal(html, '60 of 128')
})

test('import receipts keep queue delivery, durable progress and partial work distinct', () => {
  assert.deepEqual(
    importRunFeedback(
      run({ status: 'queued', stage: 'Awaiting queue delivery' }),
    ),
    {
      phase: 'waiting',
      label: 'Waiting for import worker',
    },
  )
  assert.deepEqual(
    importRunFeedback(run({ stage: 'Queueing selected metadata' })),
    {
      phase: 'running',
      label: 'Queueing metadata…',
    },
  )
  assert.deepEqual(
    importRunFeedback(
      run({ status: 'failed', result: { albums: 9, films: 0, created: 9 } }),
    ),
    {
      phase: 'partial',
      label: 'Partly imported',
    },
  )
  assert.equal(
    importRunFeedback(run({ status: 'cancelled' })).phase,
    'cancelled',
  )
})

test('an import without a known total shows an empty value', () => {
  const html = renderToStaticMarkup(
    <ImportProgress run={run({ status: 'queued', processed: 0, total: 0 })} />,
  )
  assert.doesNotMatch(html, /progressbar/)
  assert.match(html, /class="ds-muted"/)
})

test('results read as created, updated, unchanged, skipped and failed', () => {
  assert.equal(
    resultSummary(
      run({
        status: 'succeeded',
        result: {
          albums: 3,
          films: 0,
          created: 3,
          updated: 2,
          unchanged: 5,
          skipped: 1,
          failed: 1,
        },
      }),
    ),
    '3 created · 2 updated · 5 unchanged · 1 skipped · 1 failed',
  )
  assert.equal(
    resultSummary(
      run({
        status: 'succeeded',
        result: { albums: 0, films: 0, created: 0, updated: 4 },
      }),
    ),
    '0 created · 4 updated',
  )
  assert.equal(
    resultSummary(
      run({ status: 'succeeded', result: { albums: 12, films: 3 } }),
    ),
    '12 albums · 3 films',
  )
  assert.equal(
    resultSummary(run({ status: 'failed', errorMessage: 'Import failed.' })),
    'Import failed.',
  )
})
