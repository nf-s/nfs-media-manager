# Design library

A proposal for one consistent Media Manager interface: a single set of design tokens, sixteen shared components, and redesigned screens assembled from them. It is a review document. **No application code uses it yet**, and nothing under `apps/` or `packages/` was changed to produce it.

## Viewing it

Open `index.html` in a browser. There is no build step and no server; the pages are static HTML, CSS and one script. The fonts load from Google Fonts, so the first view needs a connection.

```bash
open docs/design-system/index.html
```

## What is here

| File                                 | Contents                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `index.html`                         | Overview: what the review found, what stays, a build order and open questions          |
| `foundations.html`                   | Principles, colour, type, space and size, layout and overflow, icons, formats, wording |
| `components.html`                    | Each component with its variants, rules and what it replaces                           |
| `screens-browse.html`                | Album card, Grid, List and Table, default columns per resource, phone                  |
| `screens-detail.html`                | Detail header, tab order, album overview, standalone page, other resources             |
| `screens-data.html`                  | Sources, provenance, the listening chart, filling in missing data                      |
| `screens-ops.html`                   | Jobs, job details, activity, Metadata, providers overview, provider page, connections  |
| [`audit.md`](audit.md)               | The inventory of the current interface that the proposal answers                       |
| [`user-stories.md`](user-stories.md) | The tasks the proposal is designed around                                              |
| `assets/tokens.css`                  | The design tokens, as `--ds-*` custom properties                                       |
| `assets/components.css`              | Every component, as `ds-*` classes that read only the tokens                           |
| `assets/ds.js`                       | Template functions that produce each component's markup, mock data and the chart       |
| `assets/gallery.css`                 | Layout of these documentation pages only (`g-*` classes)                               |

Mockups labelled **Now** recreate the current interface from the code for comparison. Mockups labelled **Proposed** are the redesign. **UI only** marks work that needs no server change; **Needs API** marks work that does.

## How it is organised

- **Tokens** are the only source of colour, type, space, size, radius and shadow. Components never use a literal value.
- **Components** are plain CSS classes. The markup for each is produced by one function in `assets/ds.js`, for example `DS.table(columns, rows)`, `DS.card(item)`, `DS.status('waiting', 'Waiting until 14:20')` and `DS.chartBox('album')`. Those functions are documentation, not application code; they show the structure a React component should render.
- **Screens** call the same functions and add no styles of their own. If a screen needs something new, it becomes a component first.
- **The chart** is drawn by `drawChart` in `assets/ds.js`. Its bucketing rule (`bucket`) and smoothing (`smooth`) are written to be lifted into the app as they are.

## Porting to the app

The suggested order is on the [overview page](index.html#order). In short:

1. Add `assets/tokens.css` to `packages/ui/src/globals.css` and point the existing variables and the most-used literals at the new tokens.
2. Build each component in `packages/ui` from its section of `assets/components.css`, replacing the classes listed under "Replaces" on its page.
3. Move one screen at a time onto the shared components, starting with the table, then the play control, card and list row.

Each step should remove the styles it replaces, so `globals.css` shrinks as the work proceeds.

## Rules for changing this library

- All names, titles, counts and dates are invented. Do not paste real library contents, measured counts, screenshots of a real library, private plugin names or machine paths into these files.
- Interface copy is functional: no slogans, taglines or decorative headings.
- No green in any colour role.
- A new value needs a new token, and a new token needs a reason on the Foundations page.
- Keep Play immediately followed by Queue wherever music can be played.
- Every table uses the one table component.
