import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { Children, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BrowseActions,
  MoreButton,
  PlayPair,
} from '@repo/ui/components/ds/play'
import {
  ActionMenuItems,
  menuFocusIndex,
  RowMoreMenu,
  type DetailMenuItem,
} from './action-menu'

function unexpected() {
  throw new Error('Rendering does not run menu actions')
}

const rowItems: DetailMenuItem[] = [
  { label: 'Add to playlist…', onSelect: unexpected },
  { label: 'Open details', href: '/tracks/track-1' },
]

/** The accessible names of the buttons and links, in document order. */
function names(html: string) {
  return [...html.matchAll(/<(?:button|a)\b[^>]*aria-label="([^"]+)"/g)].map(
    (match) => match[1],
  )
}

function props(node: unknown) {
  assert.ok(isValidElement<{ onClick: () => void; children?: ReactNode }>(node))
  return node.props
}

test('the play group is Play, Add to queue, then More, with provider marks last', () => {
  const html = renderToStaticMarkup(
    <PlayPair
      place="row"
      title="Glass Meridian"
      onPlay={unexpected}
      onQueue={unexpected}
      more={<MoreButton title="Glass Meridian" />}
      afterQueue={
        <a href="https://example.test" aria-label="Open on Fixture" />
      }
    />,
  )
  assert.match(html, /^<span class="ds-play" data-place="row">/)
  assert.deepEqual(names(html), [
    'Play Glass Meridian',
    'Add Glass Meridian to queue',
    'More actions for Glass Meridian',
    'Open on Fixture',
  ])
})

test('a disabled pair keeps More enabled', () => {
  const html = renderToStaticMarkup(
    <PlayPair
      place="tile"
      title="Glass Meridian"
      disabled
      disabledReason="No Spotify recording is available."
      onPlay={unexpected}
      onQueue={unexpected}
      more={<MoreButton title="Glass Meridian" />}
    />,
  )
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
  assert.match(
    html,
    /<button(?![^>]*disabled)[^>]*aria-label="More actions for Glass Meridian"/,
  )
})

test('More is the three-dot button that opens a menu', () => {
  const html = renderToStaticMarkup(<MoreButton title="Glass Meridian" />)
  assert.match(html, /^<button class="ds-btn" data-size="xs" data-icon=""/)
  assert.match(html, /type="button"/)
  assert.match(html, /aria-label="More actions for Glass Meridian"/)
  assert.match(html, /title="More actions"/)
  assert.match(html, /aria-haspopup="menu"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /lucide-ellipsis ds-i" data-size="sm" data-dots=""/)
  assert.match(
    renderToStaticMarkup(<MoreButton title="Glass Meridian" expanded />),
    /aria-expanded="true"/,
  )
})

test('an item that cannot be played keeps More alone in the group', () => {
  const alone = renderToStaticMarkup(
    <RowMoreMenu title="Paper Moons" items={rowItems} place="row" />,
  )
  assert.match(alone, /^<span class="ds-play" data-place="row"><button/)
  assert.deepEqual(names(alone), ['More actions for Paper Moons'])
  const tile = renderToStaticMarkup(
    <BrowseActions place="tile">
      <MoreButton title="Paper Moons" />
    </BrowseActions>,
  )
  assert.match(tile, /^<span class="ds-play" data-place="tile"><button/)
  assert.deepEqual(names(tile), ['More actions for Paper Moons'])
})

test('the row menu is a sheet popover controlled by its More button', () => {
  const html = renderToStaticMarkup(
    <RowMoreMenu title="Glass Meridian" items={rowItems} />,
  )
  const controls = html.match(/aria-controls="([^"]+)"/)?.[1]
  assert.ok(controls)
  assert.match(html, new RegExp(`popoverTarget="${controls}"`))
  assert.match(
    html,
    new RegExp(
      `<div id="${controls}" popover="auto" role="menu" aria-label="More actions for Glass Meridian" class="ds-pop" data-sheet="">`,
    ),
  )
  const labels = [...html.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(labels, ['Add to playlist…', 'Open details'])
  assert.match(html, /href="\/tracks\/track-1"/)
})

test('an item can carry an icon before its label', () => {
  const html = renderToStaticMarkup(
    <RowMoreMenu
      title="Glass Meridian"
      items={[
        {
          label: 'Open details',
          href: '/tracks/track-1',
          icon: <svg className="ds-i" data-size="sm" aria-hidden />,
        },
      ]}
    />,
  )
  assert.match(
    html,
    /role="menuitem" class="ds-menu-item" href="\/tracks\/track-1"><svg class="ds-i" data-size="sm" aria-hidden="true"><\/svg>Open details<\/a>/,
  )
})

test('a popover opened from the menu keeps the button expanded', () => {
  const html = renderToStaticMarkup(
    <RowMoreMenu title="Glass Meridian" items={rowItems} expanded />,
  )
  assert.match(html, /aria-expanded="true"/)
})

test('arrow keys wrap round the items, Home and End go to either end', () => {
  assert.equal(menuFocusIndex('ArrowDown', -1, 3), 0)
  assert.equal(menuFocusIndex('ArrowDown', 0, 3), 1)
  assert.equal(menuFocusIndex('ArrowDown', 2, 3), 0)
  assert.equal(menuFocusIndex('ArrowUp', 0, 3), 2)
  assert.equal(menuFocusIndex('ArrowUp', -1, 3), 1)
  assert.equal(menuFocusIndex('Home', 2, 3), 0)
  assert.equal(menuFocusIndex('End', 0, 3), 2)
  assert.equal(menuFocusIndex('Tab', 0, 3), undefined)
  assert.equal(menuFocusIndex('ArrowDown', -1, 0), undefined)
})

test('choosing an item closes the menu; a ticked choice changes nothing', () => {
  const close = mock.fn()
  const hide = mock.fn()
  const action = mock.fn()
  const pick = mock.fn()
  const keep = mock.fn()
  const nodes = ActionMenuItems({
    items: [
      { label: 'Add to playlist…', onSelect: action },
      { label: 'Open details', href: '/tracks/track-1' },
      {
        group: 'Playlist type',
        choices: [
          { label: 'Automatic', checked: true, onSelect: keep },
          { label: 'Albums', checked: false, onSelect: pick },
        ],
      },
    ],
    close,
    hide,
    anchor: () => null,
  })
  assert.equal(nodes.length, 3)
  props(nodes[0]).onClick()
  assert.equal(close.mock.callCount(), 1)
  // The action needs the button to anchor what it opens.
  assert.equal(action.mock.callCount(), 0)
  props(nodes[1]).onClick()
  assert.equal(hide.mock.callCount(), 1)
  assert.equal(close.mock.callCount(), 1)
  const [, ticked, other] = Children.toArray(props(nodes[2]).children)
  props(ticked).onClick()
  assert.equal(close.mock.callCount(), 2)
  assert.equal(keep.mock.callCount(), 0)
  props(other).onClick()
  assert.equal(close.mock.callCount(), 3)
  assert.equal(pick.mock.callCount(), 1)
})
