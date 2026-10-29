import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { env } from '@/env'

function getKey(): Buffer {
  return createHash('sha256').update(env.MEDIA_ENCRYPTION_KEY).digest()
}

export function encryptSecretValue(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`
}

export function decryptSecretValue(value: string): string {
  const [ivPart, tagPart, encryptedPart] = value.split('.')

  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error('Invalid encrypted secret format')
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(ivPart, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'))

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64')),
    decipher.final(),
  ])

  return decrypted.toString('utf8')
}
