# Interface audit

This is the inventory behind the [design library](README.md). It records how the web app is built today, what is already consistent and what is not. The proposal that answers it is in the HTML pages; each section below links to the relevant one.

The audit covers `apps/web` and `packages/ui` as they stood on 2026-11-16: every `.tsx` file under `apps/web/components` and `apps/web/app` (181 files, tests excluded), `packages/ui/src/globals.css` (about 4,860 lines), four CSS modules and the six shared primitives. Counts come from scripted passes over the code and will drift as the code changes. The running app was also walked screen by screen; nothing from that walk is reproduced here, and every example in the library uses invented data.

Paths are relative to `apps/web/components/` unless they start with a package or app path.

## Summary

### Already consistent

These work well and the proposal keeps them.

- **The shell.** A 196px rail, one white panel, a shared detail drawer and the player dock.
- **Primary Browse.** Albums, Films, Tracks, Artists and Subscriptions share `BrowseToolbar`, `AiSearch`, the filter panel, filter chips, ranges and URL state.
- **The drawer.** `DetailLink` opens it on a plain click and the page on a modified click, with a back stack.
- **Play is always followed by Add to queue.** Every one of about 25 call sites keeps the pair together.
- **Review before large runs.** Metadata runs and bulk job actions show a review step.
- **The palette in outline.** Cool grey page, white panels, dark text, slate accent, amber and red for state, IBM Plex throughout.
- **Error wording.** "Could not load X." is used 66 times with no "Failed to" or "Unable to" variants.
- **Virtualised lists** with shimmer placeholders on every long list.

### Least consistent

Ranked by how often the difference is visible.

| #   | Element                       | Today                                                                                           |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Tables                        | 5 implementations, 2 sort headers, 4 row heights, numbers aligned two ways                      |
| 2   | Play controls                 | 9 visual variants, 6 positions relative to the title                                            |
| 3   | Provider section              | One provider at a time, 4 tabs, queue controls rendered twice, state hidden on phone            |
| 4   | Status                        | 8 displays for job, sync, freshness and connection state; 5 words for "finished"                |
| 5   | Detail headers and tabs       | 4 title sizes, 5 artwork treatments, 10 tab sets for 10 resources                               |
| 6   | Pills and badges              | 10 styles; filter-mode colours defined twice                                                    |
| 7   | Sources                       | A shared table for albums, films and artists; prose for tracks; panels open away from their row |
| 8   | Listening                     | 2 resources only; 2 chart configurations; no range control                                      |
| 9   | Colour                        | 2 token sets and about 100 literals; the three most-used colours are not tokens                 |
| 10  | Size and space                | 9 control heights, 15 radii, 13 font sizes, about 60 padding values                             |
| 11  | Dates                         | About 11 helpers, four of them identical copies; locale strings beside ISO slices               |
| 12  | Retry, Close and confirmation | Retry in 6 styles (77 instances); Close at 4 sizes; 6 confirmation patterns                     |

## 1. Foundations

Proposal: [Foundations](foundations.html).

