import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SectionSidebar, SectionWorkspace } from './section-sidebar'

test('renders route destinations with only the current page marked active', () => {
  const html = renderToStaticMarkup(
    <SectionSidebar
      label="Jobs navigation"
      activeId="metadata"
      items={[
        { id: 'monitor', label: 'Jobs & history', href: '/jobs' },
        {
          id: 'metadata',
          label: 'Metadata',
          href: '/jobs/metadata',
        },
      ]}
    />,
  )
  assert.match(html, /aria-label="Jobs navigation"/)
  assert.equal((html.match(/aria-current=/g) ?? []).length, 1)
  assert.match(html, /aria-current="page"[^>]*href="\/jobs\/metadata"/)
  assert.match(html, /href="\/jobs"/)
  assert.doesNotMatch(html, /href="\/jobs\/(new|refresh)"/)
  assert.doesNotMatch(html, /<button/)
})

test('supports provider selection without submitting forms or invoking actions on render', () => {
  let selected = false
  const html = renderToStaticMarkup(
    <SectionSidebar
      label="Providers"
      activeId="example"
      items={[
        {
          id: 'example',
          label: 'Example',
          description: 'Scraping enabled',
          onSelect: () => {
            selected = true
          },
        },
      ]}
    />,
  )
  assert.match(html, /<button type="button" aria-current="true"/)
  assert.match(html, /<span>Scraping enabled<\/span>/)
  assert.equal(selected, false)
  assert.doesNotMatch(html, /href=/)
})

test('keeps sidebar and page content in separate scroll layout regions', () => {
  const html = renderToStaticMarkup(
    <SectionWorkspace sidebar={<nav>Navigation</nav>}>
      <section>Page content</section>
    </SectionWorkspace>,
  )
  assert.match(
    html,
    /class="section-workspace"><nav>Navigation<\/nav><div class="section-content"><section>Page content/,
  )
})

test('escapes labels and descriptions supplied by providers', () => {
  const html = renderToStaticMarkup(
    <SectionSidebar
      label="Providers"
      activeId="example"
      items={[
        {
          id: 'example',
          label: '<script>unsafe</script>',
          description: '<img src=x>',
          onSelect: () => {},
        },
      ]}
    />,
  )
  assert.doesNotMatch(html, /<script>|<img/)
  assert.match(html, /&lt;script&gt;/)
})
