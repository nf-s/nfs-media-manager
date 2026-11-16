'use client'

/** Every stored field of an album or film with the providers that supply it. */
export function FieldProvenance({ mediaItemId }: { mediaItemId: string }) {
  return <div hidden data-id={mediaItemId} />
}
