import { describe, it, expect } from 'vitest'
import { parseReplayArguments, replayTarget } from './replay-rym-tags'
import { applicableRymSource } from '../src/services/rym-tag-replay'

describe('offline RYM replay boundaries', () => {
  it('requires a new report, defaults to preview and requires its hash for apply', () => {
    const report = '--report=preview.json'
    expect(parseReplayArguments([report, '--media-id=album'])).toMatchObject({
      apply: false,
      mediaId: 'album',
    })
    for (const flags of [
      [],
      [report, report],
      [report, '--apply'],
      [report, '--review=foo'],
      [report, '--apply', '--review=foo'],
      [report, '--appl'],
    ])
      expect(() => parseReplayArguments(flags)).toThrow()
    expect(
      parseReplayArguments([report, '--apply', `--review=${'a'.repeat(64)}`])
        .apply,
    ).toBe(true)
  })
  it('labels local defaults and explicit targets without credentials and never falls back on a bad override', () => {
    const config = {
      DATABASE_HOST: 'localhost',
      DATABASE_PORT: 5433,
      DATABASE_NAME: 'fixture',
      DATABASE_USER: 'user',
      DATABASE_PASSWORD: 'secret',
      NODE_ENV: 'test',
      DATABASE_URL: undefined,
      DATABASE_SCHEMA: undefined,
      DATABASE_SSL: undefined,
    } satisfies Parameters<typeof replayTarget>[1]
    expect(replayTarget(undefined, config).label).toBe(
      'localhost:5433/fixture#public',
    )
    const url =
      'postgresql://username:secret@ep-test.example.net/production?sslmode=require'
    expect(replayTarget(url, config).label).toBe(
      'ep-test.example.net:5432/production#public',
    )
    expect(() =>
      replayTarget(undefined, { ...config, DATABASE_URL: url }),
    ).toThrow('Remote targets require')
    expect(() =>
      replayTarget(undefined, { ...config, DATABASE_HOST: 'example.net' }),
    ).toThrow('Remote targets require')
    expect(() => replayTarget('', config)).toThrow()
    expect(() =>
      replayTarget('postgresql://ep-x-pooler.example.net/prod', config),
    ).toThrow()
  })
  it('requires exact active and saved issues; old successful normalized shapes can omit matchStatus/releaseUrl', () => {
    const url = 'https://rateyourmusic.com/release/album/artist/record.p/'
    const normalized = {
      references: [{ referenceType: 'rym-url', externalId: url }],
      mediaPatch: {
        metadata: {
          'plugin.serply.provenance': {
            source: 'rym',
            retrievalProvider: 'serply',
            sourceUrl: url + 'reviews/2/',
          },
        },
      },
    }
    expect(applicableRymSource(normalized, [url], url)).toBe(url + 'reviews/2/')
    for (const invalid of [
      url.replace('.p', ''),
      url.replace('.p', '-2'),
      url.replace('rateyourmusic.com', 'example.com'),
    ]) {
      expect(applicableRymSource(normalized, [invalid])).toBeNull()
      expect(applicableRymSource(normalized, [url], invalid)).toBeNull()
    }
    expect(applicableRymSource(normalized, [])).toBeNull()
    expect(applicableRymSource({}, [url])).toBeNull()
  })
})