| Aspect                   | Today                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tokens                   | Two parallel sets in `packages/ui/src/globals.css`: shadcn HSL triplets used by Tailwind and the primitives, and hex `--ink`, `--line`, `--chip` used by the stylesheet. Several values are duplicated as literals.                                    |
| Untokenised colours      | About 100 literals. Most used: `#334155` ×47 (accent), `#667080` ×29 (muted text), `#a32318` ×13 (error).                                                                                                                                              |
| Muted text               | `#667080`, `#555`, `#666`, `#737373`, `--ink-2`, `--muted-foreground`. `.muted` and `.quiet` are separate classes doing the same job, each used in about 95 places.                                                                                    |
| Hover and selected       | Two sets: `#f7f8fa` / `#edf0f5` (compact table, job list, queue) and `#f4f6f9` / `#e8edf3` (browse table, list rows, rail).                                                                                                                            |
| Dark fills               | `#334155` with white text on the table selection footer, the default `Button`, the player toggle, the queue count and active column filters. Dark glass on artwork for play buttons, sort pills and video badges. The rating tooltip is neutral black. |
| Brand colours            | IMDb yellow and Metacritic green, yellow and red on rating badges.                                                                                                                                                                                     |
| Dark theme               | None.                                                                                                                                                                                                                                                  |
| Font sizes               | 13 in CSS (12, 11 and 13px dominate) plus Tailwind `text-xs` and `text-sm`. Primitives default to 14px and are overridden almost everywhere.                                                                                                           |
| Weights and line-heights | 7 weights; 17 line-heights mixing unitless and pixel values.                                                                                                                                                                                           |
| Page titles              | 8 styles between 15 and 28px.                                                                                                                                                                                                                          |
| Section labels           | The same 11px label is written out 6 times without a class.                                                                                                                                                                                            |
| Padding and gap          | About 60 padding values and 16 gaps, including 3, 5, 7, 9, 15 and 22px. No scale.                                                                                                                                                                      |
| Control heights          | 20, 22, 24, 26, 28, 30, 32, 36 and 40px. `Button` and `Input` are 36px; hand-styled controls are 28 to 30px.                                                                                                                                           |
| Radii                    | 15 values; 7px, 8px and 6px are each used more than 15 times.                                                                                                                                                                                          |
| Shadows and blur         | 25 shadows and 4 blur recipes.                                                                                                                                                                                                                         |
| Styling method           | Split almost evenly between Tailwind utilities and named classes, divided by page area: browse, player and tables use classes; detail panels, settings and dialogs use utilities.                                                                      |
| Scroll areas             | `scrollbar-gutter: stable` on the main scrollers. Hidden scrollbars on the rating strip, tag badges, list-row service links, detail tab list and provider tabs, so their overflow is clipped with no cue.                                              |

## 2. Components

Proposal: [Components](components.html).

### Tables

| Implementation                       | Used for                                                                                     | Header / row    | Notes                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inline browse table (`browse-table`) | Albums and Films, Tracks, Artists                                                            | 34 / 36px       | Copied in `media-browser.tsx`, `track-browser.tsx`, `artist-browser.tsx`, with its own sort header and column resizer (about 70 lines each). Numbers left-aligned. |
| Same, on `compact-table`             | Subscriptions                                                                                | 24 / 35px       | Fourth copy of the browse table on different classes. Numbers right-aligned.                                                                                       |
| Composed secondary table             | Jobs, metadata selection, playlists, tags, imports, sources, creator libraries and 13 others | 24 / 32px       | `SecondaryTableHead`, `SecondaryTableScroll`, `useTableColumns`. Dark selection footer.                                                                            |
| `SecondaryDataTable`                 | Recent imports, legacy sources, API keys, link summary                                       | 24 / 28 to 32px | In-memory data with built-in search.                                                                                                                               |
| Virtual `div` and `ul` lists         | Nested media, manual add results, playlist chooser, queue, job items                         | varies          | Tabular content without table markup.                                                                                                                              |
| `packages/ui` `Table`                | Nothing                                                                                      | –               | The wrapper has no call sites outside its test.                                                                                                                    |

Departures from `docs/secondary-tables.md`:

- No sort headers: source snapshots, identifier sources, metadata source list, track merge, tag merge.
- Search outside the toolbar: track merge, tag merge.
- Toolbar type chosen at run time: `creator-library-table.tsx`.
- Not virtualised: Spotify playlists, sources, channels.
- The tri-state header checkbox is written by hand in 8 files.
- Row opening differs: double-click in the primary tables, single click in Playlists, title link only elsewhere.
- A new sort key starts descending in primary tables and ascending in secondary tables.
- Sort and search live in the URL for some tables and in component state for Playlists, Collections and Tags.

### Play controls

| Context                                    | Position                             | Form                                                 |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------------------- |
| Album grid tile                            | Over the artwork                     | Round dark glass buttons                             |
| Album list and table rows                  | Before the title                     | 20px icon buttons                                    |
| Track table                                | Own leading column, with the artwork | Icon buttons                                         |
| Track list                                 | End of the row                       | Icon buttons                                         |
| Album track table                          | Replaces the track number            | Number that becomes an icon                          |
| Album or playlist named inside another row | Before that name                     | Icon button                                          |
| Playlist membership pills                  | Before the pill                      | Icon button                                          |
| Album and track header                     | Below the facts                      | `Button` Play and outline Add to queue               |
| Playlist header                            | In the actions row                   | Raw buttons, a different style from the album header |
| Player dock                                | Transport                            | Dark round toggle, 28px tools                        |

Nine visual variants. Two exported buttons in `play-controls.tsx` have no call sites. Artist cards have no play control.

### Buttons

