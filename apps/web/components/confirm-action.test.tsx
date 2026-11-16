import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfirmAction } from './confirm-action'

test('a confirmed action opens a popover from its own button', () => {
  const html = renderToStaticMarkup(
    <ConfirmAction
      variant="primary"
      question="Import 12 albums?"
      confirmLabel="Import"
      onConfirm={() => {}}
    >
      Import 12 albums
    </ConfirmAction>,
  )
  assert.match(
    html,
    /^<button class="ds-btn" data-variant="primary" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="[^"]+" popoverTarget="[^"]+">Import 12 albums<\/button>$/,
  )
})

test('a small action runs at once without a confirmation', () => {
  const html = renderToStaticMarkup(
    <ConfirmAction
      confirm={false}
      size="xs"
      icon
      ariaLabel="Remove fixture"
      question="Remove fixture?"
      confirmLabel="Remove"
      onConfirm={() => {}}
    >
      x
    </ConfirmAction>,
  )
  assert.match(html, /aria-label="Remove fixture"/)
  assert.match(html, /data-size="xs" data-icon=""/)
  assert.doesNotMatch(html, /aria-haspopup|popoverTarget/)
})
