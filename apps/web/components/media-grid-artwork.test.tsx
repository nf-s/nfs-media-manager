import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MediaArtwork, { MediaArt, MediaThumb } from './media-artwork'
import { BrowseTagBadges } from './browse-controls'

test('tags render as filter pills: the first three and a count, never clipped or scrolled', () => {
  const tags = ['Tag one', 'Tag two', 'Tag three', 'Tag four', 'Tag five']
  const html = renderToStaticMarkup(
    <BrowseTagBadges tags={tags} onFilter={() => {}} />,
  )
  assert.match(html, /<span class="ds-pills" role="group" aria-label="Tags">/)
  for (const tag of tags.slice(0, 3))
    assert.ok(
      html.includes(
        `<button type="button" title="Tag: ${tag}" class="ds-pill"><span class="ds-pill-label">${tag}</span></button>`,
      ),
    )
  assert.doesNotMatch(html, /Tag four|Tag five/)
  assert.match(html, /<span class="ds-more" title="2 more">\+2<\/span>/)
  const two = renderToStaticMarkup(
    <BrowseTagBadges tags={tags} onFilter={() => {}} max={2} />,
  )
  assert.match(two, />\+3</)
  assert.doesNotMatch(html, /browse-tag-badges|overflow/)
})

test('artist tags shown in place of album tags use the outline pill', () => {
  const html = renderToStaticMarkup(
    <BrowseTagBadges
      tags={['Album tag']}
      artistTags={['Artist tag']}
      onFilter={() => {}}
    />,
  )
  assert.match(html, /title="Tag: Album tag" class="ds-pill">/)
  assert.match(
    html,
    /title="Artist tag: Artist tag" class="ds-pill" data-tone="outline"><span class="ds-pill-label">Artist tag<\/span><span class="sr-only">, artist tag<\/span>/,
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

test('cards and rows without artwork show the kind placeholder in its shape', () => {
  for (const src of [null, undefined, '']) {
    const card = renderToStaticMarkup(<MediaArt kind="film" src={src} />)
    assert.match(card, /^<span class="ds-art" data-ratio="poster">/)
    assert.match(card, /<span class="ds-art-fallback"><svg/)
    assert.doesNotMatch(card, /<img/)
    const thumb = renderToStaticMarkup(
      <MediaThumb kind="artist" src={src} size={40} />,
    )
    assert.match(thumb, /class="ds-thumb" data-ratio="round"/)
    assert.match(thumb, /--ds-thumb:40px/)
    assert.doesNotMatch(thumb, /<img/)
  }
  const image = renderToStaticMarkup(
    <MediaArt kind="album" src="https://example.test/cover.jpg" alt="" />,
  )
  assert.match(
    image,
    /<img class="ds-artimg" src="https:\/\/example.test\/cover.jpg"/,
  )
})

test('legacy artwork fallback text has small-text contrast on an opaque surface', () => {
  const css = readFileSync(
    new URL('../../../packages/ui/src/styles/browse.css', import.meta.url),
    'utf8',
  )
  const tokens = readFileSync(
    new URL(
      '../../../packages/ui/src/design-system/tokens.css',
      import.meta.url,
    ),
    'utf8',
  )
  const token = (name: string | undefined) =>
    name
      ? new RegExp(`${name}:\\s*#([a-f0-9]{6});`, 'i').exec(tokens)?.[1]
      : undefined
  const rule = (selector: string) =>
    new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`).exec(css)?.[1]
  const fallback = rule('browse-artwork-fallback')
  const surface = rule('browse-artwork')
  assert.ok(fallback)
  assert.ok(surface)
  const foreground = token(
    /(?:^|;)\s*color:\s*var\((--ds-[a-z0-9-]+)\);/i.exec(fallback)?.[1],
  )
  const background = token(
    /background:\s*var\((--ds-[a-z0-9-]+)\);/i.exec(surface)?.[1],
  )
  assert.ok(foreground)
  assert.ok(background)
  const ratio = (luminance(background) + 0.05) / (luminance(foreground) + 0.05)
  assert.ok(ratio >= 4.5, `Fallback contrast is ${ratio}:1`)
  assert.doesNotMatch(css, /gradient\(/)
})
