'use client'

import * as React from 'react'
import type { Editor } from '@tiptap/react'

import { useTiptapEditor } from '@repo/ui/hooks/use-tiptap-editor'
import { isExtensionAvailable } from '@repo/ui/lib/tiptap-utils'
import type { ButtonProps } from '@repo/ui/components/tip-tap/ui-primitive/button'
import { Button } from '@repo/ui/components/tip-tap/ui-primitive/button'
import { ChartIcon } from '@repo/ui/components/tip-tap/icons/chart-icon'

export interface ChartButtonProps extends Omit<ButtonProps, 'type'> {
  /**
   * Optional editor instance. When omitted, falls back to the context editor.
   */
  editor?: Editor | null
  /**
   * Optional label shown next to the icon.
   */
  text?: string
}

export const ChartButton = React.forwardRef<
  HTMLButtonElement,
  ChartButtonProps
>(({ editor: providedEditor, text, onClick, children, ...rest }, ref) => {
  const { editor } = useTiptapEditor(providedEditor)

  const [isVisible, setIsVisible] = React.useState(false)

  React.useEffect(() => {
    if (!editor) {
      setIsVisible(false)
      return
    }

    setIsVisible(isExtensionAvailable(editor, 'chart'))

    const handleUpdate = () => {
      setIsVisible(isExtensionAvailable(editor, 'chart'))
    }

    editor.on('update', handleUpdate)
    editor.on('selectionUpdate', handleUpdate)

    return () => {
      editor.off('update', handleUpdate)
      editor.off('selectionUpdate', handleUpdate)
    }
  }, [editor])

  if (!isVisible) {
    return null
  }

  const canInsert =
    !!editor?.isEditable &&
    editor.can().insertContent({
      type: 'chart',
    })

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (!editor) return

    editor.chain().focus().setChartNode().run()
  }

  return (
    <Button
      ref={ref}
      type="button"
      data-style="ghost"
      role="button"
      tabIndex={-1}
      tooltip="Insert chart"
      aria-label="Insert chart"
      aria-disabled={!canInsert}
      data-disabled={!canInsert}
      disabled={!canInsert}
      onClick={handleClick}
      {...rest}
    >
      {children ?? (
        <>
          <ChartIcon className="tiptap-button-icon" />
          {text && <span className="tiptap-button-text">{text}</span>}
        </>
      )}
    </Button>
  )
})

ChartButton.displayName = 'ChartButton'
