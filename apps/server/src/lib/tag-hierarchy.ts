export type TagEdge = { child: string; parent: string }

/** Whether `ancestor` sits above `node`, following parent links upward. */
function isAncestor(edges: TagEdge[], ancestor: string, node: string) {
  const parents = new Map<string, string[]>()
  for (const edge of edges)
    parents.set(edge.child, [...(parents.get(edge.child) ?? []), edge.parent])
  const seen = new Set<string>()
  const queue = [node]
  for (let current = queue.shift(); current; current = queue.shift()) {
    for (const parent of parents.get(current) ?? []) {
      if (parent === ancestor) return true
      if (seen.has(parent)) continue
      seen.add(parent)
      queue.push(parent)
    }
  }
  return false
}

/**
 * The hierarchy after tag groups are merged into one. The surviving group
 * inherits each merged group's parents and subtags, except a link that would
 * place a tag beneath itself or one of its own subtags.
 */
export function mergeTagEdges(
  edges: TagEdge[],
  sources: string[],
  target: string,
): TagEdge[] {
  const merged = new Set(sources)
  const result = edges.filter(
    (edge) => !merged.has(edge.child) && !merged.has(edge.parent),
  )
  for (const edge of edges) {
    if (!merged.has(edge.child) && !merged.has(edge.parent)) continue
    const next = {
      child: merged.has(edge.child) ? target : edge.child,
      parent: merged.has(edge.parent) ? target : edge.parent,
    }
    if (next.child === next.parent) continue
    if (
      result.some(
        (kept) => kept.child === next.child && kept.parent === next.parent,
      )
    )
      continue
    if (isAncestor(result, next.child, next.parent)) continue
    result.push(next)
  }
  return result
}
