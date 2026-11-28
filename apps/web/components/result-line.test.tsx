import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ResultLineBar,
  ResultLineProvider,
  ResultLineSlot,
} from './result-line'

function unexpected() {
  throw new Error('Rendering does not run result actions')
}

test('the result line is a tick, the text, then Open playlist, Undo and Dismiss', () => {
  const text = 'Added 34 tracks to “Late shift”. Skipped 6 already there.'
  const html = renderToStaticMarkup(
    <ResultLineBar
      text={text}
      undone={false}
      follow={{ label: 'Open playlist', onSelect: unexpected }}
      undo={async () => undefined}
      onDismiss={unexpected}
    />,
  )
  assert.match(
    html,
    /^<div class="ds-selectbar sec-selectbar"><span class="ds-selectbar-result" role="status"><svg[^>]*lucide-check/,
  )
  assert.match(html, new RegExp(`<span title="${text}">${text}</span>`))
  assert.deepEqual(
    [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map(
      (match) => match[1]?.replace(/<[^>]+>/g, '') || 'icon',
    ),
    ['Open playlist', 'Undo', 'icon'],
  )
  assert.match(html, /aria-label="Dismiss"/)
})

test('after Undo the line starts Undone:, with the history mark and Dismiss only', () => {
  const html = renderToStaticMarkup(
    <ResultLineBar
      text="Undone: Created “Night bus” with 40 tracks."
      undone
      onDismiss={unexpected}
    />,
  )
  assert.match(html, /lucide-history/)
  assert.match(html, />Undone: Created “Night bus” with 40 tracks.</)
  assert.doesNotMatch(html, />Undo<|Open playlist/)
  assert.match(html, /aria-label="Dismiss"/)
})

test('with nothing reported a slot draws nothing', () => {
  assert.equal(
    renderToStaticMarkup(
      <ResultLineProvider>
        <ResultLineSlot place="content" />
      </ResultLineProvider>,
    ),
    '',
  )
})
