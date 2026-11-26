import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RecordingVersionsStatus,
  RecordingVersionsPager,
} from './track-recording-versions'

test('an expanded page of release versions reports loading once', () => {
  const versions: Parameters<typeof RecordingVersionsPager>[0]['versions'] = {
    expanded: {
      identity: 'fixture',
      id: 'track',
      index: 0,
      page: 2,
      control: 'next',
    },
    feedback: { phase: 'pending', label: 'Loading versions…' },
    items: [],
    needsPager: true,
    loading: true,
    error: null,
    nextPage: false,
    page: 2,
    rowCount: 2,
    collapse: () => {},
    retry: () => {
      throw new Error('unexpected retry')
    },
    goToPage: () => {},
    toggle: () => {},
  }
  const visible = renderToStaticMarkup(
    <>
      <RecordingVersionsStatus versions={versions} />
      <RecordingVersionsPager versions={versions} />
    </>,
  ).replace(/<[^>]*>/g, '')
  assert.equal(visible.split('Loading versions…').length - 1, 1)
})
