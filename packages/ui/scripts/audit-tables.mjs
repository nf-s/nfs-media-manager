/*
 * Table audit: lists every table the app renders and flags any that does not
 * use the shared table in `packages/ui/src/components/ui/table.tsx`.
 *
 * A table uses the shared component when it is `<Table>` from that file, or a
 * `<table className="ds-table">` in a file that takes its header and body
 * cells from that file, as the Jobs table does. It reports:
 *   raw-table    a `<table>` without `ds-table` or without the shared cells
 *   raw-header   a `<th>` instead of `TableHead`
 *   raw-cell     a `<td>` with content instead of `TableCell` (an empty
 *                spacer cell for a virtual list is allowed)
 *   role-table   an element given `role="table"`, `"grid"` or `"treegrid"`
 *
 * Findings that existed when the audit began are listed in
 * `table-baseline.json` and allowed; the audit fails on any others.
 *
 *   node packages/ui/scripts/audit-tables.mjs           list tables and check
 *   node packages/ui/scripts/audit-tables.mjs --update  rewrite the baseline
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  compactExcerpt,
  compareWithBaseline,
  lineAt,
  listFiles,
  loadBaseline,
  printStale,
  printTotals,
  readRepoFile,
  repoRoot,
  writeBaseline,
} from './design-check-baseline.mjs'
import { maskSource } from './check-styles.mjs'

const baselinePath = join(repoRoot, 'packages/ui/scripts/table-baseline.json')
const sharedTable = 'packages/ui/src/components/ui/table.tsx'
const sharedImport = /from\s*['"]@repo\/ui\/components\/ui\/table['"]/
const updateCommand = 'pnpm --filter @repo/ui audit:tables --update'

function isComponentSource(path) {
  if (!/\.(tsx|jsx)$/.test(path)) return false
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return false
  if (path === sharedTable) return false
  return path.startsWith('apps/web/') || path.startsWith('packages/ui/src/')
}

/** The end of a JSX opening tag that starts at `start`, skipping `{…}`. */
function tagEnd(masked, start) {
  let depth = 0
  for (let at = start; at < masked.length; at += 1) {
    const char = masked[at]
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === '>' && depth === 0) return at
  }
  return masked.length
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|\\{)`).exec(tag)
  if (!match) return undefined
  if (match[1] !== undefined || match[2] !== undefined) {
    return match[1] ?? match[2]
  }
  const open = match.index + match[0].length - 1
  const { masked } = maskSource(tag)
  let depth = 0
  for (let at = open; at < masked.length; at += 1) {
    if (masked[at] === '{') depth += 1
    else if (masked[at] === '}' && --depth === 0) {
      return compactExcerpt(tag.slice(open, at + 1), 60)
    }
  }
  return compactExcerpt(tag.slice(open), 60)
}

function importsSharedTable(source) {
  return [
    ...source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*['"]@repo\/ui\/components\/ui\/table['"]/g,
    ),
  ].some(([, names]) => /\bTable\b/.test(names))
}

/** Every table in one component source, and its findings. */
export function auditSource(file, source) {
  const { masked } = maskSource(source)
  const tables = []
  const findings = []
  const usesSharedCells =
    sharedImport.test(source) && /<Table(Head|Cell)\b/.test(source)

  for (const match of masked.matchAll(/<(table|Table)(?=[\s>/])/g)) {
    const end = tagEnd(masked, match.index)
    const tag = source.slice(match.index, end + 1)
    const line = lineAt(source, match.index)
    const label = attribute(tag, 'aria-label') ?? '(no label)'
    const className = attribute(tag, 'className') ?? ''
    let problem
    if (match[1] === 'Table') {
      if (!importsSharedTable(source)) problem = 'Table is not the shared Table'
    } else if (!/\bds-table\b/.test(className)) {
      problem = 'no ds-table class'
    } else if (!usesSharedCells) {
      problem = 'cells are not TableHead and TableCell'
    }
    const kind = match[1] === 'Table' ? '<Table>' : '<table class="ds-table">'
    tables.push({ file, line, label, kind, problem })
    if (problem) {
      findings.push({
        file,
        line,
        rule: 'raw-table',
        detail: problem,
        excerpt: compactExcerpt(`<${match[1]} aria-label=${label}>`),
      })
    }
  }

  for (const match of masked.matchAll(/<(th|td)(?=[\s>/])/g)) {
    const end = tagEnd(masked, match.index)
    const selfClosing = masked[end - 1] === '/'
    if (match[1] === 'td' && selfClosing) continue
    const following =
      source
        .slice(end + 1, end + 80)
        .split('\n')
        .find((text) => text.trim()) ?? ''
    findings.push({
      file,
      line: lineAt(source, match.index),
      rule: match[1] === 'th' ? 'raw-header' : 'raw-cell',
      excerpt: compactExcerpt(`<${match[1]}> ${following}`, 80),
    })
  }

  for (const match of source.matchAll(
    /\brole=(["'])(table|grid|treegrid)\1/g,
  )) {
    if (!masked.startsWith('role=', match.index)) continue
    findings.push({
      file,
      line: lineAt(source, match.index),
      rule: 'role-table',
      excerpt: `role="${match[2]}"`,
    })
  }
  return { tables, findings }
}

export function collectTables(files, read) {
  const tables = []
  const findings = []
  for (const file of files.filter(isComponentSource)) {
    const result = auditSource(file, read(file))
    tables.push(...result.tables)
    findings.push(...result.findings)
  }
  return { tables, findings }
}

function main(argv) {
  const { tables, findings } = collectTables(listFiles(), readRepoFile)

  if (argv.includes('--update')) {
    writeBaseline(baselinePath, {
      description:
        'Table findings that existed before the table audit. Allowed, not endorsed: remove entries as the tables move to the shared component. Rewrite with `pnpm --filter @repo/ui audit:tables --update`.',
      files: [],
      findings,
    })
    printTotals(findings, 'Baselined table findings')
    return 0
  }

  const shared = tables.filter((table) => !table.problem).length
  console.log(
    `Tables: ${tables.length} (${shared} shared, ${tables.length - shared} not)`,
  )
  for (const table of tables) {
    const status = table.problem ? `NOT SHARED: ${table.problem}` : 'shared'
    console.log(
      `  ${table.file}:${table.line}  ${table.label}  ${table.kind}  ${status}`,
    )
  }

  const { fresh, stale } = compareWithBaseline(
    findings,
    loadBaseline(baselinePath),
  )
  if (fresh.length) {
    console.error(
      '\nTable audit failed. Every table uses the shared table in packages/ui/src/components/ui/table.tsx; the Jobs table is the reference.\n',
    )
    for (const finding of fresh) {
      const detail = finding.detail ? ` (${finding.detail})` : ''
      console.error(
        `${finding.file}:${finding.line}  ${finding.rule}${detail}  ${finding.excerpt}`,
      )
    }
    console.error(
      `\n${fresh.length} findings not in packages/ui/scripts/table-baseline.json.`,
    )
    return 1
  }
  console.log(
    `\nTable audit passed: ${findings.length} baselined findings, none new.`,
  )
  printStale(stale, updateCommand)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
