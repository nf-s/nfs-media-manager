'use client'

// Adapted from https://github.com/shadcn-ui/ui/blob/main/apps/www/components/copy-button.tsx
// License: MIT

import { CheckIcon, ClipboardIcon } from 'lucide-react'
import * as React from 'react'
import { cn } from '../../lib/utils'
import { Button } from './button'

interface CopyButtonProps extends React.ComponentProps<typeof Button> {
  value: string
  src?: string
}

export async function copyToClipboardWithMeta(value: string) {
  navigator.clipboard.writeText(value)
}

export function CopyButton({
  value,
  className,
  variant = 'outline',
  ...props
}: CopyButtonProps) {
  const [hasCopied, setHasCopied] = React.useState(false)

  React.useEffect(() => {
    setTimeout(() => {
      setHasCopied(false)
    }, 2000)
  }, [hasCopied])

  return (
    <Button
      size="default"
      variant={variant}
      className={cn('relative z-10 h-6 w-6 [&_svg]:h-3 [&_svg]:w-3', className)}
      onClick={(evt) => {
        copyToClipboardWithMeta(value)
        setHasCopied(true)
        evt.preventDefault()
      }}
      {...props}
    >
      <span className="sr-only">Copy</span>
      {hasCopied ? <CheckIcon /> : <ClipboardIcon />}
    </Button>
  )
}
