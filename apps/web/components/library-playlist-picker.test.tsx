import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LibraryPlaylistSummarySchema } from '@repo/schemas/library-playlists'
import {
  AddToPlaylistButton,
  PickerDuplicatesStep,
  PickerListStep,
  PickerNewStep,
  PickerPlaylistRow,
} from './library-playlist-picker'
import { itemSubject, type PlaylistSubject } from '@/utils/library-playlists'

function unexpected() {
  throw new Error('Rendering does not run picker actions')
}

const forty: PlaylistSubject = {
  library: 'tracks',
  selection: {
    ids: Array.from({ length: 40 }, (_, index) => `track-${index + 1}`),
  },
  count: 40,
  title: null,
}
const one = itemSubject('tracks', { id: 'track-1', title: 'Harbour Lights' })
const lateShift = LibraryPlaylistSummarySchema.parse({
  id: 'playlist-late',
  library: 'tracks',
  type: 'playlist',
  name: 'Late shift',
  entryCount: 52,
  view: null,
  updatedAt: '2026-11-28T00:00:00.000Z',
})
const sample = [
  { id: 'track-1', title: 'Harbour Lights', creator: 'Mira Kestrel' },
  { id: 'track-2', title: 'Paper Moons', creator: 'Mira Kestrel' },
  { id: 'track-3', title: 'Slow Weather', creator: 'Ada Lune' },
  { id: 'track-4', title: 'Copper Wire', creator: 'Ada Lune' },
  { id: 'track-5', title: 'Salt Station', creator: 'Ada Lune' },
]

