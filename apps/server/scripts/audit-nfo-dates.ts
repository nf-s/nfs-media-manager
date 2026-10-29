import { stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { env } from '@/env'
import { db } from '@/lib/db'
import {
  auditNfoDates,
  applyNfoDateAudit,
  summarizeNfoAudit,
} from '@/services/nfo-date-audit'

async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      map: { type: 'string', multiple: true },
      report: { type: 'string' },
      apply: { type: 'boolean', default: false },
      backup: { type: 'string' },
    },
  })
  const root = values.root ?? env.SCAN_DIR
  if (!root) throw new Error('Configure SCAN_DIR or pass --root')
  if (!values.report)
    throw new Error('Supply --report with a local audit JSON destination')
  if (
    values.apply &&
    (!values.backup ||
      !(await stat(values.backup)).isFile() ||
      (await stat(values.backup)).size === 0)
  )
    throw new Error(
      'Apply requires --backup pointing to a completed database backup',
    )
  const mappings = (values.map ?? []).map((mapping) => {
    const split = mapping.indexOf('=')
    if (split < 1 || split === mapping.length - 1)
      throw new Error('Mappings use --map /old/root=/current/root')
    return { from: mapping.slice(0, split), to: mapping.slice(split + 1) }
  })
  const audit = await auditNfoDates(resolve(root), mappings)
  await writeFile(resolve(values.report), JSON.stringify(audit, null, 2), {
    flag: 'wx',
    mode: 0o600,
  })
  process.stdout.write(
    JSON.stringify(
      { ...summarizeNfoAudit(audit), report: resolve(values.report) },
      null,
      2,
    ) + '\n',
  )
  if (values.apply)
    process.stdout.write(JSON.stringify(await applyNfoDateAudit(audit)) + '\n')
}

void main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => db.$client.end())
