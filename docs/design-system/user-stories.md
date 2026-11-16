# User stories

The tasks the [design library](README.md) is designed around. There is one user: the owner of the library, who browses and plays it, and also maintains it by importing, matching, refreshing and repairing its data.

Each story gives the path today, the proposed path and the mockup that shows it. Today's paths come from the [audit](audit.md). **UI only** means the proposed path can be built from data the app already serves. **Needs API** means a new or changed endpoint comes first.

## Browse and play

### 1. Pick something to listen to

> I want to scan my albums and recognise them at a glance, so I can choose one quickly.

- **Today.** Each card shows a sort pill, tag badges, a ratings strip and play buttons over the cover, then a title, a service icon, a byline, tags and an extra row. The covers are hard to see and the grid is tiring to scan.
- **Proposed.** The cover is clean. Under it: title, artist, and one line with the year and one rating. The value you sort by replaces the rating. Tags are an optional fourth line.
- **See.** [Album card](screens-browse.html#card), [Albums · Grid](screens-browse.html#grid). UI only.

### 2. Play or queue from anywhere

> I want Play and Queue in the same place on every album, track and playlist, so I never hunt for them.

- **Today.** The buttons sit over the artwork, before the title, in their own column, in place of the track number or at the end of the row, in nine styles.
- **Proposed.** One Play and Queue pair. On a card it sits on the artwork. In a row it sits at the end of the title cell. In a header it is the first two buttons. Artwork and titles open the item and never play it.
- **See.** [Play control](components.html#play). UI only.

### 3. Read a table without losing my place

> I want every table to look and behave the same, so I can read any of them without relearning it.

- **Today.** Five table implementations with different row heights, alignment, sort headers and selection footers. Scrolling a wide table sideways loses the title column.
- **Proposed.** One table. The title column is first and stays in view. Numbers align right. Columns follow one order on every resource. Selecting rows brings up one selection bar.
- **See.** [Table](components.html#table), [Default columns](screens-browse.html#columns). UI only.

### 4. Use it on my phone

> I want to browse, open and play from my phone with nothing cut off.

- **Today.** The rail's status lines and filter chips disappear, and tables scroll sideways.
- **Proposed.** A bottom tab bar, list rows by default, Play and Queue always visible, the drawer as a full-height sheet.
- **See.** [Phone](screens-browse.html#phone). UI only.

## Understand an item

### 5. See what an album is

> When I open an album I want its tracks, tags, playlists and headline numbers on one screen.

- **Today.** The overview is a grid of every stored field followed by a section per text field. Tracks are on another tab, in a capped box with a full toolbar. Playlists are on a third tab.
- **Proposed.** Four figures, a compact track table (number, title, duration, scrobbles), tags, playlists and six facts. Everything else is behind All fields.
- **See.** [Album · Overview](screens-detail.html#album). UI only.

### 6. Know where I am on any item

> I want every item to open with the same layout and the same tabs in the same order.

- **Today.** Ten resources have ten tab sets, four title sizes and five artwork treatments.
- **Proposed.** One header: artwork, kind, title, creator, one line of facts, actions. Tabs in one order: Overview, the item's lists, Listening, Sources, Edit.
- **See.** [One header for every resource](screens-detail.html#headers), [Tabs for every resource](screens-detail.html#tabs). UI only.

### 7. Move between relatives

> From a track I want to reach its album, its artist and the artist's other albums, and step back the way I came.

- **Today.** This works through the drawer, but relatives appear as pills, text links, table rows or filter buttons depending on the resource, and some tag pills leave the page.
- **Proposed.** The creator is always the second line of the header and always a link. An item's lists are tabs holding the shared table. Tags filter in place. Breadcrumbs in the drawer show the path.
- **See.** [Track, artist and film](screens-detail.html#others). UI only.

### 8. See how much I have listened

> I want a line chart of my listening for any album, track, artist or playlist, and it should look right whether there are twenty scrobbles or twenty thousand.

- **Today.** Albums and tracks only. The album chart has dots and Bar and Line toggles; the track chart is fixed bars. Months or years only, no range, no tooltip. Sparse items draw as a row of spikes.
- **Proposed.** One trend chart: a smooth line with a soft fill and no point markers, a crosshair and tooltip, and ranges of 30 days, 1 year, 5 years and all time. The chart picks days, weeks, months, quarters or years so the line has enough in each point to read as a line. Gaps are filled with zero. The current period is dotted.
- **See.** [Trend chart](components.html#chart), [Listening chart, everywhere](screens-data.html#listening).
- **Scope.** Albums and tracks at monthly grain are UI only. Daily and weekly grain, and artist and playlist series, need API.

## Know where data comes from

### 9. Check where a value came from

> A rating looks wrong. I want to see which provider supplied it, when, and from which fetch.

- **Today.** Sources lists providers and identifiers, not values. History opens below the table as three stacked tables. Nothing links to the provider's page.
- **Proposed.** Each provider is one row: match, identifier, age and state. Opening it shows what it supplies and its history in place. All fields lists every value beside its provider. The provider name links to the provider; each history entry links to its job.
- **See.** [Sources tab](screens-data.html#sources), [Where each value comes from](screens-data.html#provenance), [From a value to its source and back](screens-data.html#trace).
- **Scope.** Rows and history are UI only. Per-field provenance needs API.

### 10. Fix a wrong match

> An album is matched to the wrong release. I want to correct it and see the data update.

- **Today.** Pencil icon, a form that appears below the table, Update, then a separate refresh. On artists, saving is the refresh. On films, the prompt to identify opens Edit instead of Sources.
- **Proposed.** Open the provider row and choose Find match. Pick a candidate or paste an identifier. Saving refreshes that provider, and the row shows Running, then the new values and a history entry. The same steps on every resource.
- **See.** [Source row states](screens-data.html#source-states). UI only.

### 11. Link scrobble names

> My scrobbles for an album are split across differently spelled names. I want to link them where I manage the album's other sources.

- **Today.** Two lists of names under the Listening chart, with Add and Remove buttons before each name, and a separate read-only list on tracks.
- **Proposed.** The Last.fm row in Sources holds a table of linked and suggested names with counts and Link or Unlink. Listening shows the chart and a link to it.
- **See.** [Sources tab](screens-data.html#sources). UI only.

## Fill in and repair

### 12. Fill in what is missing for a playlist

> I am looking at a playlist and want its tracks and albums to have ratings and tags. I want to see what is missing and fetch it.

- **Today.** Leave the playlist, open Jobs, then Metadata, rebuild the selection with filters, pick a provider, review and queue. Nothing on the playlist says what is missing.
- **Proposed.** The playlist overview has Coverage: one line per provider with a count and a Queue button for the gap. Missing data filters the track list to rows with gaps. Queue shows the review step, then a batch appears in Jobs and the coverage updates as it runs.
- **See.** [Filling in missing data](screens-data.html#coverage). Needs API.

### 13. Refresh stale data across a library

> I want to refresh everything a provider has not updated in a while, without flooding it.

- **Today.** Metadata does this well for albums and films. The artist version words and shows freshness differently.
- **Proposed.** The approach stays. Freshness is an age in words, stale and missing cells take the status colours, and the selection bar carries the provider, the rule and the number of jobs. One table for every library.
- **See.** [Activity popover and Metadata](screens-ops.html#activity). UI only.

### 14. Identify a film that has no ID

> A film came in without an identifier. I want to find it and fix it.

- **Today.** An amber pill on the card and in the header opens Edit.
- **Proposed.** Needs ID is a status. Find match on the row, in the header and in Sources all open the same matching step.
- **See.** [Source row states](screens-data.html#source-states). UI only.

### 15. Tidy tags

> I want to merge or hide a tag from the place I noticed it.

- **Today.** Tags open in their own dialog, separate from the drawer every other item uses.
- **Proposed.** A tag opens in the shared drawer with the same header and tabs: Overview (items, merged names), Sources.
- **See.** [Tabs for every resource](screens-detail.html#tabs). UI only.

## Keep it running

### 16. Find out why nothing is happening

> I queued metadata an hour ago and it has not finished. I want to know why.

- **Today.** The jobs are "queued". The reason is on a different page: a provider that is cooling down, found by opening providers one at a time.
- **Proposed.** Jobs shows provider state above the table. The batch row reads "Waiting until 14:20" with its progress. The provider name opens the provider page, where the same notice offers Resume now.
- **See.** [Jobs](screens-ops.html#jobs), [Provider page](screens-ops.html#provider).
- **Scope.** Linking and provider state are UI only. The waiting reason on each job needs API.

### 17. Deal with failures

> I want to see what failed, why, and retry the ones worth retrying.

- **Today.** Result is hidden by default. The job drawer shows an alert, a JSON tab and a log.
- **Proposed.** Result is a default column. Needs attention filters the table. The job drawer leads with the reason and the two actions that fix it, then attempts as a timeline, then the request and response.
- **See.** [Job details](screens-ops.html#job). The leading reason and suggested action need API; the rest is UI only.

### 18. Check every provider at a glance

> I want one screen that tells me which providers are healthy, which are waiting and which need me.

- **Today.** One provider at a time, chosen from a list with one grey status line each.
- **Proposed.** A table of all providers: connection, queue, queued and failed jobs, last success, requests over 24 hours and daily budget. Problems are notices at the top with the button that fixes them.
- **See.** [Providers · overview](screens-ops.html#providers). Needs API for the combined request; every figure already exists per provider.

### 19. Reconnect an account

> Spotify or YouTube has signed me out. I want to see that and sign in again in one place.

- **Today.** Connection controls are spread across imports, the player and Providers, and are not shown on Providers at all.
- **Proposed.** Connection is a column on the overview and a line on the provider page, with Sign in beside it. Disconnect always asks first.
- **See.** [Account connections](screens-ops.html#connections). UI only.

### 20. Follow an import

> After starting an import I want to watch it and open what it created.

- **Today.** Import history and jobs are separate pages, joined by a link inside a popover.
- **Proposed.** An import is a batch row in Jobs with a progress bar. Expanding it lists its jobs; each target opens the item.
- **See.** [Jobs](screens-ops.html#jobs). UI only for metadata batches; progress counts on imports need API.

## The loop

Stories 9, 12, 16 and 17 are one loop seen from four places. The proposal links every step in both directions:

```text
item  →  Sources row  →  provider page  →  job  →  item
```

- From an **item**: Sources shows each provider's match and age; a provider name opens the provider.
- From a **provider**: Jobs lists its work; each target opens the item.
- From a **job**: the target opens the item, the provider opens the provider, the batch opens its siblings.
- From a **set** (playlist, artist, library): Coverage shows the gap and queues the jobs that close it.
