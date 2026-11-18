import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  lastfmAuthorizationUrl,
  lastfmErrorNumber,
  lastfmFailure,
  lastfmSignature,
  parseLastfmSession,
  parseScrobbleAnswer,
  scrobbleParams,
  signedLastfmForm,
  type LastfmScrobble,
} from './lastfm-scrobble-api'

const md5 = (text: string) =>
  createHash('md5').update(Buffer.from(text, 'utf8')).digest('hex')

function play(index: number): LastfmScrobble {
  return {
    artist: `Fixture Artist ${index}`,
    track: `Fixture Track ${index}`,
    album: index % 2 ? '' : `Fixture Album ${index}`,
    durationMs: index % 3 ? 181400 : null,
    startedAt: new Date(Date.UTC(2026, 10, 1, 12, index, 0, 750)),
  }
}

describe('Last.fm call signatures', () => {
  it('signs auth.getSession without format or callback', () => {
    const params = {
      method: 'auth.getSession',
      api_key: 'fixture-key',
      token: 'fixturetoken0123456789abcdef01',
    }
    // Reference value computed outside this code from the same string.
    expect(lastfmSignature(params, 'fixture-secret')).toBe(
      'eaf91b022fc64160d46c155aa08f9ac9',
    )
    expect(
      lastfmSignature(
        { ...params, format: 'json', callback: 'ignored' },
        'fixture-secret',
      ),
    ).toBe('eaf91b022fc64160d46c155aa08f9ac9')
  })

  it('hashes non-ASCII names as UTF-8', () => {
    const params = scrobbleParams('fixture-key', 'fixture-session', [
      {
        artist: 'Sigur Rós',
        track: 'Hoppípolla 日本',
        album: '',
        durationMs: null,
        startedAt: new Date(1700000000000),
      },
    ])
    expect(lastfmSignature(params, 'fixture-secret')).toBe(
      'ff05b4265268a0dee8da39b126075c7b',
    )
  })

  it('orders indexed names as plain strings, so [10] comes before [1]', () => {
    expect(
      lastfmSignature(
        { 'artist[1]': 'b', 'artist[10]': 'c', 'artist[0]': 'a', method: 'm' },
        's',
      ),
    ).toBe(md5('artist[0]aartist[10]cartist[1]bmethodms'))

    const plays = Array.from({ length: 11 }, (_, index) => play(index))
    const params = scrobbleParams('fixture-key', 'fixture-session', plays)
    const indexes = [0, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const indexed = (name: string) =>
      indexes
        .flatMap((index) => {
          const key = `${name}[${index}]`
          const value = params[key]
          return value === undefined ? [] : [`${key}${value}`]
        })
        .join('')
    const expected =
      indexed('album') +
      'api_keyfixture-key' +
      indexed('artist') +
      indexed('duration') +
      'methodtrack.scrobble' +
      'skfixture-session' +
      indexed('timestamp') +
      indexed('track')
    expect(lastfmSignature(params, 'fixture-secret')).toBe(
      md5(`${expected}fixture-secret`),
    )
  })

  it('adds the signature and JSON format to the form body', () => {
    const form = signedLastfmForm(
      { method: 'auth.getSession', api_key: 'k', token: 't' },
      's',
    )
    expect(form.get('format')).toBe('json')
    expect(form.get('api_sig')).toBe(
      md5('api_keykmethodauth.getSessiontokents'),
    )
  })
})

describe('track.scrobble parameters', () => {
  it('sends start times in UTC seconds and omits an empty album or unknown duration', () => {
    const params = scrobbleParams('fixture-key', 'fixture-session', [
      play(0),
      play(1),
      play(3),
    ])
    expect(params).toEqual({
      method: 'track.scrobble',
      api_key: 'fixture-key',
      sk: 'fixture-session',
      'artist[0]': 'Fixture Artist 0',
      'track[0]': 'Fixture Track 0',
      'timestamp[0]': String(Date.UTC(2026, 10, 1, 12, 0) / 1000),
      'album[0]': 'Fixture Album 0',
      'artist[1]': 'Fixture Artist 1',
      'track[1]': 'Fixture Track 1',
      'timestamp[1]': String(Date.UTC(2026, 10, 1, 12, 1) / 1000),
      'duration[1]': '181',
      'artist[2]': 'Fixture Artist 3',
      'track[2]': 'Fixture Track 3',
      'timestamp[2]': String(Date.UTC(2026, 10, 1, 12, 3) / 1000),
    })
  })

  it('builds the sign-in URL with the callback', () => {
    const url = new URL(
      lastfmAuthorizationUrl(
        'fixture-key',
        'https://api.example.test/api/v1/lastfm/scrobbling/callback/abc',
      ),
    )
    expect(url.origin + url.pathname).toBe('https://www.last.fm/api/auth/')
    expect(url.searchParams.get('api_key')).toBe('fixture-key')
    expect(url.searchParams.get('cb')).toBe(
      'https://api.example.test/api/v1/lastfm/scrobbling/callback/abc',
    )
  })
})

describe('Last.fm answers', () => {
  const entry = (code: string) => ({
    artist: { corrected: '0', '#text': 'Fixture Artist' },
    track: { corrected: '0', '#text': 'Fixture Track' },
    album: { corrected: '0', '#text': '' },
    albumArtist: { corrected: '0', '#text': '' },
    timestamp: '1762000000',
    ignoredMessage: { code, '#text': code === '0' ? '' : 'Ignored' },
  })

  it('reads one scrobble answered as an object', () => {
    expect(
      parseScrobbleAnswer(
        {
          scrobbles: {
            scrobble: entry('0'),
            '@attr': { ignored: 0, accepted: 1 },
          },
        },
        1,
      ),
    ).toEqual([0])
  })

  it('reads each scrobble of an array in order', () => {
    expect(
      parseScrobbleAnswer(
        {
          scrobbles: {
            scrobble: [entry('0'), entry('3'), entry('0')],
            '@attr': { ignored: '1', accepted: '2' },
          },
        },
        3,
      ),
    ).toEqual([0, 3, 0])
  })

  it('counts every play as taken when the entries do not line up', () => {
    expect(
      parseScrobbleAnswer(
        {
          scrobbles: {
            scrobble: entry('0'),
            '@attr': { ignored: 0, accepted: 2 },
          },
        },
        2,
      ),
    ).toEqual([0, 0])
  })

  it('rejects anything else', () => {
    expect(parseScrobbleAnswer({ error: 9, message: 'x' }, 1)).toBeNull()
    expect(parseScrobbleAnswer(null, 1)).toBeNull()
    expect(parseScrobbleAnswer({ scrobbles: {} }, 1)).toBeNull()
  })

  it('reads the session name and key', () => {
    expect(
      parseLastfmSession({
        session: { name: 'fixture-listener', key: 'fixture-sk', subscriber: 0 },
      }),
    ).toEqual({ name: 'fixture-listener', sessionKey: 'fixture-sk' })
    expect(parseLastfmSession({ session: { name: '' } })).toBeNull()
  })

  it('classifies Last.fm errors', () => {
    expect(
      lastfmErrorNumber({ error: 9, message: 'Invalid session key' }),
    ).toBe(9)
    expect(lastfmErrorNumber({ scrobbles: {} })).toBeNull()
    expect([4, 9, 14, 15].map(lastfmFailure)).toEqual(Array(4).fill('session'))
    expect(lastfmFailure(29)).toBe('rate-limit')
    expect([8, 11, 16].map(lastfmFailure)).toEqual(Array(3).fill('temporary'))
    expect([10, 26].map(lastfmFailure)).toEqual(['denied', 'denied'])
    expect([6, 13].map(lastfmFailure)).toEqual(['failed', 'failed'])
  })
})
