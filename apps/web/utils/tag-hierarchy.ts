import type { TagHierarchyNode } from '@repo/schemas/tags'

export type TagTreeSortKey = 'name' | 'mediaCount' | 'totalCount'

export type TagTreeRow = {
  /** The path of tag IDs from the top level; unique per row. */
  key: string
  node: TagHierarchyNode
  depth: number
  /** Direct subtags of the tag, wherever it is listed. */
  subtags: number
  /** Whether the row has subtags it can show. */
  expandable: boolean
  expanded: boolean
}

export type TagTree = {
  rows: TagTreeRow[]
  /** True when more rows would be shown than the limit allows. */
  capped: boolean
  /** Tags whose name matches the search; every tag without a search. */
  matches: number
}

/** Direct subtags of each tag, in the order the nodes were listed. */
export function tagHierarchyChildren(nodes: readonly TagHierarchyNode[]) {
  const known = new Set(nodes.map((node) => node.id))
  const children = new Map<string, TagHierarchyNode[]>()
  for (const node of nodes)
    for (const parentId of new Set(node.parentIds)) {
      if (!known.has(parentId)) continue
      const list = children.get(parentId)
      if (list) list.push(node)
      else children.set(parentId, [node])
    }
  return children
}

function compareNodes(
  a: TagHierarchyNode,
  b: TagHierarchyNode,
  sortBy: TagTreeSortKey,
  direction: 'asc' | 'desc',
) {
  const sign = direction === 'asc' ? 1 : -1
  const byName =
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
  if (sortBy === 'name') return sign * byName
  return sign * (a[sortBy] - b[sortBy]) || byName
}

/**
 * The rows of the tag hierarchy table. Top-level tags are those without a
 * known parent; a tag with several parents is listed under each of them.
 * Siblings are sorted by `sortBy`. A row's subtags are listed while its key is
 * in `expanded`. With a search, only matching tags and their ancestors are
 * listed, and ancestors are expanded unless their key is in `expanded`, which
 * then means collapsed. A tag never appears beneath itself, so a loop in the
 * data ends the branch. At most `limit` rows are returned.
 */
export function flattenTagHierarchy(
  nodes: readonly TagHierarchyNode[],
  {
    expanded,
    search = '',
    sortBy = 'name',
    direction = 'asc',
    limit = 500,
  }: {
    expanded: ReadonlySet<string>
    search?: string
    sortBy?: TagTreeSortKey
    direction?: 'asc' | 'desc'
    limit?: number
  },
): TagTree {
  const children = tagHierarchyChildren(nodes)
  const known = new Set(nodes.map((node) => node.id))
  const query = search.trim().toLocaleLowerCase()
  const matching = new Set(
    nodes
      .filter((node) => !query || node.name.toLocaleLowerCase().includes(query))
      .map((node) => node.id),
  )
  // Tags that match or have a matching tag beneath them.
  const relevant = new Map<string, boolean>()
  function isRelevant(id: string, path: ReadonlySet<string>): boolean {
    const cached = relevant.get(id)
    if (cached !== undefined) return cached
    const next = new Set(path).add(id)
    const result =
      matching.has(id) ||
      (children.get(id) ?? []).some(
        (child) => !next.has(child.id) && isRelevant(child.id, next),
      )
    relevant.set(id, result)
    return result
  }
  const sorted = (list: readonly TagHierarchyNode[]) =>
    [...list].sort((a, b) => compareNodes(a, b, sortBy, direction))
  const rows: TagTreeRow[] = []
  let capped = false
  function visit(
    node: TagHierarchyNode,
    depth: number,
    path: ReadonlySet<string>,
    parentKey: string,
  ) {
    if (capped) return
    if (rows.length >= limit) {
      capped = true
      return
    }
    const key = parentKey ? `${parentKey}/${node.id}` : node.id
    const next = new Set(path).add(node.id)
    const below = (children.get(node.id) ?? []).filter(
      (child) => !next.has(child.id),
    )
    const shown = query
      ? below.filter((child) => isRelevant(child.id, next))
      : below
    const listed = shown.length ? shown : below
    const automatic = Boolean(query) && shown.length > 0
    const open = listed.length > 0 && automatic !== expanded.has(key)
    rows.push({
      key,
      node,
      depth,
      subtags: children.get(node.id)?.length ?? 0,
      expandable: listed.length > 0,
      expanded: open,
    })
    if (open)
      for (const child of sorted(listed)) visit(child, depth + 1, next, key)
  }
  const roots = nodes.filter(
    (node) => !node.parentIds.some((parentId) => known.has(parentId)),
  )
  for (const root of sorted(roots))
    if (!query || isRelevant(root.id, new Set())) visit(root, 0, new Set(), '')
  return { rows, capped, matches: matching.size }
}
