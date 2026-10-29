import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PluginDiagnosticSchema,
  recordPluginDiagnostic,
} from '../dist/index.js'

describe('plugin diagnostic evidence', () => {
  it('is optional and cannot replace the original lookup outcome if the host callback fails', () => {
    const diagnostic = { stage: 'lookup', evidence: { reason: 'not-found' } }
    assert.doesNotThrow(() => recordPluginDiagnostic({}, diagnostic))
    assert.doesNotThrow(() =>
      recordPluginDiagnostic(
        {
          recordDiagnostic() {
            throw new Error('Host diagnostic failure')
          },
        },
        diagnostic,
      ),
    )
    const recorded = []
    recordPluginDiagnostic(
      {
        recordDiagnostic(value) {
          recorded.push(value)
        },
      },
      diagnostic,
    )
    assert.deepEqual(recorded, [diagnostic])
  })
  it('accepts a named stage with structured JSON evidence', () => {
    const diagnostic = {
      stage: 'search.candidates',
      evidence: {
        reason: 'year-mismatch',
        candidates: [{ year: 2022, accepted: false }],
      },
    }
    assert.deepEqual(PluginDiagnosticSchema.parse(diagnostic), diagnostic)
  })

  it('rejects unnamed stages and non-JSON evidence', () => {
    for (const value of [
      {},
      { stage: '', evidence: {} },
      { stage: 'x'.repeat(81), evidence: null },
      { stage: 'lookup', evidence: undefined },
      { stage: 'lookup', evidence: { callback() {} } },
    ])
      assert.equal(PluginDiagnosticSchema.safeParse(value).success, false)
  })
})