- `Button` has 163 uses: outline small 53, default 26, ghost small 26, default small 23, outline 15, ghost 11, destructive 1.
- 154 raw `<button>` elements are styled by context selectors or left unstyled; 46 of them are underlined text.
- **Retry** appears 77 times in 6 styles: underlined text (37), unstyled (22), default button (8), spaced underline (4), ghost (4), outline (2).
- **Close** uses an X at 14, 16, 18 and 20px.
- **Icon buttons** are 20, 24, 26 and 28px with radii of 5, 6, 7px and round.
- **Destructive actions** use 6 confirmation patterns: a footer, an inline button pair, a toggling label, a checkbox, a review step and none. Disconnecting Spotify or Sonos and revoking an API key are immediate; disconnecting YouTube asks first.

### Pills and badges

Ten styles: filter pill, metadata tag, browse tag badge, tile sort pill, list sort pill, Needs ID, rating badge, video badge, worker badge and two count badges. They differ in padding (0 to 3px by 6 to 9px), size (10 to 12px) and background. The any, required and exclude colours are defined twice with identical values.

### Status

| What                        | How it is shown                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Job status                  | Dot and text; the raw value capitalised by CSS. Sometimes a span, sometimes an underlined link.              |
| Import status               | The same dot; the filter lists raw lowercase values.                                                         |
| Sync state                  | Plain text in a definition list: Not synced, Running, Paused, Stopped, Failed, Complete.                     |
| Playlist import             | Queued, Importing, Imported; listing shows Listing, Listed.                                                  |
| Freshness, albums and films | A date, a status link, "Succeeded" or "Never", plus an amber Needs ID pill.                                  |
| Freshness, artists          | A date, "Queued", "Running", "Not scraped" or "Never", with a warning popover.                               |
| Provider in the rail        | One grey line: Access halted, Cooling down, Needs credentials, Account sync or Import only. Hidden on phone. |
| Provider in Sources         | Text in the Updated cell: Provider halted, Provider cooling down, Credentials required.                      |
| Provider in a picker        | Parenthesised: (needs credentials), (halted), (waits for cooldown).                                          |
| Queue                       | Bold text: Queue enabled, paused, stopped, or paused and stopped.                                            |
| Connection                  | Plain text. Spotify playback is hard-coded as "Connected".                                                   |
| Saved                       | "Saved", "Saved.", "Changes saved." and "Request budget updated."                                            |

A successful finish is shown as succeeded, Complete, Imported, Listed or a bare date. A job held by a provider limit is shown as queued, with no reason.

### Charts

- `listening-chart.tsx`: hand-written SVG, bars or a 1.5px line with an area. Dots on every point when there are 40 periods or fewer. Year labels only. No floating tooltip; the hovered value is a text line under the chart. Year or month buckets, no range control.
- `provider-activity.tsx`: a second hand-written SVG bar chart with its own tick and label code.
- Progress: a native `<progress>` on sync pages, "page x/y" text on jobs, Processed and Total columns on imports, nothing on metadata batches.

### Overlays

Six mechanisms: the shared drawer, a `<dialog>` drawer whose markup is copied in 5 files, native `popover` with 5 owners, `<details>` popovers closed by document listeners, a manually positioned tooltip, and toasts (errors only). Popovers use 7 shells with 3 radii and 5 shadows. About 120 native `title` tooltips.

### Empty, loading and error

- Loading: "Loading X..." in 51 places and "Loading…" in 3; shimmer placeholders in 5 markup variants.
- Empty: about 61 "No X." sentences across three components (`browse-empty`, `TableState`, `nested-media-empty`). Albums, Films, Tracks and Artists say "No matches. Clear filters" even when the library is empty; the other pages tell the two cases apart.
- Errors appear as a sticky overlay (primary Browse), a paragraph above the table (People, Playlists, Collections), a table row (Channels) or a paragraph below the table (Tags).
- Counts read "N albums" with no singular, "N results" (People), "N sources" (Channels) and "... tags".

### Tabs, segmented controls and inputs

- Segmented controls come in 5 forms: `Tabs`, a ghost button toggle, an outline button toggle, raw pressed buttons and radio inputs.
- Tabs come in two looks: a filled list in the drawer and an underline on the provider page.
- Search boxes come in 6 forms, 28 or 30px high, filled or ringed.
- Native selects are restyled in about 9 places at 5 heights.
- 35 raw checkboxes with no shared component.

