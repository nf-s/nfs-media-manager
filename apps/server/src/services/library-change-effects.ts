import { albumMergeEffects } from './album-merge-effects'
import { albumTracklistEffects } from './album-tracklist-effect'
import { artistMergeEffects } from './artist-merge-effects'
import { automaticMatchEffects } from './automatic-match-effects'
import { keepSeparateEffects } from './keep-separate-effects'
import type { ChangeEffectHandler } from './library-change-effect'
import { trackVersionEffects } from './track-version-effects'

const handlers = new Map<string, ChangeEffectHandler>()
for (const handler of [
  ...trackVersionEffects,
  ...keepSeparateEffects,
  ...albumMergeEffects,
  ...albumTracklistEffects,
  ...artistMergeEffects,
  ...automaticMatchEffects,
]) {
  if (handlers.has(handler.type))
    throw new Error(`Change effect ${handler.type} is defined twice`)
  handlers.set(handler.type, handler)
}

/** The handler that can undo and redo a stored effect. */
export function changeEffectHandler(type: string) {
  return handlers.get(type)
}
