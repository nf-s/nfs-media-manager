import { describe, expect, it } from 'vitest'
import { storedTrailerUrl } from './stored-trailers'

describe('stored trailer projection', () => {
  it('reads NFO arrays and MDBList URL strings without requesting anything', () => {
    for (const trailer of [
      ['plugin://plugin.video.youtube/?action=play_video&videoid=Abc_123-xyz'],
      'https://youtu.be/Abc_123-xyz',
      ['https://example.com/no-trailer', 'https://youtu.be/Abc_123-xyz'],
    ])
      expect(storedTrailerUrl({ trailer })).toBe(
        'https://www.youtube.com/watch?v=Abc_123-xyz',
      )
  })
  it('only uses stored YouTube trailers, preferring official videos', () => {
    const videos = {
      results: [
        { site: 'YouTube', type: 'Teaser', key: 'Wrong123456' },
        { site: 'YouTube', type: 'Trailer', key: 'Unofficial1' },
        {
          site: 'YouTube',
          type: 'Trailer',
          key: 'Abc_123-xyz',
          official: true,
        },
        { site: 'Vimeo', type: 'Trailer', key: 'Abc_123-xyz' },
      ],
    }
    expect(storedTrailerUrl({ videos })).toBe(
      'https://www.youtube.com/watch?v=Abc_123-xyz',
    )
  })
  it('does not infer trailers from flags, arbitrary nested fields or invalid data', () => {
    for (const payload of [
      null,
      [],
      {},
      { trailer: true },
      { trailer: {} },
      {
        videos: {
          results: [null, { site: 'YouTube', type: 'Trailer', key: 'bad' }],
        },
      },
      { keywords: ['has-trailer'] },
      { other: { trailer: 'https://youtu.be/Abc_123-xyz' } },
    ])
      expect(storedTrailerUrl(payload)).toBeUndefined()
  })
})