### Dates and durations

About 11 date paths: inline `toLocaleString()` (36 calls in 18 files), four identical `formatDateTime` copies, `formatShortDateTime`, `formatDate`, two identical `<time>` cells, a creator-library variant, a chart label helper, a subscription helper and raw ISO slices. Five duration helpers. The same job can show a locale date with seconds in one table and an ISO date in another.

### Headings and label-value pairs

About 12 class and size combinations for in-page section headings. Seven layouts for label and value pairs, with 5 label greys; the player connections list reverses the label and value emphasis.

## 3. Browse

Proposal: [Browse screens](screens-browse.html).

### By resource

| Resource         | Views             | Default view and sort | Table columns as rendered                                                                                     | Play                            |
| ---------------- | ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Albums           | Grid, List, Table | Grid, Added ↓         | Title, Artists, Tags, Released, Added, Scrobbles, RYM rating, Providers                                       | Tile overlay; before title      |
| Films            | Grid, List, Table | Grid, Released ↓      | Title, Directors, Tags, Source, Watched, Released, Added, Providers                                           | –                               |
| Tracks           | Grid, List, Table | List, Added ↓         | Artwork and playback, Title, Artists, Album, Playlists, Tags, Added, Duration, Scrobbles                      | Leading column; end of list row |
| Artists          | Grid, List, Table | List, Name ↑          | Artwork, Artist, Tags, Country, Added, Albums, Tracks, Playlists                                              | –                               |
| Subscriptions    | Grid, List, Table | Grid, Published ↓     | Thumbnail, Title, Channel, Type, Published, Duration, Views                                                   | –                               |
| Playlists        | Table             | Name ↑                | Artwork, Playlist, Owner, Tracks, In album library, Albums, Duration, Imported, Schedule, Last checked, Added | Before the name                 |
| People           | Table             | Name ↑                | Person, Films, As director, As actor                                                                          | –                               |
| Channels         | Table             | Name ↑                | Name, Type, Stored items, Latest item, Subscribers                                                            | –                               |
| Film collections | Table             | Name ↑                | Collection, Films                                                                                             | –                               |
| Tags             | Table             | –                     | Checkbox, Tag, Items, Sources, Actions                                                                        | –                               |

The secondary pages (Playlists, People, Channels, Collections, Tags) offer a table and a plain search box only: no Grid or List, no field filters, no AI search.

### The album card

Top to bottom, a card can show: a sort-value pill, tag badges, a strip of provider ratings and play controls, all over the artwork; then the title with a Spotify icon, the artists and year, tags again when the overlay is off, and an extra row for the sort value or ratings. Three densities exist for Albums and Films only. Track and artist cards use a fixed size; subscription cards use their own markup.

### Inconsistencies

1. Columns render in field-definition order, not the order chosen, and cannot be reordered. Tags is always second.
2. Albums show the RYM rating twice by default: its own column and inside the Providers column.
3. Films offer Description and Awards as sort fields and list Description first.
4. Numbers are left-aligned in the browse table and right-aligned in the compact table.
5. The artwork column is absent (Albums, Films), 96px with play controls (Tracks), 48px (Artists), 70px (Subscriptions) or a toggleable 24px column (Playlists).
6. Artwork fallbacks differ: the title as text on tiles, "No artwork" on nested cards, nothing in lists.
7. The Artists field list labels two different fields "Playlists".
8. The Tags table lets its name column be hidden; every other table pins it.
9. The limit chip reads "Top N" on Albums and "Limit: N" on Artists.
10. Channels loads its whole list and filters in the browser.
11. Tags open in their own dialog instead of the shared drawer.
12. Opening a row needs a double-click in primary tables.

## 4. Detail

Proposal: [Detail screens](screens-detail.html).

### Header

| Resource          | Artwork               | Title | Creator line                     | Play                             | Filter actions            |
| ----------------- | --------------------- | ----- | -------------------------------- | -------------------------------- | ------------------------- |
| Album             | 150px square          | 28px  | Artist pills                     | Play, Add to queue               | –                         |
| Film              | 150px poster          | 28px  | Director pills                   | –                                | –                         |
| Track             | 150px square          | 28px  | Artist pills, album as text link | Play, Add to queue               | –                         |
| Artist            | 150px if present      | 20px  | –                                | –                                | Albums, Tracks            |
| Person            | –                     | 20px  | –                                | –                                | Films per role            |
| Channel           | 32px avatar           | 20px  | –                                | –                                | Subscriptions             |
| Playlist          | 64px                  | 18px  | –                                | Play, Add to queue (raw buttons) | Tracks, Albums            |
| Collection        | –                     | 18px  | –                                | –                                | Films, outside the header |
| Subscription item | 16:9, above the title | 18px  | Channel pill                     | –                                | –                         |
| Job               | –                     | 20px  | –                                | –                                | –                         |

