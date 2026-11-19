import React from 'react'
import { formatTagName, type TagSummary } from '@repo/schemas/tags'

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
    <div className="dtl-identity">
      <strong>{formatTagName(tag.name)}</strong>
      {names.length > 0 && (
        <div className="ds-help">
          <span>Merged from: </span>
          {preview.join(', ')}
          {remaining.length > 0 && (
            <details>
              <summary
                aria-label={`Show ${remaining.length} more merged tags for ${formatTagName(tag.name)}`}
              >
                {remaining.length} more
              </summary>
              <ul
                className="dtl-merged-list"
                aria-label={`Additional tags merged into ${formatTagName(tag.name)}`}
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
