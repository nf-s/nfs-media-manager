import {
  SharedSonosRoomsReportSchema,
  type SharedSonosRoomsReport,
  type SharedSonosRoomsState,
} from '@repo/schemas/playback'
import type { SonosRooms } from '@repo/schemas/sonos'

/** Opening the device menu requests one room list through the shared session. */
export function createPlaybackSonosRooms(
  read: () => Promise<SonosRooms>,
  sync: () => void,
  now: () => number,
) {
  let completed: number | undefined
  let lastExchange = 0
  let pending: {
    resolve: (rooms: SonosRooms) => void
    reject: (error: Error) => void
  }[] = []
  let reading: { id: number } | null = null
  let report: SharedSonosRoomsReport | undefined

  function cancelRead() {
    reading = null
    report = undefined
  }

  function unavailable() {
    for (const waiter of pending)
      waiter.reject(new Error('Sonos rooms could not be read.'))
    pending = []
  }

  return {
    load() {
      // A page returning from sleep may have missed an old refresh. Learn the
      // latest generation before requesting a new one for this menu opening.
      if (!pending.length && now() - lastExchange > 10_000)
        completed = undefined
      return new Promise<SonosRooms>((resolve, reject) => {
        pending.push({ resolve, reject })
        if (pending.length === 1) sync()
      })
    },
    waiting: () => pending.length > 0,
    cancelRead,
    unavailable,
    input() {
      return {
        sonosRoomsSeen: completed,
        ...(pending.length && completed !== undefined
          ? { sonosRoomsRequest: completed }
          : {}),
        ...(report && { sonosRoomsReport: report }),
      }
    },
    apply(state: SharedSonosRoomsState | undefined, driver: boolean) {
      lastExchange = now()
      if (!state) return
      const before = completed
      const last = state.completed
      completed = last?.id ?? 0
      if (before !== undefined && completed < before) cancelRead()
      if (pending.length && (before === undefined || completed < before)) sync()
      if (last && before !== undefined && last.id > before && pending.length) {
        if (last.result.ok) {
          for (const waiter of pending) waiter.resolve(last.result.rooms)
          pending = []
        } else unavailable()
      }
      if (report && completed >= report.id) report = undefined
      if (
        !driver ||
        state.requested <= completed ||
        reading?.id === state.requested ||
        report?.id === state.requested
      )
        return
      const ticket = { id: state.requested }
      reading = ticket
      void read().then(
        (rooms) => finish({ ok: true, rooms }),
        () => finish({ ok: false }),
      )
      function finish(result: SharedSonosRoomsReport['result']) {
        if (reading !== ticket) return
        reading = null
        const parsed = SharedSonosRoomsReportSchema.safeParse({
          id: ticket.id,
          result,
        })
        report = parsed.success
          ? parsed.data
          : { id: ticket.id, result: { ok: false } }
        sync()
      }
    },
  }
}
