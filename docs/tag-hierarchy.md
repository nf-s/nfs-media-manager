# Tag hierarchy

A tag can have parent tags. A filter on a tag also matches every visible tag beneath it, so a filter on `Rock` finds albums tagged only `shoegaze` when `shoegaze` sits under `indie rock` and `indie rock` under `Rock`. Albums and films each have their own hierarchy; a link never crosses libraries. The Tags filter in [Mixes](mixes.md#tags) reads the album hierarchy without changing it.

## Using it

**Tags** opens on **Hierarchy** (`/tags`), with **All** at `/tags/all` and **Hidden** at `/tags/hidden`. The earlier `/tags/hierarchy` address redirects to `/tags`.

Hierarchy lists the tags that have a parent or a subtag as a tree. Each row shows the items carrying the tag itself, the items carrying it or any visible tag beneath it, and the number of direct subtags. Rows start collapsed. Search lists matching tags with the tags above them. A tag with several parents is listed under each. **New tag** creates a tag with no items, used to group other tags, optionally under a parent.

Parents are edited in three places:

- A tag's details list its **Parent tags** and **Subtags**. Each can be removed, and a search adds another.
- In **Tags → All**, select tags and choose **Parent tags**. **Add parent** keeps existing parents, **Move under** replaces them, and **Remove all parents** makes the tags top-level.
- The **Outside the hierarchy** choice in **Tags → All** lists visible tags with neither a parent nor a subtag. The Hierarchy page links to it with their count.

The All table has a Parents column and an optional Subtags column.

In Browse, a tag suggestion that has subtags shows both numbers, for example `1,204 · 38 subtags`. The first is the number of items the filter matches. Required and Exclude apply to the tag with its subtags as one group.

## Names

Album and film tag names are shown in title case whatever case their source used: `Indie Rock`, `Based on Novel or Book`, `UK Garage`, `Synth-Pop`. `formatTagName` in `@repo/schemas/tags` writes every one of them, including filter pills and Browse suggestions. A minor word such as `of` or `the` stays in lower case inside a name, and a fixed list keeps abbreviations such as `UK`, `DJ` and `LGBTQ` in capitals. Stored names, filter values, merged names and the original names in Sources are not changed. Subscription tags are free text and are shown as stored.

## Rules

- A tag may have several parents. A tag cannot be its own parent or sit beneath one of its own subtags; such a change is rejected with HTTP 409.
- Hidden tags stay hidden. A hidden subtag is left out of its parents' filters and counts. A filter that names a hidden tag still matches that tag, as before.
- Merging tags moves the parents and subtags of the merged names to the kept name. A link that would make a loop is dropped.
- On an album or track with fewer visible album tags than the artist tag fallback needs, artist tags count toward a parent the same way.
- Links are stored by normalized tag name within a library, so every spelling grouped under one tag shares them and later imports keep them.
- Tags are not renamed or deleted here. A grouping tag that is no longer wanted can be hidden.

## API

All routes require authentication and work within `mediaType=album|film`.

| Route                                        | Purpose                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/tags/hierarchy?mediaType=album` | `{ mediaType, nodes: [{ id, name, hidden, mediaCount, totalCount, parentIds }], unplacedCount }` for every tag with a parent or a subtag.     |
| `POST /api/v1/tags/parents`                  | `{ mediaType, tagIds, parentIds, mode }` with `mode` `add`, `replace` or `remove`; 1 to 100 tags and up to 20 parents. Returns `{ updated }`. |
| `POST /api/v1/tags`                          | `{ mediaType, name, parentIds? }` creates a grouping tag. HTTP 409 when the name exists in that library.                                      |
| `GET /api/v1/tags`                           | Rows carry `parents` and `childCount`. `placement=unplaced` lists tags with neither.                                                          |
| `GET /api/v1/tags/{id}`                      | Carries `children`, the direct subtags.                                                                                                       |

Filter suggestions for tag fields carry `subtags` when a tag has visible subtags.

## Data

Migration `0037_tag_hierarchy.sql` adds `tag_parent` (one row per link, keyed by library and normalized names), `tag_ancestor` (every tag with each tag above it, rebuilt whenever a link changes) and an index on the normalized tag name. Filters and suggestion counts read `tag_ancestor`; nothing is copied onto media items, so hiding a tag or moving a link takes effect at once.
