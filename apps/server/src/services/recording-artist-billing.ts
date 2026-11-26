type Credit = { id: string; name: string }

export function recordingCreditName(name: string) {
  return name.trim().toLowerCase()
}

function creditsByName(credits: readonly Credit[]) {
  const names = new Map<string, { name: string; ids: string[] }>()
  const ids = new Set<string>()
  for (const { id, name } of credits) {
    const key = recordingCreditName(name)
    if (!id || !key || ids.has(id)) return
    ids.add(id)
    const billed = names.get(key) ?? { name, ids: [] }
    billed.ids.push(id)
    names.set(key, billed)
  }
  return names
}

/** Compare complete provider bills without changing either provider's order. */
export function sharedRecordingBilling(
  left: readonly Credit[],
  right: readonly Credit[],
) {
  if (!left.length || left.length !== right.length) return []
  const leftNames = creditsByName(left)
  const rightNames = creditsByName(right)
  if (!leftNames || !rightNames) return []
  const groups: { name: string; leftIds: string[]; rightIds: string[] }[] = []
  for (const [key, { name, ids: leftIds }] of leftNames) {
    const rightIds = rightNames.get(key)?.ids
    if (!rightIds || leftIds.length !== rightIds.length) return []
    groups.push({ name, leftIds, rightIds })
  }
  return groups
}

/** Pair only the names that uniquely identify a credit on both recordings. */
export function matchRecordingArtistBilling(
  tidal: readonly Credit[],
  spotify: readonly Credit[],
) {
  return sharedRecordingBilling(tidal, spotify).flatMap(
    ({ name, leftIds, rightIds }) =>
      leftIds.length === 1 && leftIds[0] && rightIds[0]
        ? [{ tidalId: leftIds[0], spotifyId: rightIds[0], name }]
        : [],
  )
}
