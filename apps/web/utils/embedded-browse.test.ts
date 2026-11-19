import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  browseStateKeys,
  embeddedBrowseHref,
  embeddedLayout,
  withEmbeddedLayout,
  type EmbeddedBrowse,
} from './embedded-browse'

const sort = {
  key: 'title',
  direction: 'asc',
} satisfies EmbeddedBrowse['sort']

test('The Show in link carries the scope and the list settings, nothing else', () => {
  const settings = new URLSearchParams({
    tab: 'tracks',
    inspect: '[]',
    q: 'night',
    filters: '[{"field":"genre","value":"Ambient","mode":"required"}]',
    listening: '{"rules":[]}',
    sortBy: 'scrobbles',
    direction: 'desc',
    view: 'grid',
    columns: '',
  })
  const href = embeddedBrowseHref(
    'tracks',
    { creatorId: 'artist-example' },
    settings,
  )
  const [path, query] = href.split('?')
  assert.equal(path, '/tracks')
  const params = new URLSearchParams(query)
  assert.deepEqual(
    [...params.keys()],
    ['creatorId', 'q', 'filters', 'listening', 'sortBy', 'direction', 'view'],
  )
  assert.equal(params.get('creatorId'), 'artist-example')
  assert.equal(params.get('q'), 'night')
  assert.equal(params.get('view'), 'grid')
})

test('a list setting cannot replace the scope it is held to', () => {
  // `creatorId` is not a list setting, so the detail's own query cannot move
  // the list to another creator.
  assert.equal(
    browseStateKeys.some((key) => key === 'creatorId' || key === 'sourceId'),
    false,
  )
  const href = embeddedBrowseHref(
    'albums',
    { creatorId: 'artist-example' },
    new URLSearchParams({ creatorId: 'artist-other', sortBy: 'title' }),
  )
  assert.equal(href, '/albums?creatorId=artist-example&sortBy=title')
})

test('the remembered layout is the sort and the columns, not search or filters', () => {
  assert.equal(
    embeddedLayout(
      new URLSearchParams({
        tab: 'tracks',
        q: 'night',
        filters: '[]',
        ranges: '[]',
        listening: '{"rules":[]}',
        view: 'grid',
        density: 'compact',
        sortBy: 'scrobbles',
        direction: 'desc',
        columns: 'title,album',
        columnOrder: 'album,title',
      }),
    ),
    'sortBy=scrobbles&direction=desc&columns=title%2Calbum&columnOrder=album%2Ctitle',
  )
})

test('a list starts in its own order until a layout is remembered', () => {
  const fresh = withEmbeddedLayout(new URLSearchParams('tab=tracks'), '', sort)
  assert.equal(fresh.toString(), 'tab=tracks&sortBy=title&direction=asc')

  const remembered = withEmbeddedLayout(
    new URLSearchParams('tab=tracks'),
    'sortBy=scrobbles&direction=desc&columns=title%2Calbum',
    sort,
  )
  assert.equal(remembered.get('sortBy'), 'scrobbles')
  assert.equal(remembered.get('direction'), 'desc')
  assert.equal(remembered.get('columns'), 'title,album')
})

test('the URL wins over the remembered layout', () => {
  const params = withEmbeddedLayout(
    new URLSearchParams('sortBy=releaseDate&columns=title'),
    'sortBy=scrobbles&direction=asc&listeningSort=%7B%7D&columns=title%2Calbum&columnOrder=album%2Ctitle',
    sort,
  )
  assert.equal(params.get('sortBy'), 'releaseDate')
  // The remembered direction and period belong to the remembered sort.
  assert.equal(params.has('direction'), false)
  assert.equal(params.has('listeningSort'), false)
  assert.equal(params.get('columns'), 'title')
  assert.equal(params.get('columnOrder'), 'album,title')
})

test('a direction chosen for the starting order is kept', () => {
  const params = withEmbeddedLayout(
    new URLSearchParams('direction=desc'),
    '',
    sort,
  )
  assert.equal(params.get('sortBy'), 'title')
  assert.equal(params.get('direction'), 'desc')
})
