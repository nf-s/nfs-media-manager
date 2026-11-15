# Artists, people and channels

Artists are shared by Albums and Tracks. People lists film directors and actors. Both use the existing creator identity and credit roles: a band is an artist without being treated as a person, and one film person can hold several roles. Channels retain the subscription source identity for YouTube channels and Spotify shows.

Creator and channel names open details by default. Related albums, tracks, playlists, films and subscription items open in the same detail inspector, with Back preserving the previous entry and its tab. Open page provides a standalone URL. Each creator or channel detail has explicit actions to filter the relevant library.

Music details put playlist memberships in a Playlists tab. Artist details show the albums, tracks and playlists already in the library; these are library memberships, not a provider's complete discography. Film people initially expose director and actor credits.

Related media tables offer Grid, Details and Table. Album and track artwork stays square, film posters stay portrait, and channel thumbnails use 16:9. Each nested list type remembers its view separately. Search, sorting, role filters and playback actions remain available in every mode. Keep each nested viewport bounded to the panel; the full result height belongs inside that scroller, not in the surrounding document. Only the visible pages and overscan load, including after changing view or resizing the panel.

## Artist enrichment

Artist enrichment is an explicit job for one artist and one provider: Spotify, Last.fm, Discogs or MusicBrainz. It uses the existing provider dispatcher, request gate, budgets and cooldowns. Viewing details does not start a job. Provider identifiers are independent of the internal artist ID. An ambiguous name search needs an explicit provider artist identifier instead of silently selecting a namesake.

Successful jobs retain immutable artist provider snapshots and advance that provider's current snapshot pointer. Profiles can contain a biography, image, country, artist type, provider identifier, source link and tags when supplied by the provider. Missing fields remain absent; they are not inferred from releases. Provider availability and returned fields can vary.

Open **Sources** to see the current identifiers and refresh selected or all eligible providers. Use a provider's ID editor and **Refresh with ID** to submit a specific identifier. A successful refresh stores that identifier with the provider profile. Open the provider's **History** to see its jobs and stored snapshots. **View snapshot** opens the recorded response and normalized profile. Details load current profiles; historical profiles and stored responses load only when opened.

Jobs use a saved artist identifier or a single corroborated identifier from that provider's stored artist credits. Otherwise they read up to five search candidates and one artist profile. Conflicting stored credits and searches without a single exact match appear in the job's diagnostics. Supply a Spotify artist ID, Last.fm artist URL or MBID, Discogs numeric artist ID, or MusicBrainz artist MBID to select the record directly. Spotify authorization uses a separate request through the same gate.

For a Discogs local worker paired before artist enrichment, add `/artists/{id}` to `LOCAL_WORKER_PATHS` and `q` to `LOCAL_WORKER_QUERY_PARAMETERS`. Pause Discogs dispatch, let its active requests finish, then pair and restart the local worker with the new configuration before resuming dispatch. Existing pairings retain their original allowlists. See [local worker setup](job-worker.md#discogs-execution).

Artist profile history is separate from album/film scrape history. Enrichment must not change album titles, credits, release tags or track identities. Do not run whole-library enrichment as validation: inspect provider queues and use an explicitly bounded selection, beginning with one item per provider.

## Music tag display and filtering

Artist tags remain artist evidence. The app does not copy them into album or track tag memberships.

- With two or more distinct visible album tags, the default Tags display uses album tags.
- With zero or one distinct visible album tag, it supplements them with artist tags.
- Names are deduplicated without regard to case or repeated whitespace. If an album and artist share a tag, the album provenance wins.
- Tracks apply the same rule using their linked library album's tags and their credited artists' tags.
- The default Tags filter follows that display rule. Album tags and Artist tags are also available independently, so artist evidence can be queried even when an album has enough release tags.

Artist-derived pills are identified as artist tags. Search can find artist tags independently of whether they are used in the default fallback display. Refreshing a profile changes these projections on the next read without rewriting media tags or their provenance.
