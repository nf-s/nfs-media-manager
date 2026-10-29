'use client'

type ColumnOption<TColumnKey extends string> = {
  key: TColumnKey
  label: string
}

export default function ColumnVisibilityControl<TColumnKey extends string>({
  options,
  visibleColumnSet,
  visibleCount,
  onToggle,
}: {
  options: readonly ColumnOption<TColumnKey>[]
  visibleColumnSet: ReadonlySet<TColumnKey>
  visibleCount: number
  onToggle: (columnKey: TColumnKey) => void
}) {
  return (
    <details className="relative">
      <summary className="flex h-9 cursor-pointer list-none items-center justify-between gap-3 bg-[hsl(var(--secondary))] px-3 text-xs font-medium uppercase tracking-[0.08em] text-[hsl(var(--foreground))] marker:content-none">
        <span>Columns</span>
        <span className="text-[hsl(var(--muted-foreground))]">
          {visibleCount}/{options.length}
        </span>
      </summary>

      <div className="absolute right-0 top-full z-20 mt-1 min-w-56 bg-white p-2 shadow-[0_8px_24px_rgba(0,0,0,0.08)] ring-1 ring-[hsl(var(--border))]">
        <div className="grid gap-1">
          {options.map((option) => {
            const isChecked = visibleColumnSet.has(option.key)
            const isLocked = isChecked && visibleCount === 1

            return (
              <label
                key={option.key}
                className="flex items-center justify-between gap-3 px-2 py-1 text-sm hover:bg-[hsl(var(--muted))]"
              >
                <span>{option.label}</span>
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={isLocked}
                  onChange={() => onToggle(option.key)}
                />
              </label>
            )
          })}
        </div>
      </div>
    </details>
  )
}
