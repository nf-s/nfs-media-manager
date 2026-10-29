# Rating Marks

The SVG brand paths are vendored from [Simple Icons](https://github.com/simple-icons/simple-icons), retrieved 2026-10-27. Simple Icons distributes its icons under [CC0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md); brand trademarks remain their owners'.

- `imdb.svg`: `icons/imdb.svg`, cropped to its wordmark without the surrounding square.
- `tmdb.svg`: `icons/themoviedatabase.svg`, solid teal fill.
- `rottentomatoes.svg`: `icons/rottentomatoes.svg`, solid red fill.
- `trakt.svg`: `icons/trakt.svg`, red fill.
- `metacritic.svg`: `icons/metacritic.svg`, dark fill; used for missing critic scores and user scores.

`letterboxd.svg` is a local geometric rendering of the three-circle Letterboxd mark in its orange, green and blue colors. `popcorn.svg` is an original generic popcorn-bucket pictogram for Rotten Tomatoes audience ratings, not an official Rotten Tomatoes logo. Neither requires remote image requests.

`youtube.svg` is a local geometric rendering of YouTube's red play-button mark for stored trailer links. It requires no remote image request; the trademark remains its owner's.

The retained PNG marks were carried over unchanged from the earlier media-library UI:

- `sonemic.png`: 256 x 256 RGBA; the Sonemic mark used for RYM.
- `discogs.png`: 128 x 128 RGBA; the Discogs record mark.

These PNGs are not Simple Icons assets. Their original download URLs and licenses were not recorded with the imported assets; trademarks remain their owners'.

RYM uses the Sonemic PNG and Discogs uses the record PNG. Metascore uses its numeric square, not a logo. No icons are downloaded while browsing. Additional providers supply validated embedded raster icons through runtime field metadata and fall back to their supplied short label.
