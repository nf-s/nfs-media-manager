'use client'

import { Button } from '@repo/ui/components/ui/button'

export default function PaginationControls({
  page,
  pageCount,
  onPageChange,
}: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-xs uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
        Page {page} of {Math.max(pageCount, 1)}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
