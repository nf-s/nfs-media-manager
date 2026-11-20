import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { ProviderMark } from '@repo/ui/components/ds/pill'
import { PlayHeaderButtons } from '@repo/ui/components/ds/play'

const play = (
  <PlayHeaderButtons
    title="Synthetic album"
    onPlay={() => undefined}
    onQueue={() => undefined}
  />
)

test('the play pair sits under the artwork and the logos on a line of their own', () => {
  const html = renderToStaticMarkup(
    <DetailHeader
      art={<span className="ds-art" />}
      kind="Album"
      title="Synthetic album"
      facts={['2019', '11 tracks']}
      play={play}
      links={<span className="service-links">logos</span>}
      actions={
        <>
          <DetailActionsSpacer />
          <button type="button">More</button>
        </>
      }
    />,
  )
  // The artwork and the pair share the first column.
  assert.match(
    html,
    /^<header class="ds-detail-head"><div class="ds-detail-side"><span class="ds-art"><\/span><div class="ds-detail-play"><button[^>]*aria-label="Play Synthetic album">/,
  )
  // Play is labelled; Queue is a square icon button named for its item.
  assert.match(
    html,
    /Play<\/button><button class="ds-btn" data-size="md" data-icon="" title="Add to queue" aria-label="Add Synthetic album to queue">/,
  )
  // Facts, then the logo line, then the actions.
  const facts = html.indexOf('class="ds-detail-facts"')
  const links = html.indexOf('class="ds-detail-links"')
  const actions = html.indexOf('class="ds-detail-actions"')
  assert.ok(facts > 0 && links > facts && actions > links)
  assert.doesNotMatch(
    html.slice(actions),
    /aria-label="Play|aria-label="Add .* to queue"/,
  )
})

test('without artwork the pair starts the action row, and no actions leave no row', () => {
  const bare = renderToStaticMarkup(
    <DetailHeader kind="Track" title="Synthetic track" play={play} />,
  )
  assert.match(bare, /data-art="none"/)
  assert.doesNotMatch(bare, /ds-detail-side|ds-detail-play/)
  assert.match(
    bare,
    /<div class="ds-detail-actions"><button[^>]*aria-label="Play Synthetic album"/,
  )
  const quiet = renderToStaticMarkup(
    <DetailHeader
      art={<span className="ds-art" />}
      kind="Person"
      title="Synthetic person"
    />,
  )
  assert.doesNotMatch(quiet, /ds-detail-actions|ds-detail-links/)
})

test('a provider mark is its logo in grey, or a globe without one', () => {
  assert.equal(
    renderToStaticMarkup(
      <ProviderMark name="Spotify" src="/icons/services/spotify.svg" />,
    ),
    '<span class="ds-logo" style="--ds-logo:url(&quot;/icons/services/spotify.svg&quot;)" role="img" aria-label="Spotify" title="Spotify"></span>',
  )
  const hidden = renderToStaticMarkup(
    <ProviderMark
      name="Last.fm"
      src="/icons/logos/lastfm.png"
      size="sm"
      hidden
    />,
  )
  assert.match(hidden, /data-size="sm"/)
  assert.match(hidden, /aria-hidden="true"/)
  assert.doesNotMatch(hidden, /role=|aria-label=|title=/)
  const globe = renderToStaticMarkup(<ProviderMark name="Fixture provider" />)
  assert.match(
    globe,
    /^<span class="ds-logo" data-none="" role="img" aria-label="Fixture provider" title="Fixture provider"><svg/,
  )
  assert.doesNotMatch(globe, /--ds-logo/)
})
