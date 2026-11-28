# Design system

The Media Manager design system: one set of design tokens, the shared components, and the screens assembled from them. The app and these pages load the same two stylesheets, so what is drawn here is what the app renders.

All interface work in this repository uses it. The rules for agents are in [AGENTS.md](../../AGENTS.md#interface); the working guidelines are in the [UI guidelines](../dev-guidelines-ui.md).

## Viewing it

Serve the repository root over HTTP and open `docs/design-system/index.html`. There is no build step; the pages are static HTML, CSS and one script. Opened straight from disk (`file://`) the pages work but the provider logos stay blank, because browsers do not draw CSS masks from local files. The fonts load from Google Fonts, so the first view needs a connection.

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8080/docs/design-system/index.html`.

## Where things are

| Path                                           | Contents                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/ui/src/design-system/tokens.css`     | The design tokens, as `--ds-*` custom properties: colour, type, space, size, radius, shadow |
| `packages/ui/src/design-system/components.css` | Every component, as `ds-*` classes that read only the tokens                                |
| `packages/ui/src/components/ds/`               | The React components that render those classes                                              |
| `packages/ui/src/components/ui/`               | Button, Input, Label, Tabs and the one Table                                                |
| `packages/ui/src/lib/format.ts`                | Dates, times, ages, counts and durations                                                    |
| `packages/ui/src/lib/trend.ts`                 | Grain selection and smoothing for the trend chart                                           |
| `packages/ui/src/styles/`                      | Page layout per area. No component visuals                                                  |
| `index.html`                                   | Overview and the decisions behind the system                                                |
| `foundations.html`                             | Principles, colour, type, space and size, layout and overflow, icons, formats, wording      |
| `components.html`                              | Each component with its variants, rules and what it replaced                                |
| `screens-browse.html`                          | Card, Grid, List and Table, default columns per resource, phone                             |
| `screens-detail.html`                          | Detail header, tab order, overviews, standalone page                                        |
| `screens-data.html`                            | Sources, field provenance, the listening chart, coverage                                    |
| `screens-ops.html`                             | Jobs, job details, activity, Metadata, providers overview, provider page                    |
| [`audit.md`](audit.md)                         | The inventory of the earlier interface that the system answers                              |
| [`user-stories.md`](user-stories.md)           | The tasks the system is designed around                                                     |
| `assets/ds.js`                                 | Template functions that draw each component on these pages, with invented data              |
| `assets/gallery.css`                           | Layout of these documentation pages only (`g-*` classes)                                    |
| `concept-template.html`                        | The page to copy when proposing new interface. `concept-*.html` pages are pending decisions |

Mockups labelled **Before** show the interface the system replaced. They explain a decision and are never a reference. Everything else on these pages is the specification.

## Components

Import from `@repo/ui/components/ds/<file>` or `@repo/ui/components/ui/<file>`.

| Need                                    | Component                                                                                                                                                                                                                                                                                          | File                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| An action                               | `Button` (`default`, `primary`, `ghost`, `danger`, `link`; `xs`, `sm`, `md`; `icon`)                                                                                                                                                                                                               | `ui/button`                          |
| A form field                            | `Label`, `Input`, `Select`                                                                                                                                                                                                                                                                         | `ui/label`, `ui/input`, `ds/toolbar` |
| Sections of one item                    | `Tabs` (underline)                                                                                                                                                                                                                                                                                 | `ui/tabs`                            |
| Independent workspace views             | `WorkspaceTabs`                                                                                                                                                                                                                                                                                    | `ds/workspace-tabs`                  |
| A view or range switch                  | `Segmented`                                                                                                                                                                                                                                                                                        | `ds/segmented`                       |
| Any table                               | `TableScroll`, `Table`, `TableColumns`, `TableRow`, `TableHead`, `TableCell`, `TableSortButton`, `TableSelectionBar`, `TableSelectionResult`, `TableState`; a record's parts: `TableRow part`, `TablePartToggle`, `TablePartSlot`, `TablePartTitle`; a group row with actions: `TableGroupActions` | `ui/table`                           |
| A state                                 | `Status`                                                                                                                                                                                                                                                                                           | `ds/status`                          |
| A tag, filter, count, rating            | `Pill`, `Pills`, `Count`, `Rating`, `EmptyValue`                                                                                                                                                                                                                                                   | `ds/pill`                            |
| A provider's logo                       | `ProviderMark`: the logo file's shape in muted grey (`src`, `size`, `hidden`); a globe without `src`                                                                                                                                                                                               | `ds/pill`                            |
| Play, Add to queue and More             | `PlayPair` (tile, row; `more`), `MoreButton`, `BrowseActions` (More alone), `PlayHeaderButtons`                                                                                                                                                                                                    | `ds/play`                            |
| Add to Library                          | `LibraryAction` (add, find, pending). A saved item has no library action.                                                                                                                                                                                                                          | `ds/library-action`                  |
| Artwork                                 | `Art`, `Thumb`, `ArtFallback`                                                                                                                                                                                                                                                                      | `ds/artwork`                         |
| A grid item                             | `CardGrid`, `Card`, `CardTitle`                                                                                                                                                                                                                                                                    | `ds/card`                            |
| A list item                             | `List`, `ListRow`, `RowTitle`, `RowValue`, `ListHead`                                                                                                                                                                                                                                              | `ds/list-row`                        |
| A similar album                         | `SuggestionRow` (`place`: In library, On Spotify, Not on Spotify, Not looked up on Spotify), `SuggestionLink`, `SuggestionRowSkeleton`                                                                                                                                                             | `ds/suggestion`                      |
| Facts, headline figures, a titled group | `Facts`, `KeyValues`, `Stats`, `Section`                                                                                                                                                                                                                                                           | `ds/facts`                           |
| A share or progress                     | `Meter`, `Progress`, `Coverage`                                                                                                                                                                                                                                                                    | `ds/meter`                           |
| A provider's record for an item         | `SourceRow`, `SourceBlock`, `Timeline`                                                                                                                                                                                                                                                             | `ds/source`                          |
| Messages, empty, loading and error      | `Notice`, `State`, `Skeleton`                                                                                                                                                                                                                                                                      | `ds/feedback`                        |
| The head of an item                     | `DetailHeader` (`play` under the artwork, `links` for the service logos, `actions`), `DetailActionsSpacer`                                                                                                                                                                                         | `ds/detail-header`                   |
| The head of a page and its controls     | `PageHead`, `Toolbar`, `ToolbarCount`, `ToolbarEnd`, `ToolbarToggle`, `FilterLine`                                                                                                                                                                                                                 | `ds/toolbar`                         |
| The field a list is sorted by           | `SortPicker`                                                                                                                                                                                                                                                                                       | `ds/sort-picker`                     |
| Counts over time                        | `TrendChart`, `Sparkline`                                                                                                                                                                                                                                                                          | `ds/trend-chart`                     |
| A range of counts, set by its bars      | `Histogram`                                                                                                                                                                                                                                                                                        | `ds/histogram`                       |
| A filter rule written as a sentence     | `Condition`, `ConditionLine`                                                                                                                                                                                                                                                                       | `ds/condition`                       |
| Where Tags filters read tags            | `TagLocation`: Auto and the Track, Album and Artist levels, with `nextTagLocation` for its rules                                                                                                                                                                                                   | `ds/tag-location`                    |

The components page states the rules for each one. The ones that matter most:

- **One table.** 28px header, 32px rows (44px for two lines), the identity column first and pinned, numbers right-aligned, ISO dates, one sort control per sortable header, selection in the inverse bar. Columns have set widths and a handle on the header's right edge that changes them. On phones the table scrolls as a whole by default. A comparison table can keep its identity column pinned with `data-pin-identity`, reserving at least 60% of the screen for the compared values.
- **Similar albums and tracks.** Offer Grid, Detail and Table in provider order. Start albums in Detail and tracks in Table. Remember the selected view separately for each kind. Grid uses artwork cards and Table uses the shared scrollable table. In Detail, albums use suggestion rows and tracks use the same header as Track detail, with play and queue beneath the artwork and evidence and genres beneath the header.
- **Play.** Play is always immediately followed by Add to queue, then More. Films, subscription items and mixes, which cannot be played, keep More alone in the same place. Artwork and titles open the item; only the group plays.
- **Card.** Clean artwork, then title, creator, a line for the year and rating or the sorted value, and a line of tags.
- **Pills** are never clipped or scrolled: show what fits and count the rest (`+N`).
- **Status** uses one vocabulary: Queued, Running, Waiting, Done, Failed, Cancelled, Paused, Never.
- **Tabs** are for sections of one item; the segmented control is only for views, ranges and grid size.
- **Workspace tabs** switch between independent views. The strip stays visible with one tab. Each tab has a close button and the strip has an icon-only duplicate button. See [workspace tabs](components.html#workspace-tabs).
- **One toolbar order:** actions, search, sort picker, direction, view switch, Filters button, count. Grid size and columns are in the Filters drawer.
- **One chart.** `TrendChart` picks days, weeks, months, quarters or years so each point has enough in it to read as a line.
- **A filter on a count** is one filter with two views: `Histogram` sets a range by its bars, `Condition` cards state it exactly. It applies on change and is written out as a sentence.
- **No green** in any role.

## How it is organised

- **Tokens** are the only source of colour, type, space, size, radius and shadow. Nothing else uses a literal value.
- **Components** are CSS classes in `components.css` with a React component that renders them. A component has no page-specific variant.
- **Screens** put components together and add layout only, in the stylesheet for their area under `packages/ui/src/styles/`.
- **These pages** draw the same classes with `assets/ds.js`. When a component changes, change the stylesheet, the React component and its section here together.

`packages/ui/src/globals.css` sets the cascade: the reset, the tokens, the components, the utilities, then the area stylesheets.

## Adding or changing interface

Putting existing components together into a new screen needs no approval.

A new visual element, a variant with its own look, or a change to how an existing component looks does. The owner decides it:

1. Stop that part of the work.
2. Copy `concept-template.html` to `concept-<name>.html` and draw two or three concepts on it, built from the existing tokens and components and following `assets/ds.js` for markup. Use invented data.
3. Show the owner the concepts with the trade-off of each and a recommendation. Wait for the owner to accept one. Do not choose for the owner, and do not ship a temporary version.
4. Add the accepted concept to the system: tokens if it needs them (with the reason on the Foundations page), its styles in `components.css`, its React component, and its section with rules on the components page. Delete the concept pages.
5. Continue the feature with the new component.

## Checks

Two checks hold the app to these rules in CI: the style check fails on a literal colour, font, shadow or radius, or a literal size where a token exists, outside the design system, and on a style file outside the design system and `packages/ui/src/styles`; the table audit lists every table and fails on one that does not use the one table. Run both with `corepack pnpm --filter @repo/ui check:design`. Older code that breaks the rules is recorded in their baselines and allowed until it is fixed. [Development](../development.md#checks) describes what each one reads and how to shrink a baseline.

## Rules for changing this library

- All names, titles, counts and dates are invented. Do not paste real library contents, measured counts, screenshots of a real library, private plugin names or machine paths into these files.
- Interface copy is functional: no slogans, taglines or decorative headings.
- No green in any colour role.
- A new value needs a new token, and a new token needs a reason on the Foundations page.
- Keep Play immediately followed by Add to queue, then More, wherever music can be played.
- Every table uses the one table component.
