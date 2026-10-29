import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MergedTagSummary from './merged-tag-summary'

test('distinguishes the canonical name from visible merged names', () => {
  const html = renderToStaticMarkup(
    <MergedTagSummary
      tag={{ name: 'Art history' }}
      mergedNames={['art-history', 'history of art', 'Art History']}
    />,
  )
  assert.match(html, /font-medium">Art history<\/div>/)
  assert.match(
    html,
    /Merged from: <\/span>art-history, history of art, Art History/,
  )
  assert.doesNotMatch(html, /<details/)
})

test('shows three names before a closed native disclosure for the rest', () => {
  const html = renderToStaticMarkup(
    <MergedTagSummary
      tag={{ name: 'History' }}
      mergedNames={['one', 'two', 'three', 'four', 'five']}
    />,
  )
  assert.match(html, /one, two, three<details/)
  assert.match(html, /aria-label="Show 2 more merged tags for History"/)
  assert.match(html, /<li>four<\/li><li>five<\/li>/)
  assert.doesNotMatch(html, /<details[^>]*open/)
  assert.match(html, /max-h-32 overflow-y-auto overscroll-contain/)
})

test('deduplicates exact names and excludes empty or canonical names without mutating input', () => {
  const names = Object.freeze([' History ', '', '   ', 'old', ' old ', 'OLD'])
  const html = renderToStaticMarkup(
    <MergedTagSummary tag={{ name: 'History' }} mergedNames={names} />,
  )
  assert.match(html, /Merged from: <\/span>old, OLD/)
  assert.doesNotMatch(html, /<details/)
  assert.equal(names[0], ' History ')
})

test('does not claim a merge where no aliases exist', () => {
  const html = renderToStaticMarkup(
    <MergedTagSummary tag={{ name: 'Drama' }} mergedNames={[]} />,
  )
  assert.doesNotMatch(html, /No merged tags/)
  assert.doesNotMatch(html, /Merged from|<details/)
})

test('escapes canonical and merged names including accessible labels', () => {
  const html = renderToStaticMarkup(
    <MergedTagSummary
      tag={{ name: '<script>name</script>' }}
      mergedNames={['<img src=x>', 'two', 'three', '<script>four</script>']}
    />,
  )
  assert.match(html, /&lt;img src=x&gt;/)
  assert.match(html, /&lt;script&gt;four&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>|<img/)
})
