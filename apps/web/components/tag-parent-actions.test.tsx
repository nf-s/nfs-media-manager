import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TagSchema, type Tag } from '@repo/schemas/tags'
import TagActions from './tag-actions'
import TagParentActions from './tag-parent-actions'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

function tag(id: string, parents: Tag['parents'] = []): Tag {
  return TagSchema.parse({
    mediaType: 'film',
    id,
    name: `Synthetic ${id}`,
    kind: 'genre',
    mediaCount: 1,
    sources: [],
    sourceCount: 1,
    parents,
  })
}

function render(node: React.ReactNode) {
  const client = new QueryClient()
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{ appUrl: 'http://localhost', apiBaseUrl: 'http://localhost' }}
        >
          {node}
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

function button(html: string, label: string) {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html)
  assert.ok(match, label)
  return match[0]
}

test('the selection offers a parent picker and the parent actions', () => {
  const html = render(
    <TagParentActions
      tags={[tag('a'), tag('b', [{ id: 'p', name: 'Parent' }])]}
      onComplete={() => {}}
    />,
  )
  assert.match(html, /role="group" aria-label="Parent tags"/)
  assert.match(
    html,
    /<span class="ds-label">Parent tag for 2 selected tags<\/span>/,
  )
  assert.match(html, /aria-label="Find parent tag"/)
  assert.match(button(html, 'Add parent'), /disabled/)
  assert.match(button(html, 'Move under'), /disabled/)
  assert.doesNotMatch(button(html, 'Remove all parents'), /disabled/)
})

test('remove all parents is unavailable when no selected tag has a parent', () => {
  const html = render(
    <TagParentActions tags={[tag('a'), tag('b')]} onComplete={() => {}} />,
  )
  assert.match(button(html, 'Remove all parents'), /disabled/)
})

test('the selection bar opens the parent form only where a caller shows one', () => {
  const offered = render(
    <TagActions
      tags={[tag('a')]}
      parentsOpen={false}
      onParentsToggle={() => {}}
      onComplete={() => {}}
    />,
  )
  assert.match(button(offered, 'Parent tags'), /aria-expanded="false"/)
  assert.doesNotMatch(offered, /Add parent|Move under|Remove all parents/)
  const plain = render(<TagActions tags={[tag('a')]} onComplete={() => {}} />)
  assert.doesNotMatch(plain, />Parent tags</)
  assert.match(plain, />Hide</)
})
