import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  formatWorkers,
  jobTypeLabel,
  providerLabel,
  statusStatements,
} from './production-status-report'

const publicProviders = new Set(['spotify'])

describe('production status report', () => {
  it('uses only single SELECT statements', () => {
    for (const statement of Object.values(statusStatements)) {
      expect(statement.trimStart()).toMatch(/^SELECT\b/)
      expect(statement).not.toContain(';')
      expect(statement).not.toMatch(
        /\b(insert|update|delete|truncate|alter|drop|create|grant|call|copy|lock)\b/i,
      )
    }
  })

  it('names built-in providers and hashes private providers and their tasks', () => {
    expect(jobTypeLabel('spotify', null, publicProviders)).toBe(
      'spotify / items',
    )
    expect(jobTypeLabel('spotify', 'artist-enrichment', publicProviders)).toBe(
      'spotify / artist-enrichment',
    )
    const hidden = jobTypeLabel(
      'fixture-private',
      'fixture-task',
      publicProviders,
    )
    expect(hidden).toMatch(/^private-[0-9a-f]{6} \/ task-[0-9a-f]{6}$/)
    expect(hidden).not.toContain('fixture')
    expect(providerLabel('fixture-private', publicProviders)).toBe(
      hidden.split(' ')[0],
    )
  })

  it('formats ages', () => {
    expect(formatDuration(null)).toBe('-')
    expect(formatDuration(42)).toBe('42s')
    expect(formatDuration(600)).toBe('10m')
    expect(formatDuration(3 * 3600 + 120)).toBe('3h 2m')
    expect(formatDuration(5 * 86400 + 7200)).toBe('5d 2h')
  })

  it('relates served commits to the compared ref', () => {
    const commit = 'a'.repeat(40)
    const lines = formatWorkers(
      [
        {
          label: 'API',
          deployedOn: '2000-01-01T00:00:00.000Z',
          versions: [
            {
              versionId: 'version',
              percentage: 100,
              commit,
              createdOn: null,
              context: { subject: 'Fixture change', behind: 2, matches: false },
            },
          ],
        },
        {
          label: 'web',
          deployedOn: null,
          versions: [
            {
              versionId: 'version',
              percentage: 100,
              commit: null,
              createdOn: null,
              context: null,
            },
          ],
        },
      ],
      'main',
      new Date('2000-01-01T01:00:00.000Z'),
    )
    expect(lines).toEqual([
      'Workers',
      '  API: deployed 2000-01-01 00:00 UTC, 1h 0m ago',
      `    100%  ${commit}  2 commits behind main  Fixture change`,
      '  web: deployed unknown time',
      '    100%  untagged version  commit not in this checkout',
    ])
  })
})
