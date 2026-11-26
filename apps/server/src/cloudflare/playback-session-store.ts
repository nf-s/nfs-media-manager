import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import {
  SavedPlaybackSchema,
  SharedSonosRoomsReportSchema,
  SharedSonosRoomsStateSchema,
  type PlaybackReleaseInput,
  type PlaybackSyncInput,
} from '@repo/schemas/playback'
import {
  PlaybackDiagnosticsResultSchema,
  type PlaybackDiagnosticInput,
} from '@repo/schemas/playback-diagnostics'
import {
  PLAYBACK_DIAGNOSTIC_RETENTION_MS,
  updatePlaybackDiagnostics,
} from '@/services/playback-diagnostics'
import {
  canDispatchSonos,
  EMPTY_PLAYBACK_SESSION,
  PlaybackDriverSchema,
  PlaybackSessionSonosSchema,
  releasePlaybackSession,
  syncPlaybackSession,
  type PlaybackSessionRecord,
} from '@/services/playback-session'

const LEASE_KEY = 'lease'
const SONOS_KEY = 'sonos'
const SONOS_ROOMS_KEY = 'sonos-rooms'
const PARTS_KEY = 'state-parts'
const DIAGNOSTICS_KEY = 'playback-diagnostics'
/** Characters per stored value; well under the per-value storage limit. */
const PART_LENGTH = 500_000
const MAX_PARTS = 64

const LeaseSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    driver: PlaybackDriverSchema.nullable(),
  })
  .strict()

const PartsSchema = z.number().int().nonnegative().max(MAX_PARTS)
const SonosMetadataSchema = PlaybackSessionSonosSchema.omit({
  rooms: true,
}).extend({
  requested: SharedSonosRoomsStateSchema.shape.requested,
})

function storedJson<T>(json: unknown, schema: z.ZodType<T>): T | null {
  if (typeof json !== 'string') return null
  try {
    const state = schema.safeParse(JSON.parse(json))
    return state.success ? state.data : null
  } catch {
    return null
  }
}

function sameLease(a: PlaybackSessionRecord, b: PlaybackSessionRecord) {
  return (
    a.revision === b.revision &&
    a.driver?.clientId === b.driver?.clientId &&
    a.driver?.name === b.driver?.name &&
    a.driver?.expiresAt === b.driver?.expiresAt
  )
}

/**
 * One account's shared playback session. The lease and revision are saved on
 * every change; the state, which can be large, only when the revision moves.
 */
export class PlaybackSessionStore extends DurableObject<CloudflareBindings> {
  private record: PlaybackSessionRecord | undefined

  sync(input: PlaybackSyncInput) {
    return this.update((stored) =>
      syncPlaybackSession(stored, input, Date.now()),
    )
  }

