'use client'

export type MetadataCoverageKind = 'playlist' | 'artist'

/** How many albums of a playlist or artist each provider has data for. */
export function MetadataCoverage({
  kind,
  id,
}: {
  kind: MetadataCoverageKind
  id: string
}) {
  return <div hidden data-kind={kind} data-id={id} />
}
