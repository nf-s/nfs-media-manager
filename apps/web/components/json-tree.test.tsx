import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import JsonTree from './json-tree'

test('renders scalar values without losing false, zero or null', () => {
  for (const value of [false, 0, null, 'example']) {
    const html = renderToStaticMarkup(<JsonTree value={value} />)
    assert.ok(html.includes(String(value)))
  }
})

test('opens the root but does not render collapsed descendants or raw JSON', () => {
  const html = renderToStaticMarkup(
    <JsonTree value={{ nested: { secretChild: 'deep value' }, empty: [] }} />,
  )
  assert.match(html, /<details open="">/)
  assert.match(html, /2 keys/)
  assert.match(html, /1 keys/)
  assert.match(html, /0 items/)
  assert.doesNotMatch(html, /secretChild|deep value|<pre/)
  assert.match(html, /Raw JSON/)
})

test('bounds initial array rendering and offers another page', () => {
  const html = renderToStaticMarkup(
    <JsonTree
      value={Array.from({ length: 10000 }, (_, index) => `item-${index}`)}
    />,
  )
  assert.match(html, /10000 items/)
  assert.match(html, /item-49/)
  assert.doesNotMatch(html, /item-50/)
  assert.match(html, /Show 50 more \(9950 remaining\)/)
})

test('bounds large objects as well as arrays', () => {
  const html = renderToStaticMarkup(
    <JsonTree
      value={Object.fromEntries(
        Array.from({ length: 51 }, (_, index) => [`key-${index}`, index]),
      )}
    />,
  )
  assert.match(html, /key-49/)
  assert.doesNotMatch(html, /key-50/)
  assert.match(html, /Show 1 more \(1 remaining\)/)
})

test('escapes untrusted keys and scalar strings rather than injecting HTML', () => {
  const html = renderToStaticMarkup(
    <JsonTree value={{ '<script>': '<img src=x onerror=alert(1)>' }} />,
  )
  assert.doesNotMatch(html, /<script>|<img/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&lt;img/)
})