  canDispatchSonos(clientId: string | null) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const stored = this.record ?? (await this.load())
      this.record = stored
      return canDispatchSonos(stored, clientId, Date.now())
    })
  }

  release(input: PlaybackReleaseInput) {
    return this.update((stored) =>
      releasePlaybackSession(stored, input, Date.now()),
    )
  }

  async appendDiagnostics(input: PlaybackDiagnosticInput[]) {
    await this.updateDiagnostics(input)
  }

  readDiagnostics() {
    return this.updateDiagnostics()
  }

  async alarm() {
    await this.updateDiagnostics()
  }

  private updateDiagnostics(input: PlaybackDiagnosticInput[] = []) {
    return this.ctx.storage.transaction(async (tx) => {
      const stored = await tx.get(DIAGNOSTICS_KEY)
      const previous =
        storedJson(stored, PlaybackDiagnosticsResultSchema)?.events ?? []
      const { events, changed } = updatePlaybackDiagnostics(
        previous,
        Date.now(),
        input,
      )
      if (events.length) {
        if (changed) await tx.put(DIAGNOSTICS_KEY, JSON.stringify({ events }))
        const oldest = Math.min(...events.map((event) => event.receivedAt))
        const expiry = oldest + PLAYBACK_DIAGNOSTIC_RETENTION_MS
        if ((await tx.getAlarm()) !== expiry) await tx.setAlarm(expiry)
      } else if (stored !== undefined) {
        await tx.delete(DIAGNOSTICS_KEY)
      }
      return { events }
    })
  }

  private update<T>(
    change: (stored: PlaybackSessionRecord) => {
      stored: PlaybackSessionRecord
      result: T
    },
  ): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const previous = this.record ?? (await this.load())
      const next = change(previous)
      if (
        !sameLease(previous, next.stored) ||
        previous.sonos !== next.stored.sonos
      ) {
        this.record = undefined
        await this.save(previous, next.stored)
      }
      this.record = next.stored
      return next.result
    })
  }

  /**
   * Reads the stored record. Anything saved under an earlier contract, or
   * left incomplete, is dropped rather than failing every later exchange.
   */
  private async load(): Promise<PlaybackSessionRecord> {
    const storage = this.ctx.storage
    const [leaseValue, sonosValue, roomsValue] = await Promise.all([
      storage.get(LEASE_KEY),
      storage.get(SONOS_KEY),
      storage.get(SONOS_ROOMS_KEY),
    ])
    const lease = LeaseSchema.safeParse(leaseValue)
    const metadata = storedJson(sonosValue, SonosMetadataSchema)
    const completed = storedJson(roomsValue, SharedSonosRoomsReportSchema)
    const shared =
      metadata || completed
        ? {
            sonos: {
              managed: metadata?.managed ?? false,
              clientId: metadata?.clientId ?? null,
              observed: metadata?.observed ?? null,
              rooms: {
                requested: Math.max(
                  metadata?.requested ?? 0,
                  completed?.id ?? 0,
                ),
                completed,
              },
            },
          }
        : {}
    if (!lease.success) return { ...EMPTY_PLAYBACK_SESSION, ...shared }
    const { revision, driver } = lease.data
    const record = { revision, state: null, driver, ...shared }
    const parts = PartsSchema.safeParse((await storage.get(PARTS_KEY)) ?? 0)
    if (!parts.success || parts.data === 0) return record
    let json = ''
    for (let index = 0; index < parts.data; index++) {
      const part = await storage.get(`state-${index}`)
      if (typeof part !== 'string') return record
      json += part
    }
    return { ...record, state: storedJson(json, SavedPlaybackSchema) }
  }

  private save(previous: PlaybackSessionRecord, next: PlaybackSessionRecord) {
    return this.ctx.storage.transaction(async (tx) => {
      if (next.revision !== previous.revision) {
        const json = next.state === null ? '' : JSON.stringify(next.state)
        const parts = Math.ceil(json.length / PART_LENGTH)
        if (parts > MAX_PARTS)
          throw new Error('Playback state exceeds the stored size limit')
        const stored = PartsSchema.safeParse((await tx.get(PARTS_KEY)) ?? 0)
        const stale = stored.success ? stored.data : MAX_PARTS
        for (let index = 0; index < parts; index++)
          await tx.put(
            `state-${index}`,
            json.slice(index * PART_LENGTH, (index + 1) * PART_LENGTH),
          )
        for (let index = parts; index < stale; index++)
          await tx.delete(`state-${index}`)
        await tx.put(PARTS_KEY, parts)
      }
      if (!sameLease(previous, next))
        await tx.put(LEASE_KEY, {
          revision: next.revision,
          driver: next.driver,
        })
      // Keep the completed list off the lease and observation write paths.
      if (next.sonos && previous.sonos !== next.sonos) {
        const { rooms, ...metadata } = next.sonos
        const before = previous.sonos
        if (
          metadata.managed !== before?.managed ||
          metadata.clientId !== before?.clientId ||
          metadata.observed !== before?.observed ||
          rooms.requested !== (before?.rooms.requested ?? 0)
        )
          await tx.put(
            SONOS_KEY,
            JSON.stringify({ ...metadata, requested: rooms.requested }),
          )
        if (rooms.completed && rooms.completed !== before?.rooms.completed)
          await tx.put(SONOS_ROOMS_KEY, JSON.stringify(rooms.completed))
      }
    })
  }
}
