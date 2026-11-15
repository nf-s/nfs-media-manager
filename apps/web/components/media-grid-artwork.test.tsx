import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MediaArtwork from './media-artwork'
import { BrowseTagBadges } from './browse-controls'

test('all artwork tags render as keyboard-accessible badges in a bounded strip', () => {
  const css = readFileSync(
    new URL('../../../packages/ui/src/globals.css', import.meta.url),
    'utf8',
  )
  const tags = ['Tag one', 'Tag two', 'Tag three', 'Tag four', 'Tag five']
  const html = renderToStaticMarkup(
    <BrowseTagBadges tags={tags} className="tile-tags" onFilter={() => {}} />,
  )
  assert.match(
    html,
    /class="browse-tag-badges tile-tags" role="group" aria-label="Tags"/,
  )
  for (const tag of tags)
    assert.ok(
      html.includes(
        `<button type="button" title="Tag: ${tag}">${tag}</button>`,
      ),
    )
  assert.match(
    css,
    /\.browse-tag-badges\s*\{[^}]+max-width:\s*100%[^}]+overflow-x:\s*auto/,
  )
})

test('artwork distinguishes artist tag fallbacks from album tags', () => {
  const html = renderToStaticMarkup(
    <BrowseTagBadges
      tags={['Album tag']}
      artistTags={['Artist tag']}
      onFilter={() => {}}
    />,
  )
  assert.match(html, /title="Tag: Album tag">Album tag<\/button>/)
  assert.match(
    html,
    /title="Artist tag: Artist tag">Artist tag<span[^>]*>Artist<\/span><\/button>/,
  )
  const complete = renderToStaticMarkup(
    <BrowseTagBadges
      tags={['Album tag', 'Second tag']}
      artistTags={['Artist tag']}
      onFilter={() => {}}
    />,
  )
  assert.doesNotMatch(complete, /Artist tag/)
})

test('missing grid artwork retains its title and album or film aspect ratio', () => {
  for (const aspect of ['aspect-square', 'aspect-[2/3]']) {
    for (const src of [null, undefined, '']) {
      const html = renderToStaticMarkup(
        <MediaArtwork
          src={src}
          alt="Fixture title"
          fallbackLabel="Fixture title & artist"
          imageClassName={`${aspect} object-cover w-full`}
          fallbackClassName={`${aspect} fallback`}
        />,
      )
      assert.match(html, /Fixture title &amp; artist/)
      assert.ok(html.includes(aspect))
      assert.match(html, /fallback/)
      assert.doesNotMatch(html, /<img/)
    }
  }
})

function luminance(hex: string) {
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const [red, green, blue] = channels
  if (red === undefined || green === undefined || blue === undefined)
    throw new Error('Missing fixture color channel')
  return red * 0.2126 + green * 0.7152 + blue * 0.0722
}

test('grid fallback text has small-text contrast on an opaque surface without gradients', () => {
  const css = readFileSync(
    new URL('./media-browser.module.css', import.meta.url),
    'utf8',
  )
  const fallback = /\.grid \.fallback\s*\{([^}]+)\}/.exec(css)?.[1]
  assert.ok(fallback)
  const foreground = /(?:^|;)\s*color:\s*#([a-f0-9]{6});/i.exec(fallback)?.[1]
  const background = /background:\s*#([a-f0-9]{6});/i.exec(fallback)?.[1]
  assert.ok(foreground)
  assert.ok(background)
  const ratio = (luminance(background) + 0.05) / (luminance(foreground) + 0.05)
  assert.ok(ratio >= 4.5, `Fallback contrast is ${ratio}:1`)
  assert.match(fallback, /overflow-wrap: anywhere/)
  assert.doesNotMatch(css, /gradient\(/)
})