### Tabs

| Resource          | First tab          | Then                                                |
| ----------------- | ------------------ | --------------------------------------------------- |
| Album             | Overview           | Playlists · Tracks (N) · Listening · Sources · Edit |
| Film              | Overview           | Sources · Edit                                      |
| Track             | Overview           | Playlists · Listening · Sources                     |
| Artist            | Overview           | Albums · Tracks · Playlists · Sources               |
| Person            | Films              | Sources                                             |
| Channel           | Videos or Episodes | Sources                                             |
| Playlist          | Tracks             | Sources (stored as `sync`)                          |
| Collection        | Films              | Sources                                             |
| Subscription item | Overview           | Sources                                             |
| Job               | Overview           | Stored JSON · Logs                                  |

### Overview

- **Album and film:** a summary paragraph, then a grid of every non-text browse field, then one section per text field with pills. Ratings appear only in the header. Nothing is collapsed and nothing is prioritised.
- **Album tracks** are behind the Tracks tab: a table with a full Browse toolbar, in a box capped at 420px or half the viewport, with Artists and Album columns that repeat the header.
- **Track:** four hand-coded figures and tag sections. **Artist:** summary, counts and tag links that navigate away. **Subscription item:** figures, tags, then the description, the reverse of the album order.
- Album tab deep links (`tab=listening`, `playlists`, `tracks`) land on Overview unless a second parameter is also set.

### Relatives

Every relative opens in the drawer, but through four forms: pills (artists, people, collections, playlists, channels), an underlined text link (a track's album), table rows (an artist's albums and tracks), and filter buttons that change the browse page instead. Tag pills filter in place in the album, film and track drawers, navigate to Browse from an artist, and do a full page load from a standalone album page.

### Drawer and page

The standalone page reuses the drawer content in a centred 1100px column. Playlist and collection pages are full width. The page has no browse callbacks, so several pills change from filters into links. Jobs have both a drawer and a page.

## 5. Sources and listening

Proposal: [Sources and listening](screens-data.html).

### Sources

- **Albums, films and artists** use `provider-sources.tsx`: a table of Provider, Identifier and Updated with pencil and history icons, and a footer button that reads "Refresh selected", "Refresh matching sources" or "Refresh all eligible".
- The edit and history panels render **below the table and the refresh results**, not beside their row. History stacks three tables: snapshots, the selected snapshot's JSON, and a jobs table.
- The search box appears only when there are more than 3 rows. The history icon is labelled "history" or "details" depending on scope.
- Saving an identifier works two ways: album and film save without refreshing; artist saves by refreshing.
- **Tracks** have no table: the tab is prose about the Spotify match and a list of recorded Last.fm names, with no refresh or history.
- **Playlists, channels, subscription items, collections and people** get a read-only one-row table. A person's Sources tab is always empty.
- The provider name is plain text. Reasons such as "Credentials required" do not link to the provider.
- A film's "Identify film" action opens Edit, but identifiers are corrected in Sources.
- Change history is split: edits under Edit, provider changes under Sources.

### Listening

- Only albums and tracks have a Listening tab.
- **Album:** figures, a track select, Year or Month and Bar or Line toggles (default Month and Line), the chart, then two lists: "Linked scrobble names" with Remove and "Similar unlinked names" with Add, an "Add scrobbled name" picker and a link to the scrobble links page.
- **Track:** the same figures and a fixed monthly bar chart with no controls, then a read-only "Scrobbled names" list, which appears again under Sources.
- Artists and playlists have no listening view.

## 6. Jobs, providers and the rest

Proposal: [Jobs and providers](screens-ops.html).

### Jobs

