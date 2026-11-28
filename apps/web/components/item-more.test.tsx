import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlayPair } from '@repo/ui/components/ds/play'
import { ItemMore, itemMoreMenuItems, libraryItemMore } from './item-more'

function unexpected() {
  throw new Error('Rendering does not run menu actions')
}

const labels = (items: ReturnType<typeof itemMoreMenuItems>) =>
  items.map((item) => ('label' in item ? item.label : item.group))

test('a row’s menu has Add to playlist… and Open details', () => {
  assert.deepEqual(
    labels(itemMoreMenuItems({ onAdd: unexpected, open: '/tracks/track-1' })),
    ['Add to playlist…', 'Open details'],
  )
})

test('inside a playlist it adds to another; only a library playlist offers Remove', () => {
  assert.deepEqual(
    labels(
      itemMoreMenuItems({
        playlist: { kind: 'imported' },
        onAdd: unexpected,
        open: unexpected,
      }),
    ),
    ['Add to another playlist…', 'Open details'],
  )
  assert.deepEqual(
    labels(
      itemMoreMenuItems({
        playlist: { kind: 'library', id: 'playlist-1', onRemove: unexpected },
        onAdd: unexpected,
        open: unexpected,
      }),
    ),
    ['Add to another playlist…', 'Remove from this playlist', 'Open details'],
  )
})

test('More follows Queue with its menu and the provider marks stay last', () => {
  const html = renderToStaticMarkup(
    <PlayPair
      place="row"
      title="Harbour Lights"
      onPlay={unexpected}
      onQueue={unexpected}
      more={
        <ItemMore
          library="tracks"
          item={{ id: 'track-1', title: 'Harbour Lights' }}
        />
      }
      afterQueue={
        <a href="https://example.test" aria-label="Open on Fixture" />
      }
    />,
  )
  assert.match(
    html,
    /aria-label="Add Harbour Lights to queue"[^>]*>.*?<\/button><button[^>]*aria-label="More actions for Harbour Lights"[^>]*>.*?<\/button><div [^>]*role="menu" aria-label="More actions for Harbour Lights"[^>]*data-sheet=""[^>]*>(.*?)<\/div><a href="https:\/\/example.test"/,
  )
  assert.match(
    html,
    /lucide-list-music[^>]*>.*?<\/svg>Add to playlist…<\/button>/,
  )
  // Without the inspector Open details is the item's page.
  assert.match(
    html,
    /<a role="menuitem" class="ds-menu-item" href="\/tracks\/track-1"><svg[^>]*lucide-maximize2[^>]*>.*?<\/svg>Open details<\/a>/,
  )
})

test('an item outside the library has no More', () => {
  assert.equal(
    libraryItemMore('albums', {
      id: 'album-1',
      title: 'Paper Moons',
      inLibrary: false,
    }),
    undefined,
  )
  assert.ok(libraryItemMore('albums', { id: 'album-1', title: 'Paper Moons' }))
})
