import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import {
  SavedPlaybackSchema,
  type PlaybackReleaseInput,
  type PlaybackSyncInput,
} from '@repo/schemas/playback'
import {
  EMPTY_PLAYBACK_SESSION,
  PlaybackDriverSchema,
  releasePlaybackSession,
  syncPlaybackSession,
  type PlaybackSessionRecord,
} from '@/services/playback-session'

const LEASE_KEY = 'lease'
const PARTS_KEY = 'state-parts'
/** Characters per stored value; well under the per-value storage limit. */
const PART_LENGTH = 500_000
const MAX_PARTS = 64

const LeaseSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    driver: PlaybackDriverSchema.nullable(),
  })
  .strict()

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

  release(input: PlaybackReleaseInput) {
    return this.update((stored) =>
      releasePlaybackSession(stored, input, Date.now()),
    )
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
      if (!sameLease(previous, next.stored)) {
        this.record = undefined
        await this.save(previous, next.stored)
      }
      this.record = next.stored
      return next.result
    })
  }

  private async load(): Promise<PlaybackSessionRecord> {
    const storage = this.ctx.storage
    const lease = await storage.get(LEASE_KEY)
    if (lease === undefined) return EMPTY_PLAYBACK_SESSION
    const { revision, driver } = LeaseSchema.parse(lease)
    const parts = z
      .number()
      .int()
      .nonnegative()
      .max(MAX_PARTS)
      .parse((await storage.get(PARTS_KEY)) ?? 0)
    if (parts === 0) return { revision, state: null, driver }
    let json = ''
    for (let index = 0; index < parts; index++)
      json += z.string().parse(await storage.get(`state-${index}`))
    // A state saved under an earlier contract is dropped rather than failing
    // every later exchange.
    const state = SavedPlaybackSchema.safeParse(JSON.parse(json))
    return { revision, state: state.success ? state.data : null, driver }
  }

  private save(previous: PlaybackSessionRecord, next: PlaybackSessionRecord) {
    return this.ctx.storage.transaction(async (tx) => {
      if (next.revision !== previous.revision) {
        const json = next.state === null ? '' : JSON.stringify(next.state)
        const parts = Math.ceil(json.length / PART_LENGTH)
        if (parts > MAX_PARTS)
          throw new Error('Playback state exceeds the stored size limit')
        const stale = z
          .number()
          .int()
          .nonnegative()
          .max(MAX_PARTS)
          .parse((await tx.get(PARTS_KEY)) ?? 0)
        for (let index = 0; index < parts; index++)
          await tx.put(
            `state-${index}`,
            json.slice(index * PART_LENGTH, (index + 1) * PART_LENGTH),
          )
        for (let index = parts; index < stale; index++)
          await tx.delete(`state-${index}`)
        await tx.put(PARTS_KEY, parts)
      }
      await tx.put(LEASE_KEY, {
        revision: next.revision,
        driver: next.driver,
      })
    })
  }
}
