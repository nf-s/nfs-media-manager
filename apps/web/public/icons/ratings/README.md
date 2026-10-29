# Rating Marks

The SVG brand paths are vendored from [Simple Icons](https://github.com/simple-icons/simple-icons), retrieved 2026-10-27. Simple Icons distributes its icons under [CC0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md); brand trademarks remain their owners'.

- `imdb.svg`: `icons/imdb.svg`, cropped to its wordmark without the surrounding square.
- `tmdb.svg`: `icons/themoviedatabase.svg`, solid teal fill.
- `rottentomatoes.svg`: `icons/rottentomatoes.svg`, solid red fill.
- `discogs.svg`: `icons/discogs.svg`, original black path.
- `trakt.svg`: `icons/trakt.svg`, red fill.
- `metacritic.svg`: `icons/metacritic.svg`, dark fill; used for missing critic scores and user scores.

`letterboxd.svg` is a local geometric rendering of the three-circle Letterboxd mark in its orange, green and blue colors. `popcorn.svg` is an original generic popcorn-bucket pictogram for Rotten Tomatoes audience ratings, not an official Rotten Tomatoes logo. Neither requires remote image requests.

`youtube.svg` is a local geometric rendering of YouTube's red play-button mark for stored trailer links. It requires no remote image request; the trademark remains its owner's.

Legacy public PNG marks are copied unchanged from this repository's existing assets:

- `sonemic.png`: `apps/web/public/img/sonemic.png`, 256 x 256 RGBA; the Sonemic mark used for RYM in `legacy/web-src/Models/Album.tsx`.
- `discogs.png`: `apps/web/public/img/discogs.png`, 128 x 128 RGBA; the original Discogs record mark used by the same legacy renderer. The SVG alternative is retained.

These PNGs are not Simple Icons assets. Their original download URLs and licenses are not recorded in the legacy source; trademarks remain their owners'. The legacy renderer displayed them at 16px wide (`legacy/web-src/Table/FieldRenderers.tsx`) with 3px horizontal link padding (`legacy/web-src/index.css`).

The restored Sonemic PNG is available to replace the RYM text label. Metascore uses its numeric square, not a logo. No icons are downloaded while browsing. Additional providers supply validated embedded raster icons through runtime field metadata and fall back to their supplied short label.
