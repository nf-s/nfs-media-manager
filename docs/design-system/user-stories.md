# User stories

The tasks the [design library](README.md) is designed around. There is one user: the owner of the library, who browses and plays it, and also maintains it by importing, matching, refreshing and repairing its data.

Each story gives the path before the design system, the path now and the mockup that shows it. The earlier paths come from the [audit](audit.md). **Not built** names a part of the design the app does not have yet.

## Browse and play

### 1. Pick something to listen to

> I want to scan my albums and recognise them at a glance, so I can choose one quickly.

- **Before.** Each card shows a sort pill, tag badges, a ratings strip and play buttons over the cover, then a title, a service icon, a byline, tags and an extra row. The covers are hard to see and the grid is tiring to scan.
- **Now.** The cover is clean. Under it: title, artist, and one line with the year and one rating. The value you sort by replaces the rating. A tags line follows, on by default; Filters > Views > On cards turns the rating, the sorted value and the tags line on or off.
- **See.** [Album card](screens-browse.html#card), [Albums · Grid](screens-browse.html#grid).

### 2. Play or queue from anywhere

> I want Play and Queue in the same place on every album, track and playlist, so I never hunt for them.

- **Before.** The buttons sit over the artwork, before the title, in their own column, in place of the track number or at the end of the row, in nine styles.
- **Now.** One Play and Queue pair. On a card it sits on the artwork. In a row it sits at the end of the title cell. In a header it sits under the artwork, as wide as it. Artwork and titles open the item and never play it.
- **See.** [Play control](components.html#play).

### 3. Read a table without losing my place

> I want every table to look and behave the same, so I can read any of them without relearning it.

- **Before.** Five table implementations with different row heights, alignment, sort headers and selection footers. Scrolling a wide table sideways loses the title column.
- **Now.** One table. The title column is first and stays in view. Numbers align right. Columns follow one order on every resource until the owner moves one: each entry of the column picker has a handle to drag, or to move with the Up and Down keys, and Reset order restores the default. A filtered page counts "N of M". Selecting rows brings up one selection bar.
- **See.** [Table](components.html#table), [Default columns](screens-browse.html#columns).

### 4. Use it on my phone

> I want to browse, open and play from my phone with nothing cut off.

- **Before.** The rail's status lines and filter chips disappear, and tables scroll sideways.
- **Now.** A bottom tab bar, a two-column grid or list rows, Play and Queue always visible, toolbars that wrap with the search on its own line, and the drawer as a sheet. Filters open in the same sheet. Jobs and Providers carry their counts on the corner of their tabs, and the Jobs count opens Activity above the bar.
- **See.** [Phone](screens-browse.html#phone).

## Understand an item

### 5. See what an album is

> When I open an album I want its tracks, tags, playlists and headline numbers on one screen.

- **Before.** The overview is a grid of every stored field followed by a section per text field. Tracks are on another tab, in a capped box with a full toolbar. Playlists are on a third tab.
- **Now.** Four figures, a compact track table (number, title, duration, scrobbles), tags, playlists and six facts. Everything else is behind All fields.
- **See.** [Album · Overview](screens-detail.html#album).

### 6. Know where I am on any item

> I want every item to open with the same layout and the same tabs in the same order.

- **Before.** Ten resources have ten tab sets, four title sizes and five artwork treatments.
- **Now.** One header: artwork, kind, title, creator, one line of facts, actions. Tabs in one order: Overview, the item's lists, Listening, Sources, Edit.
- **See.** [One header for every resource](screens-detail.html#headers), [Tabs for every resource](screens-detail.html#tabs).

### 7. Move between relatives

> From a track I want to reach its album, its artist and the artist's other albums, and step back the way I came.

- **Before.** This works through the drawer, but relatives appear as pills, text links, table rows or filter buttons depending on the resource, and some tag pills leave the page.
- **Now.** The creator is always the second line of the header and always a link. An item's lists are tabs holding the shared table. Tags filter in place. Back in the drawer retraces the path, and its breadcrumbs name the library and each item on the path; any of them is a link. A job's breadcrumbs include its batch.
- **See.** [Track, artist and film](screens-detail.html#others).

### 8. See how much I have listened

> I want a line chart of my listening for any album, track, artist or playlist, and it should look right whether there are twenty scrobbles or twenty thousand.

- **Before.** Albums and tracks only. The album chart has dots and Bar and Line toggles; the track chart is fixed bars. Months or years only, no range, no tooltip. Sparse items draw as a row of spikes.
- **Now.** One trend chart: a smooth line with a soft fill and no point markers, a crosshair and tooltip, and ranges of 30 days, 1 year, 5 years and all time. All time on a listening chart starts at the earliest scrobble of the whole history, so every item's chart covers the same period. The chart picks days, weeks, months, quarters or years so the line has enough in each point to read as a line. Gaps are filled with zero. The current period is dotted.
- **See.** [Trend chart](components.html#chart), [Listening chart, everywhere](screens-data.html#listening).
- **Scope.** Albums, tracks, artists and playlists, from one listening series endpoint per kind.

## Know where data comes from

### 9. Check where a value came from

> A rating looks wrong. I want to see which provider supplied it, when, and from which fetch.

- **Before.** Sources lists providers and identifiers, not values. History opens below the table as three stacked tables. Nothing links to the provider's page.
- **Now.** Each provider is one row: match, identifier, age and state. Opening it shows what it supplies and its history in place. All fields lists every value beside its provider. The provider name links to the provider; each history entry links to its job.
- **See.** [Sources tab](screens-data.html#sources), [Where each value comes from](screens-data.html#provenance), [From a value to its source and back](screens-data.html#trace).
- **Scope.** Per-field provenance is served for albums and films.

### 10. Fix a wrong match

> An album is matched to the wrong release. I want to correct it and see the data update.

- **Before.** Pencil icon, a form that appears below the table, Update, then a separate refresh. On artists, saving is the refresh. On films, the prompt to identify opens Edit instead of Sources.
- **Now.** Open the provider row and edit its identifier. When the provider's last lookup found nothing or found several records, or the row has no ID, the row offers Find match: it searches the provider for the item, the search text can be changed, and Choose stores a candidate and refreshes that provider. The identifier form stays under the search for pasting an ID. The row then shows the new values and a history entry. The same steps on every resource.
- **See.** [Source row states](screens-data.html#source-states).

### 11. Link scrobble names

> My scrobbles for an album are split across differently spelled names. I want to link them where I manage the album's other sources.

- **Before.** Two lists of names under the Listening chart, with Add and Remove buttons before each name, and a separate read-only list on tracks.
- **Now.** The Last.fm row in Sources holds a table of linked and suggested names with counts and Link or Unlink. Listening shows the chart and a link to it.
- **See.** [Sources tab](screens-data.html#sources).

## Fill in and repair

### 12. Fill in what is missing for a playlist

> I am looking at a playlist and want its tracks and albums to have ratings and tags. I want to see what is missing and fetch it.

- **Before.** Leave the playlist, open Jobs, then Metadata, rebuild the selection with filters, pick a provider, review and queue. Nothing on the playlist says what is missing.
- **Now.** Playlists and artists have a Coverage tab: one line per provider with a count, Queue for what is missing and Refresh for what is stale. Either shows the review step, then the jobs appear in Jobs and the coverage reloads. On a playlist, Albums and Artists switch what it counts, so its artists can be fetched without queueing any album. An album count opens Overview with the track list filtered to those rows: Missing data lists the entries with a gap and names it, and the selected rows are queued for one provider through the same review step. An artist count opens Artists Metadata filtered to the playlist and that gap.
- **See.** [Filling in missing data](screens-data.html#coverage).

### 13. Refresh stale data across a library

> I want to refresh everything a provider has not updated in a while, without flooding it.

- **Before.** Metadata does this well for albums and films. The artist version words and shows freshness differently.
- **Now.** The approach stays. Freshness is an age in words, stale and missing cells take the status colours, and the selection bar carries the provider, the rule and the number of jobs. One table for every library.
- **See.** [Activity popover and Metadata](screens-ops.html#activity).

### 14. Identify a film that has no ID

> A film came in without an identifier. I want to find it and fix it.

- **Before.** An amber pill on the card and in the header opens Edit.
- **Now.** Needs ID is a status on the card, the row and the provider's source row. Find match in Sources searches the provider and lists candidates to choose from, with the identifier form under it; a provider without a search offers Add ID.
- **See.** [Source row states](screens-data.html#source-states).

### 15. Tidy tags

> I want to merge or hide a tag from the place I noticed it.

- **Before.** Tags open in their own dialog, separate from the drawer every other item uses.
- **Now.** A tag opens from the Tags page in the shared drawer with the same header and tabs: Overview (merged names, hide and merge), Sources. A tag pill on an item filters the library.
- **See.** [Tabs for every resource](screens-detail.html#tabs).

## Keep it running

### 16. Find out why nothing is happening

> I queued metadata an hour ago and it has not finished. I want to know why.

- **Before.** The jobs are "queued". The reason is on a different page: a provider that is cooling down, found by opening providers one at a time.
- **Now.** Jobs shows provider state above the table. A queued job or batch row reads "Until 14:20" or the provider's reason, with its progress. The provider name opens the provider page, where the same notice offers the action that releases it.
- **See.** [Jobs](screens-ops.html#jobs), [Provider page](screens-ops.html#provider).
- **Scope.** The waiting reason is served with each job entry.

### 17. Deal with failures

> I want to see what failed, why, and retry the ones worth retrying.

- **Before.** Result is hidden by default. The job drawer shows an alert, a JSON tab and a log.
- **Now.** Result is a default column. Needs attention filters the table. The job drawer leads with the reason and the actions that fix it, then Request and response and the log as a timeline.
- **See.** [Job details](screens-ops.html#job).

### 18. Check every provider at a glance

> I want one screen that tells me which providers are healthy, which are waiting and which need me.

- **Before.** One provider at a time, chosen from a list with one grey status line each.
- **Now.** A table of all providers: connection, queue, queued and failed jobs, last success, requests over 24 hours and daily budget. Problems are notices at the top with the button that fixes them. A provider's page adds Open site, requests per day as the trend chart over 30 or 90 days, and Coverage: how many albums and films have its data, with a link to fill the rest in Metadata.
- **See.** [Providers · overview](screens-ops.html#providers).

### 19. Reconnect an account

> Spotify or YouTube has signed me out. I want to see that and sign in again in one place.

- **Before.** Connection controls are spread across imports, the player and Providers, and are not shown on Providers at all.
- **Now.** Connection is a column on the overview and a line on the provider page. Signing in stays where the account is used: imports for library accounts, the player's Play on for Spotify and Sonos playback. Disconnect always asks first.
- **See.** [Account connections](screens-ops.html#connections).

### 20. Follow an import

> After starting an import I want to watch it and open what it created.

- **Before.** Import history and jobs are separate pages, joined by a link inside a popover.
- **Now.** A batch of metadata jobs is one row in Jobs with a progress bar. Expanding it lists its jobs; each target opens the item. Recent imports stays under Imports with the same status words and a count of how far each has got. A batch row has Cancel, which asks before it stops running jobs.
- **See.** [Jobs](screens-ops.html#jobs).

## The loop

Stories 9, 12, 16 and 17 are one loop seen from four places. Every step links in both directions:

```text
item  →  Sources row  →  provider page  →  job  →  item
```

- From an **item**: Sources shows each provider's match and age; a provider name opens the provider.
- From a **provider**: Jobs lists its work; each target opens the item.
- From a **job**: the target opens the item, the provider opens the provider, the batch opens its siblings.
- From a **set** (playlist, artist, library): Coverage shows the gap and queues the jobs that close it.
