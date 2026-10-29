import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

test('text action follows the complete listbox without becoming an indexed suggestion', () => {
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
  let textAction: ts.JsxElement | undefined
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node)) {
      for (const attribute of node.openingElement.attributes.properties) {
        if (
          !ts.isJsxAttribute(attribute) ||
          !attribute.initializer ||
          !ts.isStringLiteral(attribute.initializer)
        )
          continue
        if (
          attribute.name.getText(source) === 'role' &&
          attribute.initializer.text === 'listbox'
        )
          listbox = node
        if (
          attribute.name.getText(source) === 'className' &&
          attribute.initializer.text === 'search-text-action'
        )
          textAction = node
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(listbox)
  assert.ok(textAction)
  assert.ok(textAction.pos >= listbox.end)
  assert.doesNotMatch(textAction.getText(source), /role="option"/)
})
