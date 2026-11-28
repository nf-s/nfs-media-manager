'use client'

import { Button } from '@repo/ui/components/ui/button'
import { Section } from '@repo/ui/components/ds/facts'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { formatCount, formatDateTime } from '@repo/ui/lib/format'
import { retryDeviceStore } from '@/utils/device-store/bootstrap'
import type { StoreError } from '@/utils/device-store/protocol'
import {
  setDeviceStoreSetting,
  useDeviceStoreSetting,
  type DeviceStoreSetting as Setting,
} from '@/utils/device-store/setting'
import {
  useDeviceStoreStatus,
  type DeviceStoreStatus,
} from '@/utils/device-store/status'

const options: { value: Setting; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
]

/** One fixed sentence per failure; exception text is never shown. */
export const storeErrorText: Record<StoreError, string> = {
  'version-mismatch':
    "The server's library rows do not match this page's version. Reloading may fix it.",
  'not-loaded': "The copy's code could not be loaded.",
  'storage-unavailable': 'This browser cannot store the copy.',
  'storage-full': 'Storage in this browser is full.',
  unreadable:
    'The copy could not be read. Retry deletes it and fills it again.',
  unreachable: 'The server could not be reached.',
  failed: 'The copy could not be updated.',
}

/** The state line under the setting (DEVICE-42). */
export function deviceStoreStatusText(
  setting: Setting,
  status: DeviceStoreStatus,
): string {
  if (setting === 'off')
    return 'When on, Browse pages read a copy of the library saved in this browser.'
  switch (status.state) {
    case 'off':
    case 'starting':
      return 'Opening the copy…'
    case 'unavailable':
      return 'Not available in this browser. Browse pages read from the server.'
    case 'other-tab':
      return 'Another tab holds the copy. This tab reads from the server.'
    case 'waiting-for-feed':
      return 'The server is still preparing the copy. Browse pages read from the server until it is ready.'
    case 'filling':
      return `Filling: ${formatCount(status.rows)} rows saved. Browse pages read from the server until it is full.`
    case 'ready':
      return status.failed === undefined
        ? `Ready. Last synced ${formatDateTime(status.syncedAt)}.`
        : `Ready. Last synced ${formatDateTime(status.syncedAt)}. The last sync failed. ${storeErrorText[status.failed]}`
    case 'error':
      return `${storeErrorText[status.error]} Browse pages read from the server.`
    case 'signed-out':
      return 'The copy was deleted at sign-out.'
  }
}

/** Whether Browse pages read the copy of the library saved in this browser. */
export function DeviceStoreSetting() {
  const setting = useDeviceStoreSetting()
  const status = useDeviceStoreStatus()
  return (
    <Section title="Library copy" note="Saved in this browser">
      <Segmented
        label="Library copy"
        value={setting}
        options={options}
        onChange={setDeviceStoreSetting}
      />
      <p className="ds-help" role="status">
        {deviceStoreStatusText(setting, status)}
      </p>
      {setting === 'on' && status.state === 'error' && (
        <Button size="md" onClick={retryDeviceStore}>
          Retry
        </Button>
      )}
    </Section>
  )
}
