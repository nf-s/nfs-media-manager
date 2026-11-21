import type { z } from 'zod'
import type { JsonValue } from '@repo/media-plugin-sdk'
import { JsonValueSchema } from '@repo/schemas/common'
import type { db } from '@/lib/db'

export type ChangeTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0]
export type ChangeReader = Pick<typeof db, 'execute'>
export type ChangeDirection = 'undo' | 'redo'
export type ChangeEffectContext = { changeId: string }

/** Work an effect leaves until the change's scrobbled names have moved. */
export type AfterNames = () => Promise<void>

/**
 * Something a change did besides moving scrobbled track names, written so it
 * can be put back and made again: joining versions, moving an album position
 * or a credit, storing a decision.
 */
export type ChangeEffectDefinition<Payload> = {
  /** Stored with every effect of this kind. Never rename a type in use. */
  type: string
  payload: z.ZodType<Payload>
  /**
   * Why the effect cannot be undone, or made again, as things stand: what it
   * moved has been moved again, or is gone. Null when it can.
   */
  blocker(
    reader: ChangeReader,
    payload: Payload,
    direction: ChangeDirection,
    context: ChangeEffectContext,
  ): Promise<string | null>
  /**
   * Puts back what the effect changed, or makes it again. Runs under the
   * library writer lock, after the tracks the change removed are restored and
   * before its scrobbled names move. Returns work to run once they have, such
   * as recounting, or null.
   */
  apply(
    tx: ChangeTransaction,
    payload: Payload,
    direction: ChangeDirection,
    context: ChangeEffectContext,
  ): Promise<AfterNames | null>
  /**
   * Tracks the effect makes exist when it is applied in a direction, so the
   * change's names can move onto a track that is not archived: one that had
   * no row before the change. None when omitted.
   */
  restores?(payload: Payload, direction: ChangeDirection): string[]
}

/** An effect as stored with a change. */
export type ChangeEffectEntry = {
  type: string
  /** The records the effect touched, for the changes of one record. */
  recordIds: string[]
  payload: JsonValue
}

/** An effect's handler with its payload read from storage. */
export type ChangeEffectHandler = {
  type: string
  blocker(
    reader: ChangeReader,
    payload: unknown,
    direction: ChangeDirection,
    context: ChangeEffectContext,
  ): Promise<string | null>
  apply(
    tx: ChangeTransaction,
    payload: unknown,
    direction: ChangeDirection,
    context: ChangeEffectContext,
  ): Promise<AfterNames | null>
  restores(payload: unknown, direction: ChangeDirection): string[]
}

/**
 * Defines a kind of effect. `handler` goes in the list its module exports for
 * `library-change-effects.ts`; `entry` builds the effect to hand to
 * `recordChange`. Modules that define effects must not import
 * `library-changes.ts`, which imports them.
 */
export function defineChangeEffect<Payload>(
  definition: ChangeEffectDefinition<Payload>,
) {
  const handler: ChangeEffectHandler = {
    type: definition.type,
    blocker: (reader, payload, direction, context) =>
      definition.blocker(
        reader,
        definition.payload.parse(payload),
        direction,
        context,
      ),
    apply: (tx, payload, direction, context) =>
      definition.apply(
        tx,
        definition.payload.parse(payload),
        direction,
        context,
      ),
    restores: (payload, direction) =>
      definition.restores?.(definition.payload.parse(payload), direction) ?? [],
  }
  return {
    handler,
    entry: (payload: Payload, recordIds: string[]): ChangeEffectEntry => ({
      type: definition.type,
      recordIds: [...new Set(recordIds)],
      payload: JsonValueSchema.parse(payload),
    }),
  }
}
