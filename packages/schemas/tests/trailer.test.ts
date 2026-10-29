import { describe, expect, it } from 'vitest'
import { youtubeTrailerUrl } from '../src/trailer'

describe('stored YouTube trailer URLs', () => {
  it('canonicalizes recognized URLs and drops tracking or redirect parameters', () => {
    for (const value of [
      'https://www.youtube.com/watch?v=Abc_123-xyz&feature=share',
      'http://youtube.com/watch?v=Abc_123-xyz',
      'https://youtu.be/Abc_123-xyz?t=15',
      'https://m.youtube.com/shorts/Abc_123-xyz',
      'https://www.youtube-nocookie.com/embed/Abc_123-xyz?autoplay=1',
      'plugin://plugin.video.youtube/?action=play_video&videoid=Abc_123-xyz&hd=1',
    ])
      expect(youtubeTrailerUrl(value)).toBe(
        'https://www.youtube.com/watch?v=Abc_123-xyz',
      )
  })
  it('rejects absent, nonvideo, malformed, deceptive and executable destinations', () => {
    for (const value of [
      undefined,
      null,
      1,
      {},
      [],
      '',
      'Abc_123-xyz',
      'https://youtube.com',
      'https://youtube.com/watch?v=short',
      'https://youtube.com/playlist?list=Abc_123-xyz',
      'https://youtube.com.example.com/watch?v=Abc_123-xyz',
      'https://user:pass@youtube.com/watch?v=Abc_123-xyz',
      'https://youtube.com:8080/watch?v=Abc_123-xyz',
      'javascript:alert(1)',
      'data:text/html,test',
      '//youtu.be/Abc_123-xyz',
      'plugin://other/?action=play_video&videoid=Abc_123-xyz',
      'plugin://plugin.video.youtube/?action=execute&videoid=Abc_123-xyz',
      'https://youtube.com/redirect?q=https://example.com',
    ])
      expect(youtubeTrailerUrl(value)).toBeUndefined()
  })
})
