import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isWorkspaceHref,
  isWorkspaceTabGesture,
  resolveWorkspaceHref,
} from './workspace-tab-destination'

test('workspace URLs are root-relative authenticated pages with their view state', () => {
  for (const href of [
    '/films?view=grid#results',
    '/films/fixture%2Ffilm?tab=sources',
    '/collections/fixture?mediaType=album',
    '/mixes/shows/fixture',
    '/subscriptions/channels',
    '/channels/fixture',
    '/imports/spotify-podcasts?mediaType=subscription',
    '/tags?mediaType=album&tag=fixture',
    '/jobs/fixture',
    '/user?mediaType=track',
  ])
    assert.equal(isWorkspaceHref(href), true, href)

  for (const href of [
    '/login',
    '/api/v1/jobs',
    '/films/../login',
    '/films/%2e%2e/login',
    '/films/%E0%A4%A',
    '/films//fixture',
    '/imports/unknown',
    '/icons/fixture.svg',
    '//example.test/films',
    '/\\example.test/films',
    '/\n/[',
    'https://example.test/films',
  ])
    assert.equal(isWorkspaceHref(href), false, JSON.stringify(href))
})

test('links resolve within the app and keep parameters without capturing fragments or external links', () => {
  const current = new URL('https://example.test/films?view=table')
  const href = '/films/fixture?tab=cast&sortBy=name#results'
  assert.equal(resolveWorkspaceHref(href, current), href)
  assert.equal(
    resolveWorkspaceHref(`https://example.test${href}`, current),
    href,
  )
  assert.equal(resolveWorkspaceHref('?view=grid', current), '/films?view=grid')
  for (const destination of [
    '#results',
    `${current.href}#results`,
    'http://example.test/films/fixture',
    'https://other.test/films/fixture',
    'https://fixture@example.test/films/fixture',
    'mailto:fixture@example.test',
    'blob:https://example.test/films/fixture',
    'https://[',
    '/api/v1/scalar',
    '/login?next=/films',
  ])
    assert.equal(resolveWorkspaceHref(destination, current), null, destination)
})

test('only Alt-primary click and Alt+Enter are workspace gestures', () => {
  const modifiers = {
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
  }
  const click = { ...modifiers, button: 0 }
  const keydown = { ...modifiers, key: 'Enter', isComposing: false }
  assert.equal(isWorkspaceTabGesture(click), true)
  assert.equal(isWorkspaceTabGesture(keydown), true)
  for (const event of [
    { ...click, button: 1 },
    { ...click, button: 2 },
    { ...click, altKey: false },
    { ...click, metaKey: true },
    { ...click, ctrlKey: true },
    { ...click, shiftKey: true },
    { ...click, defaultPrevented: true },
    { ...keydown, key: ' ' },
    { ...keydown, isComposing: true },
  ])
    assert.equal(isWorkspaceTabGesture(event), false)
})
