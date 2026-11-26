'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ProviderSafetySchema } from '@repo/schemas/provider'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'

/**
 * Clears an active cooldown after a confirmation. The request names the
 * cooldown end it was shown, so a changed state is refused rather than cleared.
 */
export function useProviderCooldown(provider: string) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [confirming, setConfirming] = useState<string | null>(null)
  const clear = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${encodeURIComponent(provider)}/cooldown/clear`,
        ProviderSafetySchema,
        {
          method: 'POST',
          body: JSON.stringify({
            confirm: true,
            expectedCooldownUntil: confirming,
          }),
        },
      ),
    onSuccess: async () => {
      setConfirming(null)
      await client.invalidateQueries({ queryKey: ['providers'] })
      await client.invalidateQueries({
        queryKey: ['provider-activity', provider],
      })
      await client.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: ['providers'] })
    },
  })
  return {
    confirming,
    clear,
    start(until: string) {
      clear.reset()
      setConfirming(until)
    },
    cancel() {
      setConfirming(null)
    },
  }
}

export type ProviderCooldown = ReturnType<typeof useProviderCooldown>

/** The confirmation and the result of clearing a cooldown. */
export function ProviderCooldownConfirm({
  cooldown,
}: {
  cooldown: ProviderCooldown
}) {
  const { clear, confirming } = cooldown
  if (!confirming && !clear.isError && !clear.isSuccess) return null
  return (
    <div
      className="providers-confirm"
      role="region"
      aria-label="Clear cooldown"
    >
      {(confirming || clear.isSuccess) && (
        <>
          {confirming && (
            <p>
              Clear this cooldown early? Queued jobs may resume. Request
              spacing, request budgets and access blocks stay enforced.
            </p>
          )}
          <span className="ds-actions">
            <Button
              size="xs"
              variant="primary"
              disabled={clear.isPending || !confirming}
              feedback={mutationFeedback(clear, {
                pending: 'Clearing…',
                success: 'Cooldown cleared',
                error: 'Could not clear',
              })}
              onClick={() => clear.mutate()}
            >
              Confirm clear cooldown
            </Button>
            {confirming && (
              <Button
                size="xs"
                variant="ghost"
                disabled={clear.isPending}
                onClick={cooldown.cancel}
              >
                Cancel
              </Button>
            )}
          </span>
        </>
      )}
      {clear.isError && <p role="alert">{clear.error.message}</p>}
      {clear.isSuccess && <p>Request limits remain enforced.</p>}
    </div>
  )
}
