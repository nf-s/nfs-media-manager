import { normalizeTagName } from '@repo/schemas/tags'

/** How Sonovault's two name lists are recorded on tag occurrences (TTAG-02). */
export type SonovaultTagKind = 'genre' | 'subgenre'

/**
 * Sonovault names that join a different album tag than the one of the same
 * spelling (TTAG-06), keyed by normalised name. It is for a name whose album
 * tag means something else; each entry was reviewed by the owner (stage 4).
 */
export const sonovaultTagNameMap: ReadonlyMap<string, string> = new Map([
  // The album tag "garage" is hidden because it also means garage rock;
  // Sonovault's Garage is UK Garage and its relatives.
  ['garage', 'UK Garage'],
])

/** The tag name a Sonovault name is resolved by. */
export function sonovaultTagName(
  rawName: string,
  nameMap: ReadonlyMap<string, string> = sonovaultTagNameMap,
): string {
  return nameMap.get(normalizeTagName(rawName)) ?? rawName
}
