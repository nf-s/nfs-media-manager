import {
  CatalogObservationPageSchema,
  type CatalogNativeKind,
} from '@repo/schemas/catalog'
import { ManualMediaAddResultSchema } from '@repo/schemas/manual-add'
import { fetchApiData } from './api'

export function addCatalogMedia(
  apiBaseUrl: string,
  id: string,
  kind: CatalogNativeKind | 'media' = 'media',
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/catalog/${kind}/${encodeURIComponent(id)}/add`,
    ManualMediaAddResultSchema,
    { method: 'POST' },
  )
}

export function catalogDiscoveries(
  apiBaseUrl: string,
  id: string,
  page: number,
  signal?: AbortSignal,
  kind: CatalogNativeKind | 'media' = 'media',
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/catalog/${kind}/${encodeURIComponent(id)}/discoveries?page=${page}&size=10`,
    CatalogObservationPageSchema,
    { signal },
  )
}
