import React from 'react'
import type { TagSummary } from '@repo/schemas/tags'

export default function MergedTagSummary({
  tag,
  mergedNames,
}: {
  tag: Pick<TagSummary, 'name'>
  mergedNames: readonly string[]
}) {
  const names = [...new Set(mergedNames.map((name) => name.trim()))].filter(
    (name) => name.length > 0 && name !== tag.name.trim(),
  )
  const preview = names.slice(0, 3)
  const remaining = names.slice(3)

  return (
    <div className="min-w-0 break-words">
      <div className="font-medium">{tag.name}</div>
      {names.length > 0 && (
        <div className="text-xs">
          <span className="muted">Merged from: </span>
          {preview.join(', ')}
          {remaining.length > 0 && (
            <details className="mt-0.5">
              <summary
                className="cursor-pointer underline decoration-neutral-300 underline-offset-2"
                aria-label={`Show ${remaining.length} more merged tags for ${tag.name}`}
              >
                {remaining.length} more
              </summary>
              <ul
                className="my-1 max-h-32 overflow-y-auto overscroll-contain pl-3"
                aria-label={`Additional tags merged into ${tag.name}`}
              >
                {remaining.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
