# Match diagnostics

Open **Matches** in Tracks, Albums, Artists, Films or Subscriptions. Each table compares the library entry with the names, credits and identifiers recorded by its providers. Search for a library name, recorded name or identifier. Sort by a provider column to bring its recorded names together. Open a cell to inspect additional identities or the source behind it.

## Tracks

Use **Playability → No playable version** to find recordings you cannot play from Spotify in your library. **Any playable version** includes both direct matches and other confirmed versions of the same recording. Choose **Playable on this entry** or **Playable via another version** to see each separately. An album or playlist filter narrows the entries you see. A confirmed Spotify version on a different release still counts.

**Match status** checks the entry's own provider evidence. **Missing Spotify on this entry** includes releases without their own Spotify ID. When another version is playable, the Spotify cell links to it, and Play and Add to queue use that version. Both library entries keep their identities. Existing Missing Spotify bookmarks open with **No playable version** selected. Choose **Any playability** to include every entry missing a direct match.

**Unmatched recordings** requires the entry to have neither a direct Spotify ID nor Last.fm recording evidence. **No matches at all** also requires the Discogs album position to be empty. **Missing Last.fm** and **Missing Discogs album evidence** check the entry's corresponding provider evidence.

Combine a match filter with track filters such as artist, album, playlist and source, or with scrobble, date and duration ranges. Provider names, artist credits and recorded identifiers have their own autocomplete fields. Required, Any and Exclude use the same rules as Tracks Browse. Use **AI search** to build a query, or **Filters → Columns** to choose and reorder the table's columns. Drag column edges or use the arrow keys on a focused edge to resize them.

The Album column distinguishes release appearances of the same title. Spotify shows the imported recording or a saved album track with that Spotify ID. An ID can be available even when the provider title and credits are missing. Last.fm shows the actual artist and track names on the linked listens, including spelling variants. The Discogs column shows the track at the corresponding position in the linked release's stored Discogs track list. Its link opens the album's Discogs source.

Use **Change match** beside a single Last.fm name or in the cell's additional identities to choose the library track that should receive those listens. Check both identities before confirming. This moves the recorded name and its listening history. The library album and playlist entries keep their positions.

Track **Sources** also lets you search for and add an imported scrobbled name, keep one separate, or restore automatic matching. **Merge Last.fm names** moves all the recorded names together. The destination can be another Last.fm-only track.

Use **Merge** when a separate Last.fm record and an imported Spotify track should be one library entry. The review identifies the source and the track to keep. A confirmed merge carries over the source's recorded names and playlist memberships. The manual choice is used on subsequent syncs. Standalone Last.fm rows hidden from ordinary Browse remain available in Matches.

## Albums, artists and films

Open a provider cell to inspect its Sources row. Use **Find match** where provider search is available, or edit the provider identifier. A corrected identifier takes effect on the next successful lookup. Until then the table can still show the previous response. Albums also have a Last.fm listening column for the artist and release names on linked scrobbles. Use the album's Last.fm linking tools to correct a group.

In Albums, **Google Custom Search (legacy)** shows the saved Rate Your Music title first. Open the cell details to see the selected release URL and any saved Metacritic match. When only a link survives, the cell shows the URL. Selecting a match opens the Sources row for the import that supplied it.

An authenticated candidate preview at `POST /api/v1/find-match/preview` reads the tracks for one explicit Discogs or Last.fm album identifier. It returns the provider title, artists, track count and up to 500 ordered tracks. The provider's request limits apply. Previewing preserves the album's current match.

For an incorrect album match, open the provider cell, choose **Mark incorrect**, and confirm the identifier. The decision is specific to that album and identity. **Match history** keeps the provider, identifier and date after a replacement arrives. The original snapshot stays available in Sources.

Use **Refresh** in Sources to run a supported provider again. The lookup skips rejected identities. A different successful match becomes current. If the provider has no acceptable replacement, the earlier evidence remains marked incorrect. Google Custom Search is retired. Rate Your Music can be looked up with the indexed search provider.

Automatic Discogs searches skip editions that Discogs identifies as belonging to a rejected master. You can preview a specific edition and select it after verifying its track list. Rejecting a single edition leaves its sibling editions available.

Rejected legacy Metacritic links and ratings stay in source history. They leave the album's current links, Ratings, and rating filters. An owner can record an independently verified album URL through `POST /api/v1/albums/{id}/metacritic-correction`. The correction requires the exact archived rejection and preserves the observed URL and source evidence in Sources. The corrected link carries no rating or vote count.

Use `POST /api/v1/albums/{id}/metacritic-candidates` with `{ rejected }` to inspect indexed alternatives for an unresolved Metacritic rejection. Use the same `rejected` selector as the correction request. Each lookup uses one Serply request for up to ten results and returns `items` with the observed `title`, `description` and `url`. `indexedDate`, when present, is a date from the indexed result. The provider request limits apply. Review each identity independently before recording a correction.

For incorrect Last.fm listening associations, use **Unlink** on the scrobbled name. The album history records the previous link. Last.fm retains the listens and keeps the group unlinked across syncs until you choose another album or restore automatic linking.

## Subscriptions

Videos and podcast episodes use their provider IDs. The table shows the recorded title, channel or show and the native YouTube or Spotify identity. Select the item or its source to inspect the corresponding record.
