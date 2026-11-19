import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TagHierarchyNode } from '@repo/schemas/tags'
import { flattenTagHierarchy, tagHierarchyChildren } from './tag-hierarchy'

function node(
  id: string,
  parentIds: string[] = [],
  counts: { mediaCount?: number; totalCount?: number; hidden?: boolean } = {},
): TagHierarchyNode {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    hidden: counts.hidden ?? false,
    mediaCount: counts.mediaCount ?? 1,
    totalCount: counts.totalCount ?? 1,
    parentIds,
  }
}

// Synthetic library: electronic > house > deep house; electronic and dance
// both parent "disco"; jazz > fusion.
const nodes = [
  node('jazz', [], { mediaCount: 9, totalCount: 12 }),
  node('electronic', [], { mediaCount: 3, totalCount: 40 }),
  node('dance', [], { mediaCount: 5, totalCount: 20 }),
  node('house', ['electronic'], { mediaCount: 10, totalCount: 15 }),
  node('deep house', ['house'], { mediaCount: 5, totalCount: 5 }),
  node('disco', ['electronic', 'dance'], { mediaCount: 7, totalCount: 7 }),
  node('fusion', ['jazz'], { mediaCount: 3, totalCount: 3, hidden: true }),
]

const keys = (rows: { key: string }[]) => rows.map((row) => row.key)

test('top-level tags start collapsed and sorted by name', () => {
  const tree = flattenTagHierarchy(nodes, { expanded: new Set() })
  assert.deepEqual(keys(tree.rows), ['dance', 'electronic', 'jazz'])
  assert.ok(tree.rows.every((row) => row.depth === 0 && !row.expanded))
  assert.ok(tree.rows.every((row) => row.expandable))
  assert.equal(tree.capped, false)
  assert.equal(tree.matches, nodes.length)
})

test('a tag with several parents is listed under each expanded parent', () => {
  const tree = flattenTagHierarchy(nodes, {
    expanded: new Set(['dance', 'electronic', 'electronic/house']),
  })
  assert.deepEqual(keys(tree.rows), [
    'dance',
    'dance/disco',
    'electronic',
    'electronic/disco',
    'electronic/house',
    'electronic/house/deep house',
    'jazz',
  ])
  const deep = tree.rows.find((row) => row.node.id === 'deep house')
  assert.equal(deep?.depth, 2)
  assert.equal(deep?.expandable, false)
  const electronic = tree.rows.find((row) => row.key === 'electronic')
  assert.equal(electronic?.subtags, 2)
  assert.deepEqual(tagHierarchyChildren(nodes).get('electronic')?.length, 2)
})

test('siblings sort by the chosen column at every level, names breaking ties', () => {
  const tree = flattenTagHierarchy(nodes, {
    expanded: new Set(['electronic']),
    sortBy: 'totalCount',
    direction: 'desc',
  })
  assert.deepEqual(keys(tree.rows), [
    'electronic',
    'electronic/house',
    'electronic/disco',
    'dance',
    'jazz',
  ])
  const byItems = flattenTagHierarchy(nodes, {
    expanded: new Set(),
    sortBy: 'mediaCount',
    direction: 'asc',
  })
  assert.deepEqual(keys(byItems.rows), ['electronic', 'dance', 'jazz'])
  const descending = flattenTagHierarchy(nodes, {
    expanded: new Set(),
    direction: 'desc',
  })
  assert.deepEqual(keys(descending.rows), ['jazz', 'electronic', 'dance'])
})

test('a loop in the data ends the branch instead of repeating', () => {
  const looped = [node('root'), node('a', ['root', 'b']), node('b', ['a'])]
  const tree = flattenTagHierarchy(looped, {
    expanded: new Set(['root', 'root/a', 'root/a/b', 'root/a/b/a']),
  })
  assert.deepEqual(keys(tree.rows), ['root', 'root/a', 'root/a/b'])
  const last = tree.rows.at(-1)
  assert.equal(last?.expandable, false)
  assert.equal(last?.subtags, 1)
  const searched = flattenTagHierarchy(looped, {
    expanded: new Set(),
    search: 'b',
  })
  assert.deepEqual(keys(searched.rows), ['root', 'root/a', 'root/a/b'])
})

test('a search shows matching tags with their ancestors expanded', () => {
  const tree = flattenTagHierarchy(nodes, {
    expanded: new Set(),
    search: ' DEEP ',
  })
  assert.deepEqual(keys(tree.rows), [
    'electronic',
    'electronic/house',
    'electronic/house/deep house',
  ])
  assert.deepEqual(
    tree.rows.map((row) => row.expanded),
    [true, true, false],
  )
  assert.equal(tree.matches, 1)
  const collapsed = flattenTagHierarchy(nodes, {
    expanded: new Set(['electronic/house']),
    search: 'deep',
  })
  assert.deepEqual(keys(collapsed.rows), ['electronic', 'electronic/house'])
  assert.equal(collapsed.rows[1]?.expanded, false)
})

test('a search lists a matching tag under each parent and keeps its own subtags collapsed', () => {
  const disco = flattenTagHierarchy(nodes, {
    expanded: new Set(),
    search: 'disco',
  })
  assert.deepEqual(keys(disco.rows), [
    'dance',
    'dance/disco',
    'electronic',
    'electronic/disco',
  ])
  const jazz = flattenTagHierarchy(nodes, {
    expanded: new Set(),
    search: 'jazz',
  })
  assert.deepEqual(keys(jazz.rows), ['jazz'])
  assert.equal(jazz.rows[0]?.expanded, false)
  assert.equal(jazz.rows[0]?.expandable, true)
  const opened = flattenTagHierarchy(nodes, {
    expanded: new Set(['jazz']),
    search: 'jazz',
  })
  assert.deepEqual(keys(opened.rows), ['jazz', 'jazz/fusion'])
  assert.deepEqual(
    flattenTagHierarchy(nodes, { expanded: new Set(), search: 'none' }).rows,
    [],
  )
})

test('rows stop at the limit and report that more exist', () => {
  const many = [
    node('top'),
    ...Array.from({ length: 10 }, (_, index) =>
      node(`child ${String(index).padStart(2, '0')}`, ['top']),
    ),
  ]
  const capped = flattenTagHierarchy(many, {
    expanded: new Set(['top']),
    limit: 5,
  })
  assert.equal(capped.rows.length, 5)
  assert.equal(capped.capped, true)
  const exact = flattenTagHierarchy(many, {
    expanded: new Set(['top']),
    limit: 11,
  })
  assert.equal(exact.rows.length, 11)
  assert.equal(exact.capped, false)
})
