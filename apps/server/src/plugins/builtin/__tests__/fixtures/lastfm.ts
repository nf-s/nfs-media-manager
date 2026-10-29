// Sanitized stored Last.fm album: identity replaced, unrelated fields omitted.
// Failed jobs retained Zod issues, not response bodies; this has the same shapes.
export const lastFmSparseAlbumFixture = {
  album: {
    name: 'Example Album',
    artist: 'Example Artist',
    url: 'https://www.last.fm/music/Example+Artist/Example+Album',
    tags: '',
    tracks: {
      track: [
        { name: 'Track 1', duration: null },
        { name: 'Track 2', duration: null },
      ],
    },
  },
}
