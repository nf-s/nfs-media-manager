import { createAuthClient as createReactAuthClient } from 'better-auth/react'

export const createAuthClient = (baseURL: string) => {
  return createReactAuthClient({
    baseURL,
  })
}
