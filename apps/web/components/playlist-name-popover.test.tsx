import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PlaylistNameForm,
  playlistNameWording,
  type PlaylistNameMode,
} from './playlist-name-popover'

function form(
  mode: PlaylistNameMode,
  name: string,
  taken = false,
  help?: React.ReactNode,
) {
  return renderToStaticMarkup(
    <PlaylistNameForm
      headingId="name-heading"
      mode={mode}
      name={name}
      taken={taken}
      help={help}
      onName={() => undefined}
      onCancel={() => undefined}
      onSubmit={() => undefined}
    />,
  )
}

const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(
    ([, label]) => label,
  )

test('Rename and New playlist share the name step with their own heading and button', () => {
  const rename = form('rename', 'Late shift')
  assert.match(
    rename,
    /<div class="ds-pop-head" id="name-heading">Rename<\/div><form class="ds-pop-form">/,
  )
  assert.match(rename, /<label[^>]*>Name<\/label><input[^>]*value="Late shift"/)
  assert.deepEqual(buttons(rename), ['Cancel', 'Rename'])
  assert.match(rename, /<button[^>]*type="submit"[^>]*>Rename<\/button>/)

  const create = form('create', '')
  assert.match(create, /id="name-heading">New playlist<\/div>/)
  assert.deepEqual(buttons(create), ['Cancel', 'Create'])
  // Create waits for a name.
  assert.match(create, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>Create</)
  assert.doesNotMatch(create, /role="alert"/)
})

test('a taken name says so and disables the primary button', () => {
  const html = form('create', 'Late shift', true)
  assert.match(
    html,
    /<span class="ds-help" role="alert">A playlist with this name exists\.<\/span>/,
  )
  assert.match(html, /aria-invalid="true"/)
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>Create</)
})

test('Save smart playlist takes help lines under the field and Save', () => {
  const html = form(
    'save',
    'Ambient',
    false,
    <span className="ds-help">Lists what matches each time it is opened.</span>,
  )
  assert.match(html, /id="name-heading">Save smart playlist<\/div>/)
  assert.ok(
    html.indexOf('<input') < html.indexOf('Lists what matches') &&
      html.indexOf('Lists what matches') < html.indexOf('>Cancel<'),
  )
  assert.deepEqual(buttons(html), ['Cancel', 'Save'])
  assert.deepEqual(
    Object.values(playlistNameWording).map(({ heading, submit }) => [
      heading,
      submit,
    ]),
    [
      ['Rename', 'Rename'],
      ['New playlist', 'Create'],
      ['Save smart playlist', 'Save'],
    ],
  )
})
