import type { MixStation } from '@repo/schemas/subscriptions'
import { lotRadioAdapter } from './lotradio-api'
import type { MixStationAdapter } from './mix-station'
import { ntsAdapter } from './nts-api'
import { rinseAdapter } from './rinse-api'

/** How each station's archive is read. */
export const mixStationAdapters: Record<MixStation, MixStationAdapter> = {
  rinse: rinseAdapter,
  nts: ntsAdapter,
  lotradio: lotRadioAdapter,
}
