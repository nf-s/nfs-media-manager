import { dirname, relative, resolve, sep } from 'node:path'

export interface NfoIdentity {
  referenceType: string
  externalId: string
}
export interface NfoAuditFile {
  path: string
  createdAt: string | null
  references: NfoIdentity[]
}
export interface NfoRootMapping {
  from: string
  to: string
}

export function remapNfoPath(path: string, mappings: NfoRootMapping[]) {
  const normalized = path.replaceAll('\\', '/').normalize('NFC')
  for (const mapping of mappings) {
    const from = mapping.from
      .replaceAll('\\', '/')
      .replace(/\/$/, '')
      .normalize('NFC')
    if (normalized.startsWith(`${from}/`)) {
      const mapped = resolve(mapping.to, normalized.slice(from.length + 1))
      const suffix = relative(resolve(mapping.to), mapped)
      return suffix === '..' || suffix.startsWith(`..${sep}`)
        ? null
        : mapped.normalize('NFC')
    }
  }
  return resolve(normalized).normalize('NFC')
}

export function matchNfoFile(
  paths: string[],
  references: NfoIdentity[],
  files: NfoAuditFile[],
  mappings: NfoRootMapping[],
): { file?: NfoAuditFile; reason: string } {
  const mapped = paths.flatMap((path) => {
    const result = remapNfoPath(path, mappings)
    return result ? [result] : []
  })
  const compatible = (file: NfoAuditFile) =>
    references.every((ref) => {
      const sameType = file.references.filter(
        (other) => other.referenceType === ref.referenceType,
      )
      return (
        !sameType.length ||
        sameType.some((other) => other.externalId === ref.externalId)
      )
    })
  const exact = files.filter((file) =>
    mapped.includes(file.path.normalize('NFC')),
  )
  if (exact.length)
    return exact.length === 1 && exact[0] && compatible(exact[0])
      ? { file: exact[0], reason: 'Exact mapped path' }
      : { reason: 'Ambiguous or conflicting exact path' }
  const identified = files.filter(
    (file) =>
      compatible(file) &&
      references.some((ref) =>
        file.references.some(
          (other) =>
            other.referenceType === ref.referenceType &&
            other.externalId === ref.externalId,
        ),
      ),
  )
  if (identified.length)
    return identified.length === 1
      ? { file: identified[0], reason: 'Unique film identifier' }
      : { reason: 'Multiple files share film identifiers' }
  const directories = new Set(mapped.map(dirname))
  const sameDirectory = files.filter((file) =>
    directories.has(dirname(file.path.normalize('NFC'))),
  )
  if (
    sameDirectory.length === 1 &&
    sameDirectory[0] &&
    compatible(sameDirectory[0])
  )
    return { file: sameDirectory[0], reason: 'Only NFO in mapped directory' }
  return {
    reason: sameDirectory.length
      ? 'Ambiguous or conflicting mapped directory'
      : 'No matching file',
  }
}
