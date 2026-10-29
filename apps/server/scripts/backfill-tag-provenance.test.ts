import { describe, expect, it } from 'vitest'
import { parseTagBackfillArguments } from './backfill-tag-provenance'

describe('tag backfill safety arguments', () => {
  it('requires an explicit media scope and defaults to dry run', () => {
    expect(
      parseTagBackfillArguments(['--media-type=album', '--name=Arena Rock']),
    ).toMatchObject({
      apply: false,
      scope: { mediaType: 'album', name: 'Arena Rock' },
    })
    expect(() => parseTagBackfillArguments([])).toThrow()
    expect(() => parseTagBackfillArguments(['--media-type=all'])).toThrow()
  })
  it('requires reviewed evidence and backup for apply and rejects typos/repeated flags', () => {
    for (const args of [
      ['--apply'],
      ['--apply', '--backup=file'],
      ['--apply', '--review=wrong', '--backup=file'],
      ['--aply'],
      ['--media-type=film'],
      ['--name='],
      ['--name=  '],
      ['--backup=file'],
    ])
      expect(() =>
        parseTagBackfillArguments(['--media-type=album', ...args]),
      ).toThrow()
    expect(
      parseTagBackfillArguments([
        '--media-type=film',
        '--apply',
        '--backup=backup.dump',
        `--review=${'a'.repeat(64)}`,
      ]).apply,
    ).toBe(true)
  })
})