- Pages are per library ("Album jobs", "Film jobs"). Tracks has no Jobs link.
- Columns: checkbox, an underlined "View" link, Provider, Job, Status, Created. Started, Finished and Result are hidden by default.
- Provider and target are plain text in the table and in the job drawer. A job does not link to its provider; a provider's jobs do not link back.
- A batch is shown by filtering the table; each job in it is its own row.
- Progress is the text "page x/y" for page-reading jobs only.
- Provider state is absent from the jobs table and from the activity popover.
- The job drawer's tabs are Overview, Stored JSON and Logs.
- Bulk actions are a select and a review step in the dark footer.

### Metadata

Albums and films use `film-selection-table.tsx`; artists use `artist-metadata-table.tsx`. The two differ in freshness wording ("Never" and "Not scraped"), presentation (a status link and a warning popover), provider picker and the link shown after queueing.

### Providers

- One provider at a time. The list is in the rail with one status line each and no search, grouping, counts or colour. On phone the status line is hidden.
- The list depends on the current library. Sonos appears under both Albums and Films. Artists has no Providers link, although the page supports it.
- The provider page nests rail list, header, four tabs (Activity, Jobs, Credentials, Settings), sections, disclosures and tables in a 960px column.
- Queue controls render on both Activity and Jobs. The Jobs tab exists only when the provider has jobs.
- The cooldown notice appears on Activity only. On Credentials, "Check credentials" is disabled during a cooldown with no reason shown.
- Settings shows the same fixed paragraph for every provider.

### Account connections

Spotify connects in the album import, the playlist import, the podcast page and the player; Sonos in the player's device popover; YouTube on its import page; Last.fm by API key on Providers. Neither Providers nor User shows connection state.

### Imports

Six workflow shapes. Confirmation of a large run is a checkbox on imports and playlists and a review step on jobs and metadata. Import history and jobs are separate destinations joined only by a link inside a Result popover.

### Shell

- The rail's lower slot holds section navigation on admin pages and filter chips on Browse. Both disappear on phone.
- Navigation differs by library: Tracks has no Jobs or Providers; Artists has Jobs but no Providers or Imports.
- Playback messages float over the page as a separate banner.

## 7. Seen in the running app

The code reading explains these; the walk made them obvious.

- An album card carries up to six layers of information, and the overlays compete with the cover.
- Rating strips and tag badges are cut at the edge of their cell or card with no sign that more exists.
- The dark selection footer, filled slate buttons and dark pills on artwork are the strongest contrasts on otherwise pale pages, and they mark things of low importance.
- Job times are shown as a locale date with seconds, and the result of a job is hidden by default.
- A table in the drawer scrolls inside a capped box inside the scrolling drawer.
- Finding a stuck provider means opening each provider in turn.

## 8. From audit to proposal

| Finding                                  | Answer                                          | Page                                                 |
| ---------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| Five tables                              | One table                                       | [Components](components.html#table)                  |
| Nine play variants                       | One pair, three placements                      | [Components](components.html#play)                   |
| Ten pills                                | One pill, three filter modes                    | [Components](components.html#pill)                   |
| Eight status displays                    | One status mark, eight states                   | [Foundations](foundations.html#wording)              |
| Two charts                               | One trend chart and sparkline                   | [Components](components.html#chart)                  |
| Seven popover shells                     | One popover                                     | [Components](components.html#feedback)               |
| Crowded album card                       | Artwork, title, artist, one meta line           | [Browse screens](screens-browse.html#card)           |
| Field-order columns                      | One column order, defaults per resource         | [Browse screens](screens-browse.html#columns)        |
| Ten headers and tab sets                 | One header, one tab order                       | [Detail screens](screens-detail.html#tabs)           |
| Field-dump overview                      | Figures, tracks, tags, playlists, six facts     | [Detail screens](screens-detail.html#album)          |
| Sources panels away from rows            | Expandable provider rows                        | [Sources and listening](screens-data.html#sources)   |
| Scrobble names in Listening              | In the Last.fm source row                       | [Sources and listening](screens-data.html#sources)   |
| Listening on two resources               | The same chart on four                          | [Sources and listening](screens-data.html#listening) |
| Dead ends between item, provider and job | Linked both ways                                | [Sources and listening](screens-data.html#trace)     |
| Jobs without provider state              | Provider state above the table; waiting reasons | [Jobs and providers](screens-ops.html#jobs)          |
| One provider at a time                   | Providers overview                              | [Jobs and providers](screens-ops.html#providers)     |
| Connections in five places               | On the provider                                 | [Jobs and providers](screens-ops.html#connections)   |
