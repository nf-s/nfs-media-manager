import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MetadataSourceList, { MetadataSourceLinks } from './metadata-source-list'
import type { TagProvenancePage } from '@repo/schemas/tags'

test('compact source links omit identifiers and verbose attribution, deduplicate links and retain runtime labels', () => {
  const source: TagProvenancePage['items'][number] = {
    provider: 'fixture',
    providerLabel: 'Runtime fixture',
    source: 'upstream',
    rawName: 'verbose-original-name',
    sourceId: 'opaque-private-id',
    kind: 'keyword',
    onMedia: true,
    linkKind: 'tag',
    link: {
      provider: 'fixture',
      providerLabel: 'Runtime fixture',
      name: 'Tag',
      url: 'https://example.com/tag/one',
    },
  }
  const html = renderToStaticMarkup(
    <MetadataSourceLinks
      items={[
        source,
        { ...source, rawName: 'Another alias' },
        {
          ...source,
          onMedia: false,
          link: {
            ...source.link,
            provider: 'other',
            providerLabel: 'Elsewhere',
            name: 'Other',
            url: 'https://example.com/elsewhere',
          },
        },
      ]}
    />,
  )
  assert.equal((html.match(/href=/g) ?? []).length, 1)
  assert.match(html, /Runtime fixture/)
  assert.doesNotMatch(
    html,
    /verbose-original-name|opaque-private-id|Another alias|Elsewhere/,
  )
  assert.match(html, /target="_blank"/)
})

test('compact missing sources do not invent destinations', () => {
  const html = renderToStaticMarkup(<MetadataSourceLinks items={[]} />)
  assert.match(html, /No source links available/)
  assert.doesNotMatch(html, /href=/)
})

test('shows original names, aggregator provenance and source URLs as separate links', () => {
  const html = renderToStaticMarkup(
    <MetadataSourceList
      items={[
        {
          provider: 'mdblist',
          providerLabel: 'MDBList',
          source: 'imdb',
          rawName: 'imdb.art-history',
          kind: 'keyword',
          sourceId: 'mdblist:123',
          onMedia: true,
          link: {
            provider: 'imdb',
            providerLabel: 'IMDb',
            name: 'art-history',
            url: 'https://www.imdb.com/search/title/?keywords=art-history',
          },
          linkKind: 'tag',
        },
      ]}
    />,
  )
  assert.match(html, /imdb.art-history/)
  assert.match(html, /via MDBList/)
  assert.match(html, /mdblist:123/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /Merged elsewhere/)
})

test('marks global merged origins and missing links honestly without inventing a URL', () => {
  const html = renderToStaticMarkup(
    <MetadataSourceList
      items={[
        {
          provider: null,
          providerLabel: null,
          source: null,
          rawName: '<script>original tag</script>',
          kind: 'genre',
          onMedia: false,
          link: null,
          linkKind: null,
        },
      ]}
    />,
  )
  assert.match(html, /Elsewhere in library/)
  assert.match(html, /Unknown source/)
  assert.match(html, /Source cannot be identified from this import/)
  assert.doesNotMatch(html, /href=|<script>/)
})

test('distinguishes item fallbacks from actual tag links', () => {
  const html = renderToStaticMarkup(
    <MetadataSourceList
      items={[
        {
          provider: 'fixture',
          providerLabel: 'Fixture',
          source: null,
          rawName: 'Drama',
          kind: 'genre',
          onMedia: true,
          linkKind: 'item',
          link: {
            provider: 'fixture',
            providerLabel: 'Fixture',
            name: 'Drama',
            url: 'https://example.com/film/1',
          },
        },
      ]}
    />,
  )
  assert.match(html, /View film on Fixture/)
  assert.doesNotMatch(html, /View tag on source/)
})
