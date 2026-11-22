/*
 * Shared plumbing for the design-system checks: the file list, line numbers
 * and the committed baseline of findings that existed before a check began.
 *
 * A finding is keyed by file and by a short excerpt of the offending code, not
 * by line, so moving code does not disturb the baseline. A check fails when a
 * file has more findings with a key than the baseline allows.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
)

/** Tracked and untracked, not ignored, files under the repository root. */
export function listFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return [...new Set(output.split('\0'))]
    .filter((path) => path && existsSync(join(repoRoot, path)))
    .sort()
}

export function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8')
}

/** The 1-based line of `index` in `text`. */
export function lineAt(text, index) {
  let line = 1
  for (let at = 0; at < index; at += 1) {
    if (text.charCodeAt(at) === 10) line += 1
  }
  return line
}

export function compactExcerpt(text, limit = 120) {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}

export function findingKey(finding) {
  return `${finding.rule}: ${finding.excerpt}`
}

export function loadBaseline(path) {
  if (!existsSync(path)) return { files: [], findings: {} }
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const files = Array.isArray(parsed.files) ? parsed.files : []
  const findings =
    parsed.findings && typeof parsed.findings === 'object'
      ? parsed.findings
      : {}
  return { files, findings }
}

/** Counts of each key per file, as the baseline stores them. */
export function countFindings(findings) {
  const counts = {}
  for (const finding of findings) {
    const keys = (counts[finding.file] ??= {})
    const key = findingKey(finding)
    keys[key] = (keys[key] ?? 0) + 1
  }
  return counts
}

export function writeBaseline(path, { description, files, findings }) {
  const counts = countFindings(findings)
  const sorted = {}
  for (const file of Object.keys(counts).sort()) {
    sorted[file] = {}
    for (const key of Object.keys(counts[file]).sort()) {
      sorted[file][key] = counts[file][key]
    }
  }
  const body = {
    description,
    files: [...files].sort(),
    findings: sorted,
  }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`)
}

/**
 * Findings beyond the baseline, and baseline entries no longer found. When a
 * key has more findings than allowed, every finding with that key is reported,
 * since a key does not say which one is new.
 */
export function compareWithBaseline(findings, baseline) {
  const counts = countFindings(findings)
  const fresh = []
  for (const finding of findings) {
    const allowed = baseline.findings[finding.file]?.[findingKey(finding)] ?? 0
    if (counts[finding.file][findingKey(finding)] > allowed) fresh.push(finding)
  }
  const stale = []
  for (const [file, keys] of Object.entries(baseline.findings)) {
    for (const [key, allowed] of Object.entries(keys)) {
      const found = counts[file]?.[key] ?? 0
      if (found < allowed) stale.push({ file, key, allowed, found })
    }
  }
  return { fresh, stale }
}

export function totalsByFile(findings) {
  const totals = new Map()
  for (const finding of findings) {
    totals.set(finding.file, (totals.get(finding.file) ?? 0) + 1)
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export function printTotals(findings, label) {
  const totals = totalsByFile(findings)
  console.log(`${label}: ${findings.length} in ${totals.length} files`)
  for (const [file, count] of totals) {
    console.log(`  ${String(count).padStart(4)}  ${file}`)
  }
}

export function printStale(stale, updateCommand) {
  if (!stale.length) return
  console.log(
    `\n${stale.length} baseline entries are no longer found. Run \`${updateCommand}\` to shrink the baseline.`,
  )
  for (const entry of stale.slice(0, 20)) {
    console.log(
      `  ${entry.file}: ${entry.key} (baseline ${entry.allowed}, found ${entry.found})`,
    )
  }
  if (stale.length > 20) console.log(`  … and ${stale.length - 20} more`)
}
