import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { BrowseSuggestion } from '@/utils/browse-suggestions'
import BrowseFilterAutocomplete, {
  autocompleteEnterOption,
  autocompleteOptions,
  type BrowseFilterAutocompleteProps,
} from './browse-filter-autocomplete'

const suggestions: BrowseSuggestion[] = [
  {
    kind: 'item',
    item: { id: 'album-1', title: 'Rock album', label: 'Rock album' },
  },
  {
    kind: 'filter',
    filter: { field: 'genre', value: 'Rock', label: 'Tags: Rock', count: 12 },
  },
]

test('keyboard options retain suggestions, followed by text and explicit AI actions', () => {
  const options = autocompleteOptions(suggestions, ' rock ', true)
  assert.deepEqual(
    options.map((option) => option.key),
    ['item:album-1', 'filter:genre:Rock', 'action:text', 'action:ai'],
  )
  assert.equal(autocompleteEnterOption(options, 'action:text')?.kind, 'text')
  assert.equal(autocompleteEnterOption(options, 'action:ai')?.kind, 'ai')
  assert.equal(
    autocompleteEnterOption(options, 'filter:genre:Rock')?.kind,
    'suggestion',
  )
})

test('Enter with nothing highlighted selects no option, so the typed text is searched', () => {
  const options = autocompleteOptions(suggestions, 'rock', true)
  assert.equal(autocompleteEnterOption(options, null), undefined)
  assert.equal(
    autocompleteEnterOption(autocompleteOptions([], 'rock', true), null),
    undefined,
  )
  assert.equal(
    autocompleteEnterOption(autocompleteOptions([], '', true), null),
    undefined,
  )
})

test('Enter selects the option highlighted with the arrow keys', () => {
  const options = autocompleteOptions(suggestions, 'rock', true)
  assert.deepEqual(autocompleteEnterOption(options, 'item:album-1'), options[0])
  assert.deepEqual(
    autocompleteEnterOption(options, 'filter:genre:Rock'),
    options[1],
  )
})

test('empty input and absent AI integration do not offer AI actions', () => {
  assert.deepEqual(autocompleteOptions([], '  ', true), [])
  assert.deepEqual(autocompleteOptions([], 'rock', false), [
    { key: 'action:text', kind: 'text' },
  ])
  const disabled = autocompleteEnterOption(
    autocompleteOptions([], 'rock', true, true),
    'action:ai',
  )
  assert.deepEqual(disabled, {
    key: 'action:ai',
    kind: 'ai',
    disabled: true,
  })
})

test('active suggestion remains attached to its identity when results change order', () => {
  const options = autocompleteOptions([...suggestions].reverse(), 'rock', true)
  assert.equal(
    autocompleteEnterOption(options, 'item:album-1')?.key,
    'item:album-1',
  )
  assert.equal(autocompleteEnterOption(options, 'item:removed'), undefined)
})

test('input actions and interpretation content share the search root without opening suggestions', () => {
  const props: BrowseFilterAutocompleteProps = {
    options: [],
    items: [],
    titlesLoading: false,
    titlesError: false,
    placeholder: 'Search library',
    value: 'rock',
    onValueChange: () => assert.fail('Rendering must not change text'),
    onAddFilter: () => assert.fail('Rendering must not change filters'),
    onApplyText: () => assert.fail('Rendering must not search'),
    onOpenItem: () => assert.fail('Rendering must not open items'),
    onAiSearch: () => assert.fail('Rendering must not call AI'),
    hideSuggestions: true,
    disabled: true,
    inputActions: React.createElement(
      'button',
      { type: 'button' },
      'Microphone',
    ),
    children: React.createElement(
      'p',
      { role: 'status' },
      'Interpreting request',
    ),
  }
  const html = renderToStaticMarkup(
    React.createElement(BrowseFilterAutocomplete, props),
  )
  assert.match(html, /class="search-input-wrap has-actions"/)
  assert.match(html, /class="search-input-actions"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /disabled=""/)
  assert.match(html, /Microphone/)
  assert.match(html, /Interpreting request/)
  assert.doesNotMatch(html, /role="listbox"/)
  assert.doesNotMatch(html, /aria-activedescendant=/)
})

test('all indexed keyboard actions are inside the controlled listbox', () => {
  const source = ts.createSourceFile(
    'browse-filter-autocomplete.tsx',
    readFileSync(
      new URL('./browse-filter-autocomplete.tsx', import.meta.url),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let listbox: ts.JsxElement | undefined
  let option: ts.JsxElement | undefined
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node)) {
      for (const attribute of node.openingElement.attributes.properties) {
        if (
          !ts.isJsxAttribute(attribute) ||
          !attribute.initializer ||
          !ts.isStringLiteral(attribute.initializer) ||
          attribute.name.getText(source) !== 'role'
        )
          continue
        if (attribute.initializer.text === 'listbox') listbox = node
        if (attribute.initializer.text === 'option') option = node
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(listbox)
  assert.ok(option)
  assert.ok(option.pos >= listbox.pos && option.end <= listbox.end)
  assert.match(option.getText(source), /search-text-action/)
  assert.match(option.getText(source), /search-ai-action/)
  assert.match(option.getText(source), /aria-selected=/)
  assert.match(option.getText(source), /aria-disabled=/)
})