/** Visible text of each button, in document order. */
function buttons(html: string) {
  return [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((match) =>
    (match[1] ?? '').replace(/<[^>]+>/g, ''),
  )
}

test('the list step is headed by what is added, with Find a playlist', () => {
  const many = renderToStaticMarkup(
    <PickerListStep
      headingId="heading"
      subject={forty}
      search=""
      onSearch={unexpected}
    >
      <p>rows</p>
    </PickerListStep>,
  )
  assert.match(
    many,
    /^<div class="ds-pop-head" id="heading">Add 40 tracks to a playlist<\/div><label class="ds-search">/,
  )
  assert.match(
    many,
    /<input type="search" placeholder="Find a playlist" aria-label="Find a playlist"/,
  )
  const single = renderToStaticMarkup(
    <PickerListStep headingId="h" subject={one} search="" onSearch={unexpected}>
      {null}
    </PickerListStep>,
  )
  assert.match(single, />Add “Harbour Lights” to a playlist</)
})

test('a playlist shows its count, or a tick and Already added for one item it holds', () => {
  const counted = renderToStaticMarkup(
    <PickerPlaylistRow
      subject={forty}
      playlist={{ ...lateShift, containsItem: undefined }}
      onChoose={unexpected}
    />,
  )
  assert.match(counted, /lucide-list-music/)
  assert.match(
    counted,
    /<span class="ds-truncate">Late shift<\/span><span class="ds-muted">52 tracks<\/span>/,
  )
  const added = renderToStaticMarkup(
    <PickerPlaylistRow
      subject={one}
      playlist={{ ...lateShift, containsItem: true }}
      onChoose={unexpected}
    />,
  )
  assert.match(added, /lucide-check/)
  assert.match(added, /<span class="ds-muted">Already added<\/span>/)
  const pending = renderToStaticMarkup(
    <PickerPlaylistRow
      subject={forty}
      playlist={lateShift}
      feedback={{ phase: 'pending', label: 'Checking…' }}
      disabled
      onChoose={unexpected}
    />,
  )
  // The row that started a request shows its phase and stays in place.
  assert.match(
    pending,
    /<span class="ds-muted"><svg[^>]*>.*<\/svg><span>Checking…<\/span><\/span>/,
  )
  assert.doesNotMatch(pending, /disabled=""/)
})

test('New playlist asks for a name with Back and Create and add', () => {
  const many = renderToStaticMarkup(
    <PickerNewStep
      headingId="h"
      subject={forty}
      name="Ambient, rain"
      taken={false}
      onName={unexpected}
      onBack={unexpected}
      onSubmit={unexpected}
    />,
  )
  assert.match(
    many,
    /^<div class="ds-pop-head" id="h">New playlist<\/div><form class="ds-pop-form">/,
  )
  assert.match(
    many,
    /<label[^>]*>Name<\/label><input[^>]*value="Ambient, rain"/,
  )
  assert.deepEqual(buttons(many), ['Back', 'Create and add 40'])
  assert.match(many, /type="submit"[^>]*>Create and add 40</)
  assert.doesNotMatch(many, /A playlist with this name exists/)
  const taken = renderToStaticMarkup(
    <PickerNewStep
      headingId="h"
      subject={one}
      name="Late shift"
      taken
      onName={unexpected}
      onBack={unexpected}
      onSubmit={unexpected}
    />,
  )
  assert.match(
    taken,
    /<span class="ds-help" role="alert">A playlist with this name exists.<\/span>/,
  )
  assert.match(taken, /<button[^>]*disabled=""[^>]*>Create and add<\/button>/)
})

test('duplicates: some present offers Skip duplicates; all present and one item offer Add again', () => {
  const render = (
    subject: PlaylistSubject,
    check: { total: number; present: number; sample: typeof sample } | null,
  ) =>
    renderToStaticMarkup(
      <PickerDuplicatesStep
        headingId="h"
        subject={subject}
        playlistName="Late shift"
        check={check}
        feedback={() => undefined}
        busy={false}
        onCancel={unexpected}
        onAdd={unexpected}
      />,
    )
  const some = render(forty, { total: 40, present: 6, sample })
  assert.match(
    some,
    /^<div class="ds-pop-head ds-truncate" id="h" title="Late shift">Late shift<\/div><div class="ds-pop-form">/,
  )
  assert.match(some, /<ul class="ds-pop-evidence"><li class="ds-truncate">/)
  assert.match(some, /<b>6 of 40 tracks are already in this playlist.<\/b>/)
  assert.deepEqual(
    [...some.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((match) => match[1]),
    [
      'Harbour Lights · Mira Kestrel',
      'Paper Moons · Mira Kestrel',
      'Slow Weather · Ada Lune',
      'Copper Wire · Ada Lune',
      'Salt Station · Ada Lune',
      '+1 more',
    ],
  )
  assert.deepEqual(buttons(some), ['Cancel', 'Add again', 'Skip duplicates'])
  assert.match(some, /data-variant="primary"[^>]*>Skip duplicates</)
  assert.doesNotMatch(some, /data-variant="primary"[^>]*>Add again</)

  const every = render(forty, { total: 40, present: 40, sample })
  assert.match(every, /<b>All 40 tracks are already in this playlist.<\/b>/)
  assert.deepEqual(buttons(every), ['Cancel', 'Add again'])
  assert.match(every, /data-variant="primary"[^>]*>Add again</)

  const single = render(one, null)
  assert.match(single, /<b>“Harbour Lights” is already in this playlist.<\/b>/)
  assert.doesNotMatch(single, /<li/)
  assert.deepEqual(buttons(single), ['Cancel', 'Add again'])
})

test('the bar button is Add to playlist with a chevron, opening a dialog', () => {
  const html = renderToStaticMarkup(<AddToPlaylistButton subject={forty} />)
  assert.match(
    html,
    /^<button class="ds-btn" popoverTarget="[^"]+" aria-haspopup="dialog" aria-expanded="false" aria-controls="[^"]+">Add to playlist<svg[^>]*lucide-chevron-down/,
  )
  assert.match(
    renderToStaticMarkup(<AddToPlaylistButton subject={forty} primary />),
    /data-variant="primary"/,
  )
})

test('the bar button is disabled when no ticked row is in the library', () => {
  const html = renderToStaticMarkup(
    <AddToPlaylistButton
      subject={{ ...forty, selection: { ids: [] }, count: 0 }}
    />,
  )
  assert.match(
    html,
    /^<button class="ds-btn" disabled="" title="Items outside the library cannot be added to a playlist\." popoverTarget=/,
  )
  assert.doesNotMatch(
    renderToStaticMarkup(<AddToPlaylistButton subject={forty} />),
    /disabled|title=/,
  )
})
