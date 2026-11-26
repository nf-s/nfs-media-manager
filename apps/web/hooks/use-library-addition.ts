'use client'

import {
  skipToken,
  queryOptions,
  useQueries,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { ButtonFeedback } from '@repo/ui/components/ui/button'

type LibraryTarget = {
  kind: string
  catalogId?: string | null
  externalId?: string | null
}

type LibraryReceipt = {
  feedback?: ButtonFeedback
  committedId?: string
  revision: number
  request?: Promise<string>
}

const receiptDuration = 3500
let nextRevision = 0
const receiptKey = (
  kind: string,
  source: 'catalog' | 'external',
  id: string,
) => ['library-addition-receipt', kind, source, id]

function receiptKeys({ kind, catalogId, externalId }: LibraryTarget) {
  return [
    ...(catalogId ? [receiptKey(kind, 'catalog', catalogId)] : []),
    ...(externalId ? [receiptKey(kind, 'external', externalId)] : []),
  ]
}

export function useLibraryAddition(
  target: LibraryTarget,
  recordedMembership?: boolean,
) {
  const client = useQueryClient()
  const { kind, catalogId, externalId } = target
  const identity = catalogId ?? externalId
  const previous = useRef<{ identity: string; inLibrary: boolean } | null>(null)
  useEffect(() => {
    if (!identity || recordedMembership === undefined) return
    if (
      previous.current?.identity === identity &&
      previous.current.inLibrary &&
      !recordedMembership
    )
      forgetLibraryAddition(client, { kind, catalogId, externalId })
    previous.current = { identity, inLibrary: recordedMembership }
  }, [client, kind, catalogId, externalId, identity, recordedMembership])
  return useQueries({
    queries: receiptKeys(target).map((queryKey) =>
      queryOptions<LibraryReceipt | null>({ queryKey, queryFn: skipToken }),
    ),
    combine: (results) =>
      results
        .flatMap(({ data }) => (data ? [data] : []))
        .sort((a, b) => b.revision - a.revision)[0],
  })
}

export function libraryAdditionUnavailable(
  client: QueryClient,
  target: LibraryTarget,
) {
  return receiptKeys(target).some((key) => {
    const receipt = client.getQueryData<LibraryReceipt>(key)
    return Boolean(receipt?.request || receipt?.committedId)
  })
}

/** A confirmed removal invalidates both the catalog ID and any saved aliases. */
export function forgetLibraryAddition(
  client: QueryClient,
  target: LibraryTarget,
) {
  const targets = receiptKeys(target)
  const known = new Set(
    targets.flatMap((key) => {
      const id = client.getQueryData<LibraryReceipt>(key)?.committedId
      return id ? [id] : []
    }),
  )
  for (const [key, receipt] of client.getQueriesData<LibraryReceipt>({
    queryKey: ['library-addition-receipt', target.kind],
  })) {
    if (receipt?.committedId && known.has(receipt.committedId))
      client.setQueryData(key, null)
  }
}

/** The write is complete as soon as its validated response returns an ID. */
export function saveLibraryAddition(
  client: QueryClient,
  target: LibraryTarget,
  write: () => Promise<string>,
) {
  const keys = receiptKeys(target)
  for (const key of keys) {
    const receipt = client.getQueryData<LibraryReceipt>(key)
    if (receipt?.request) return receipt.request
    if (receipt?.committedId) return Promise.resolve(receipt.committedId)
  }
  function publish(
    feedback: ButtonFeedback,
    catalogId?: string,
    request?: Promise<string>,
  ) {
    const receipt = {
      feedback,
      revision: ++nextRevision,
      request,
      committedId: catalogId,
    }
    const destinations = [...keys]
    if (catalogId && catalogId !== target.catalogId)
      destinations.push(receiptKey(target.kind, 'catalog', catalogId))
    for (const key of destinations) client.setQueryData(key, receipt)
    if (feedback.phase === 'done') {
      setTimeout(() => {
        for (const key of destinations)
          if (
            client.getQueryData<LibraryReceipt>(key)?.revision ===
            receipt.revision
          )
            client.setQueryData(key, {
              revision: receipt.revision,
              committedId: catalogId,
            })
      }, receiptDuration)
    }
  }

  const request = Promise.resolve()
    .then(write)
    .then(
      (id) => {
        publish({ phase: 'done', label: 'Added' }, id)
        return id
      },
      (error: unknown) => {
        const status =
          error !== null && typeof error === 'object' && 'statusCode' in error
            ? error.statusCode
            : undefined
        publish(
          typeof status === 'number' && status >= 400 && status < 500
            ? { phase: 'failed', label: 'Add failed · retry' }
            : { phase: 'unconfirmed', label: 'Add unconfirmed · retry' },
        )
        throw error
      },
    )
  publish({ phase: 'pending', label: 'Adding…' }, undefined, request)
  return request
}
