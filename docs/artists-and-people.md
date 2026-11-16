# Artists, people and channels

Choose **Artists** in the library dropdown for **Browse** and **Jobs**. Artists share identities across Albums and Tracks; their directory is no longer duplicated in those libraries' navigation. People lists film directors and actors. Both use the existing creator identity and credit roles: a band is an artist without being treated as a person, and one film person can hold several roles. Channels retain the subscription source identity for YouTube channels and Spotify shows.

Artists Browse follows Tracks: Grid, List and Table, sortable fields, selectable columns, a Filters drawer, full autocomplete search and AI search. Search matches names, playlists and stored profile fields. Filter suggestions include artist names, playlist names, tags, countries, artist types and providers, with Any, Required and Exclude modes. Added dates and album, track and playlist counts support ranges. Filters, views and sorting are stored in the URL; exact counts load separately so visible rows remain usable while counting.

Creator and channel names open details by default. Related albums, tracks, playlists, films and subscription items open in the same detail inspector, with Back preserving the previous entry and its tab. Open page provides a standalone URL. Each creator or channel detail has explicit actions to filter the relevant library.

Music details put playlist memberships in a Playlists tab. Artist details show the albums, tracks and playlists already in the library; these are library memberships, not a provider's complete discography. Film people initially expose director and actor credits.

Related media tables offer Grid, List and Table through the same toolbar used by Browse. Album and track artwork stays square, film posters stay portrait, and channel thumbnails use 16:9. Each nested list type remembers its view separately. Search, sorting, role filters and playback actions remain available in every mode. Keep each nested viewport bounded to the panel; the full result height belongs inside that scroller, not in the surrounding document. Only the visible pages and overscan load, including after changing view or resizing the panel.

## Artist enrichment

**Artists → Jobs** lists artist enrichment jobs, including older jobs originally stored with the album scope. Provider, status and text filters use the same job history controls as the other libraries.

Open **Jobs → Metadata** to select artists and providers for enrichment. Each provider column shows its last successful scrape date; the details control shows the latest job status and last attempted date separately. Column filters offer never attempted, latest attempt failed, no successful scrape, and no success or older than 30, 90, 180 or 365 days. Modes for one provider match with OR; filters for different providers combine with AND. Sorting a provider column puts artists without a successful scrape first in ascending order.

Metadata uses the same full autocomplete and AI search as Browse, with field chips and ranges alongside provider freshness filters. Add playlist filters through search; the metadata **Playlists** column also supports selecting stored playlists by ID. An artist matches a playlist through credited tracks or albums. Multiple selected playlist IDs match any selected playlist; search chips use their selected Any, Required or Exclude mode. Search, playlist selection, freshness and sort stay in the URL and apply before server pagination. AI replaces Browse search filters while retaining the separately chosen provider freshness filters. Use **Select all matching artists** to save the complete filtered selection without loading its rows. The selection includes the current result cap and expires after one hour. Individual rows can be excluded. The header checkbox selects loaded artists until a complete matching selection is active. Review the selected artist and provider counts before queueing. Dispatch reads the saved IDs in batches of at most 100 artists; an interrupted request stops further batches and leaves the unconfirmed selection available for review. Confirmed batches are removed from the remaining selection. Missing or archived artists are skipped. Changing search or filters clears the selection. Active jobs are skipped and freshness is rechecked before queueing, while provider request limits and cooldowns remain in force.

Artist enrichment is an explicit job for one artist and one provider: Spotify, Last.fm, Discogs or MusicBrainz. It uses the existing provider dispatcher, request gate, budgets and cooldowns. Viewing details does not start a job. Provider identifiers are independent of the internal artist ID. An ambiguous name search needs an explicit provider artist identifier instead of silently selecting a namesake.

Successful jobs retain immutable artist provider snapshots and advance that provider's current snapshot pointer. Profiles can contain a biography, image, country, artist type, provider identifier, source link and tags when supplied by the provider. Missing fields remain absent; they are not inferred from releases. Provider availability and returned fields can vary.

Open **Sources** to see the current identifiers and refresh selected or all eligible providers. Use a provider's ID editor and **Refresh with ID** to submit a specific identifier. A successful refresh stores that identifier with the provider profile. Open the provider's **History** to see its jobs and stored snapshots. **View snapshot** opens the recorded response and normalized profile. Details load current profiles; historical profiles and stored responses load only when opened.

Identifiers also appear before artist enrichment when stored album or track credits identify the artist unambiguously. This includes Spotify album scrapes and saved-album imports, imported playlist and Liked Songs tracks, MusicBrainz and Discogs album credits, and Last.fm artist MBIDs from stored listening history. Artist MBIDs can be reused between MusicBrainz and Last.fm. Album, release-group and recording IDs remain separate from artist IDs.

Hover, focus or tap the eye beside an identifier to see the albums, tracks or artist profile that supplied it. Sources load in bounded pages and link to the originating library item and job when recorded. Viewing identifiers or their sources makes no provider requests and starts no enrichment jobs. Existing stored album evidence is available immediately without re-scraping. If a partial Spotify import omits a stored track's credits, the latest applicable album snapshot supplies them and retains its original provenance. Older playlist imports discarded artist IDs; those IDs become available after a later import supplies them or another stored source identifies the artist.

Jobs use the same stored evidence as Sources: a confirmed artist profile ID takes priority, followed by a single corroborated artist ID. Conflicting stored IDs appear as **Conflicting IDs**, with the alternatives and their origins in the eye control; they are not automatically selected. Otherwise jobs read up to five search candidates and one artist profile. Conflicting stored credits and searches without a single exact match appear in the job's diagnostics. Supply a Spotify artist ID, Last.fm artist URL or MBID, Discogs numeric artist ID, or MusicBrainz artist MBID to select the record directly. Spotify authorization uses a separate request through the same gate.

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
