'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  type ButtonSize,
  type ButtonVariant,
} from '@repo/ui/components/ui/button'

/**
 * The one confirmation pattern: a popover on the button that started the
 * action, with the question, what happens, the action and Cancel. When
 * `confirm` is false the button acts at once.
 */
export function ConfirmAction({
  children,
  question,
  details,
  confirmLabel,
  onConfirm,
  confirm = true,
  variant = 'default',
  confirmVariant,
  size,
  disabled,
  title,
  ariaLabel,
  icon = false,
}: {
  children: ReactNode
  question: string
  details?: ReactNode
  confirmLabel: string
  onConfirm: () => void
  confirm?: boolean
  variant?: ButtonVariant
  confirmVariant?: 'primary' | 'danger'
  size?: ButtonSize
  disabled?: boolean
  title?: string
  ariaLabel?: string
  /** A square icon-only trigger; needs `ariaLabel`. */
  icon?: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => setMounted(true), [])
  useEffect(() => {
    if (!open) return
    function position() {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      panel.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`
      const below = rect.bottom + 4
      panel.current.style.top = `${
        below + box.height > window.innerHeight - 8
          ? Math.max(8, rect.top - box.height - 4)
          : below
      }px`
    }
    position()
    cancel.current?.focus()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])
  if (!confirm)
    return (
      <Button
        type="button"
        variant={variant}
        size={size}
        icon={icon}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        onClick={onConfirm}
      >
        {children}
      </Button>
    )
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant={variant}
        size={size}
        icon={icon}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
      >
        {children}
      </Button>
      {mounted &&
        createPortal(
          <div
            ref={panel}
            id={id}
            popover="auto"
            role="dialog"
            aria-label={question}
            className="ds-pop sec-confirm"
            onToggle={(event) => setOpen(event.newState === 'open')}
          >
            <strong>{question}</strong>
            {details != null && details !== false && (
              <p className="ds-help">{details}</p>
            )}
            <span className="ds-actions">
              <Button
                type="button"
                variant={
                  confirmVariant ??
                  (variant === 'danger' ? 'danger' : 'primary')
                }
                onClick={() => {
                  panel.current?.hidePopover()
                  trigger.current?.focus()
                  onConfirm()
                }}
              >
                {confirmLabel}
              </Button>
              <Button
                ref={cancel}
                type="button"
                onClick={() => {
                  panel.current?.hidePopover()
                  trigger.current?.focus()
                }}
              >
                Cancel
              </Button>
            </span>
          </div>,
          document.body,
        )}
    </>
  )
}
