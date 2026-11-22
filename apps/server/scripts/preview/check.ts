// Run by the preview command before any database step: proves that a child
// process resolves its settings to the preview database.
import { env } from '@/env'
import { assertPreviewDatabase } from './preview-database'

assertPreviewDatabase(env)
console.info('Preview settings checked.')
