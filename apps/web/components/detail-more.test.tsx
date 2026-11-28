import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InspectorPageContext } from './detail-inspector-context'
import { DetailMore } from './detail-more'

function unexpected() {
  throw new Error('Rendering does not run menu actions')
}

test('More actions lists the item actions, then Copy link, on a standalone page', () => {
  const html = renderToStaticMarkup(
    <DetailMore
      crumb={{ title: 'Fixture album' }}
      items={[
        { label: 'Edit', onSelect: unexpected },
        { label: 'Filter albums', href: '/albums?filters=fixture' },
      ]}
    />,
  )
  assert.match(
    html,
    /<button[^>]*aria-label="More actions"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/,
  )
  assert.match(html, /role="menu" aria-label="More actions"/)
  const labels = [...html.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(labels, ['Edit', 'Filter albums', 'Copy link'])
  assert.match(html, /href="\/albums\?filters=fixture"/)
  assert.doesNotMatch(html, /Open page/)
  assert.doesNotMatch(html, /ds-btn dtl-more/)
})

test('In the drawer, More actions adds Open page', () => {
  const html = renderToStaticMarkup(
    <InspectorPageContext.Provider
      value={{
        pageHref: '/albums/album-1?tab=edit',
        setCrumb: () => {},
        moreSlot: null,
      }}
    >
      <DetailMore crumb={{ title: 'Fixture album' }} />
    </InspectorPageContext.Provider>,
  )
  const labels = [...html.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(labels, ['Open page', 'Copy link'])
  assert.match(html, /href="\/albums\/album-1\?tab=edit"/)
})

test('the detail menu stays beside its button and is not a row sheet', () => {
  const html = renderToStaticMarkup(
    <DetailMore crumb={{ title: 'Fixture album' }} />,
  )
  assert.match(
    html,
    /<div id="[^"]+" popover="auto" role="menu" aria-label="More actions" class="ds-pop dtl-more-pop">/,
  )
  assert.doesNotMatch(html, /data-sheet/)
  assert.match(
    html,
    /<button class="ds-btn" data-variant="ghost" data-size="md"/,
  )
})
