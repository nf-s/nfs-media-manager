import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { auditSource } from './audit-tables.mjs'
import {
  checkClass,
  checkDeclaration,
  collectFindings,
  readTokens,
  scanComponent,
  scanStylesheet,
} from './check-styles.mjs'
import { compareWithBaseline } from './design-check-baseline.mjs'

const tokens = readTokens(`
  :root {
    --ds-ink: #14171c;
    --ds-text-sm: 12px;
    --ds-4: 8px;
    --ds-5: 12px;
    --ds-h-sm: 28px;
    --ds-gutter: 12px;
    --ds-r-md: 8px;
    --ds-leading: 1.4;
  }
`)

const rules = (property, value) =>
  checkDeclaration(property, value, tokens).map(({ rule }) => rule)

describe('checkDeclaration', () => {
  it('allows token references', () => {
    assert.deepEqual(rules('color', 'var(--ds-ink)'), [])
    assert.deepEqual(rules('padding', 'var(--ds-4) var(--ds-5)'), [])
    assert.deepEqual(rules('border-radius', 'var(--ds-r-md)'), [])
    assert.deepEqual(rules('box-shadow', 'var(--ds-shadow-pop)'), [])
    assert.deepEqual(rules('font-family', 'var(--ds-mono)'), [])
    assert.deepEqual(rules('border', '1px solid var(--ds-line)'), [])
    assert.deepEqual(rules('background', 'transparent'), [])
  })

  it('finds literal colours', () => {
    assert.deepEqual(rules('color', '#fff'), ['colour'])
    assert.deepEqual(rules('background', 'rgb(0 0 0 / 0.2)'), ['colour'])
    assert.deepEqual(rules('border-color', 'white'), ['colour'])
    assert.deepEqual(rules('color', 'var(--ds-ink, #000)'), ['colour'])
    assert.deepEqual(rules('animation', 'tan 1s linear'), [])
  })

  it('finds literal fonts, shadows and radii', () => {
    assert.deepEqual(rules('font-family', "'Inter', sans-serif"), ['font'])
    assert.deepEqual(rules('font', '600 var(--ds-text-sm) / 1 Inter'), ['font'])
    assert.deepEqual(rules('font-family', 'inherit'), [])
    assert.deepEqual(rules('box-shadow', '0 1px 2px var(--ds-line)'), [
      'shadow',
    ])
    assert.deepEqual(rules('box-shadow', 'none'), [])
    assert.deepEqual(rules('border-radius', '6px'), ['radius'])
    assert.deepEqual(rules('border-radius', '0'), [])
    assert.deepEqual(rules('border-radius', 'calc(var(--ds-r-md) - 1px)'), [])
  })

  it('finds literal sizes only where a token of the kind exists', () => {
    assert.deepEqual(checkDeclaration('gap', '8px', tokens), [
      { rule: 'size', detail: '--ds-4' },
    ])
    assert.deepEqual(checkDeclaration('font-size', '12px', tokens), [
      { rule: 'size', detail: '--ds-text-sm' },
    ])
    assert.deepEqual(checkDeclaration('height', '28px', tokens), [
      { rule: 'size', detail: '--ds-h-sm' },
    ])
    assert.deepEqual(checkDeclaration('line-height', '1.4', tokens), [
      { rule: 'size', detail: '--ds-leading' },
    ])
    assert.deepEqual(rules('gap', '10px'), [])
    assert.deepEqual(rules('width', '8px'), [])
    assert.deepEqual(rules('border-width', '1px'), [])
    assert.deepEqual(rules('margin', '-0.5rem'), ['size'])
  })
})

describe('scanStylesheet', () => {
  it('reads declarations and skips comments and at-rule preludes', () => {
    const css = `
/* color: #fff */
@media (max-width: 12px) {
  .row:hover { color: #000; padding: var(--ds-4); }
}
.icon { background: url("a.svg#fff"); }
`
    const findings = scanStylesheet('page.css', css, tokens)
    assert.deepEqual(
      findings.map(({ line, rule, excerpt }) => ({ line, rule, excerpt })),
      [{ line: 4, rule: 'colour', excerpt: 'color: #000' }],
    )
  })
})

