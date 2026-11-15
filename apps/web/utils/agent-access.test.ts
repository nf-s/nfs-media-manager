import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiKeySchema } from '@repo/schemas/api-key'
import { apiKeyStatus, createAgentInstructions } from './agent-access'

const expiresAt = '2030-01-01T01:00:00.000Z'
const fixture = ApiKeySchema.parse({
  id: 'fixture',
  name: 'Fixture key',
  start: 'fixture',
  createdAt: '2030-01-01T00:00:00.000Z',
  expiresAt,
  lastRequest: null,
  enabled: true,
})

test('API key status observes the expiry boundary and prioritizes revocation', () => {
  const expiry = Date.parse(expiresAt)
  assert.equal(apiKeyStatus(fixture, expiry - 1), 'Active')
  assert.equal(apiKeyStatus(fixture, expiry), 'Expired')
  assert.equal(
    apiKeyStatus({ ...fixture, enabled: false }, expiry - 1),
    'Revoked',
  )
  assert.equal(apiKeyStatus({ ...fixture, enabled: false }, expiry), 'Revoked')
  assert.equal(apiKeyStatus({ ...fixture, expiresAt: null }, expiry), 'Active')
})

test('agent instructions give the authenticated API entry points and the exact expiry', () => {
  const key = 'synthetic-agent-key'
  const origin = 'https://media.example.test:9443'
  const instructions = createAgentInstructions({
    origin: `${origin}/user?mediaType=film`,
    key,
    expiresAt,
  })
  assert.ok(instructions.includes(`API base URL: ${origin}/api/v1\n`))
  assert.ok(
    instructions.includes(`API documentation: ${origin}/api/v1/scalar\n`),
  )
  assert.ok(instructions.includes(`OpenAPI schema: ${origin}/api/v1/doc\n`))
  assert.ok(instructions.includes(`Authorization: Bearer ${key}\n`))
  assert.ok(instructions.includes(`Access expires at: ${expiresAt}`))
  assert.ok(instructions.includes(`Send the key only to ${origin}`))
  assert.equal(instructions.split(key).length, 2)
  assert.doesNotMatch(instructions, /mediaType=film/)
})
