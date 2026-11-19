'use client'

import { useState } from 'react'
import {
  API_KEY_MAX_REQUESTS,
  API_KEY_MAX_WINDOW_SECONDS,
  ApiKeyRateLimitSchema,
  DEFAULT_API_KEY_RATE_LIMIT,
  type ApiKeyRateLimit,
} from '@repo/schemas/api-key'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Input } from '@repo/ui/components/ui/input'

export function readRateLimit(form: HTMLFormElement) {
  const fields = new FormData(form)
  return ApiKeyRateLimitSchema.parse(
    fields.get('rateLimit') === 'unlimited'
      ? { enabled: false }
      : {
          enabled: true,
          maxRequests: Number(fields.get('maxRequests')),
          windowSeconds: Number(fields.get('windowSeconds')),
        },
  )
}

export function ApiKeyRateLimitFields({
  initial = DEFAULT_API_KEY_RATE_LIMIT,
  disabled,
}: {
  initial?: ApiKeyRateLimit
  disabled: boolean
}) {
  const [enabled, setEnabled] = useState(initial.enabled)
  const finite = initial.enabled ? initial : DEFAULT_API_KEY_RATE_LIMIT
  return (
    <>
      <label className="ds-field">
        <span className="ds-label">Rate limit</span>
        <Select
          name="rateLimit"
          controlSize="md"
          value={enabled ? 'limited' : 'unlimited'}
          disabled={disabled}
          onChange={(event) => setEnabled(event.target.value === 'limited')}
        >
          <option value="limited">Limited</option>
          <option value="unlimited">Unlimited</option>
        </Select>
      </label>
      {enabled && (
        <>
          <label className="ds-field">
            <span className="ds-label">Maximum requests</span>
            <Input
              name="maxRequests"
              controlSize="md"
              type="number"
              min={1}
              max={API_KEY_MAX_REQUESTS}
              step={1}
              required
              defaultValue={finite.maxRequests}
              disabled={disabled}
            />
          </label>
          <label className="ds-field">
            <span className="ds-label">Window (seconds)</span>
            <Input
              name="windowSeconds"
              controlSize="md"
              type="number"
              min={1}
              max={API_KEY_MAX_WINDOW_SECONDS}
              step={1}
              required
              defaultValue={finite.windowSeconds}
              disabled={disabled}
            />
          </label>
        </>
      )}
    </>
  )
}