describe('checkClass', () => {
  it('finds Tailwind classes that stand in for tokens', () => {
    assert.deepEqual(checkClass('gap-2', tokens), [
      { rule: 'size', detail: '--ds-4' },
    ])
    assert.deepEqual(
      checkClass('hover:bg-slate-100', tokens).map(({ rule }) => rule),
      ['colour'],
    )
    assert.deepEqual(
      checkClass('rounded-md', tokens).map(({ rule }) => rule),
      ['radius'],
    )
    assert.deepEqual(
      checkClass('text-[#ff0000]', tokens).map(({ rule }) => rule),
      ['colour'],
    )
    assert.deepEqual(checkClass('gap-[var(--ds-4)]', tokens), [])
    assert.deepEqual(checkClass('min-w-0', tokens), [])
    assert.deepEqual(checkClass('ds-table', tokens), [])
  })
})

describe('scanComponent', () => {
  it('checks inline styles, class names and colour strings', () => {
    const source = `
export function Row({ height }: { height: number }) {
  // color: '#fff'
  return (
    <div
      className="flex gap-2"
      style={{ height, padding: 8, color: 'red', width: 10, borderRadius: 6 }}
    >
      <svg fill="#000" />
      <span title="#hash">{'#e9ecf0'}</span>
    </div>
  )
}
`
    const findings = scanComponent('row.tsx', source, tokens).map(
      ({ rule, excerpt }) => `${rule} ${excerpt}`,
    )
    assert.deepEqual(findings.sort(), [
      'colour "#e9ecf0"',
      'colour fill="#000"',
      'colour style color: red',
      'radius style border-radius: 6px',
      'size class gap-2',
      'size style padding: 8px',
    ])
  })
})

describe('collectFindings', () => {
  it('flags style files outside the design system and layout folder', () => {
    const files = [
      'packages/ui/src/styles/page.css',
      'packages/ui/src/design-system/components.css',
      'apps/web/components/extra.module.css',
    ]
    const { strayStyleFiles } = collectFindings(files, () => '', tokens)
    assert.deepEqual(strayStyleFiles, ['apps/web/components/extra.module.css'])
  })
})

describe('auditSource', () => {
  const sharedImports = `import { Table, TableCell, TableHead } from '@repo/ui/components/ui/table'\n`

  it('accepts the shared Table and a ds-table with shared cells', () => {
    const source = `${sharedImports}
export const A = () => <Table aria-label="Jobs"><tbody><tr><TableCell /></tr></tbody></Table>
export const B = () => (
  <table className="ds-table ops-jobs-table" aria-label={\`\${noun} list\`}>
    <thead><tr><TableHead>Name</TableHead></tr></thead>
    <tbody><tr><td colSpan={2} style={{ height: 4 }} /></tr></tbody>
  </table>
)
`
    const { tables, findings } = auditSource('a.tsx', source)
    assert.deepEqual(
      tables.map(({ label, problem }) => ({ label, problem })),
      [
        { label: 'Jobs', problem: undefined },
        { label: '{`${noun} list`}', problem: undefined },
      ],
    )
    assert.deepEqual(findings, [])
  })

  it('flags plain tables, raw cells and table roles', () => {
    const source = `
export const C = () => (
  <table aria-label="Plain">
    <thead><tr><th>Name</th></tr></thead>
    <tbody><tr><td>Value</td></tr></tbody>
  </table>
)
export const D = () => <div role="grid" />
`
    const { findings } = auditSource('c.tsx', source)
    assert.deepEqual(
      findings.map(({ rule }) => rule),
      ['raw-table', 'raw-header', 'raw-cell', 'role-table'],
    )
  })
})

describe('compareWithBaseline', () => {
  const finding = {
    file: 'a.css',
    line: 1,
    rule: 'colour',
    excerpt: 'color: red',
  }

  it('allows baselined findings and reports new and fixed ones', () => {
    const baseline = {
      files: [],
      findings: { 'a.css': { 'colour: color: red': 1, 'radius: x': 1 } },
    }
    const once = compareWithBaseline([finding], baseline)
    assert.equal(once.fresh.length, 0)
    assert.deepEqual(
      once.stale.map(({ key }) => key),
      ['radius: x'],
    )
    const twice = compareWithBaseline(
      [finding, { ...finding, line: 9 }],
      baseline,
    )
    assert.equal(twice.fresh.length, 2)
  })
})
