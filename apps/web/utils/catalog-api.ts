import { CatalogObservationPageSchema } from '@repo/schemas/catalog'
import { ManualMediaAddResultSchema } from '@repo/schemas/manual-add'
import { fetchApiData } from './api'

export function addCatalogMedia(apiBaseUrl: string, id: string) {
  return fetchApiData(apiBaseUrl, `/api/v1/catalog/media/${encodeURIComponent(id)}/add`, ManualMediaAddResultSchema, { method: 'POST' })
}

export function catalogDiscoveries(apiBaseUrl: string, id: string, page: number, signal?: AbortSignal) {
  return fetchApiData(apiBaseUrl, `/api/v1/catalog/media/${encodeURIComponent(id)}/discoveries?page=${page}&size=10`, CatalogObservationPageSchema, { signal })
}
