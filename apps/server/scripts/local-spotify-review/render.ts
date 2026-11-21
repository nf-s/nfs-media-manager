import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  SpotifyTrackAuditItemSchema,
  type SpotifyTrackAuditItem,
} from '@repo/schemas/spotify-track-search'
import {
  EMPTY_VALUE,
  formatDate,
  formatTrackLength,
} from '../../../../packages/ui/src/lib/format'

const design = new URL(
  '../../../../packages/ui/src/design-system/',
  import.meta.url,
)

function safeJson(value: unknown) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

function formatDurations(durations: readonly number[]) {
  return (
    durations.map((value) => formatTrackLength(value * 1000)).join(', ') ||
    EMPTY_VALUE
  )
}

/** Render a local checklist with embedded data, design styles and controls. */
export async function renderSpotifyReview(
  items: readonly SpotifyTrackAuditItem[],
): Promise<string> {
  const tracks = SpotifyTrackAuditItemSchema.array()
    .parse(items)
    .map((item) => ({
      id: item.trackId,
      title: item.title,
      artists: item.artists.join(', ') || EMPTY_VALUE,
      albums: item.albums.join(', ') || EMPTY_VALUE,
      duration: formatDurations(item.durations),
      assessment: item.assessment,
      initialId:
        item.assessment === 'likely'
          ? (item.candidates.find(({ assessment }) => assessment === 'likely')
              ?.spotifyTrackId ?? null)
          : null,
      candidates: item.candidates.map((candidate) => ({
        id: candidate.spotifyTrackId,
        title: candidate.title,
        artists: candidate.artists.join(', ') || EMPTY_VALUE,
        albums: candidate.albumName || EMPTY_VALUE,
        duration: formatDurations([candidate.durationSec]),
        summary: candidate.summary,
        query: candidate.query,
        reasons: candidate.reasons,
        assessment: candidate.assessment,
        date: formatDate(candidate.searchedAt),
        historical: candidate.historical,
      })),
    }))
  if (tracks.some(({ id }) => /[\t\r\n]/.test(id)))
    throw new Error(
      'A library track ID cannot be represented in the checklist.',
    )
  if (new Set(tracks.map(({ id }) => id)).size !== tracks.length)
    throw new Error('The checklist contains duplicate library track IDs.')

  const stableChoices = tracks.map(({ id, initialId, candidates }) => [
    id,
    initialId,
    candidates.map((candidate) => candidate.id),
  ])
  const key = createHash('sha256')
    .update(JSON.stringify(stableChoices))
    .digest('hex')
  const [tokens, components, layout, script] = await Promise.all([
    readFile(new URL('tokens.css', design), 'utf8'),
    readFile(new URL('components.css', design), 'utf8'),
    readFile(new URL('layout.css', import.meta.url), 'utf8'),
    readFile(new URL('review.js', import.meta.url), 'utf8'),
  ])
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>Spotify match checklist</title>
  <style>${tokens}\n${components}\n${layout}</style>
</head>
<body>
  <header class="ds-page review-header">
    <div class="ds-pagehead">
      <h1>Spotify match checklist</h1>
      <p>Likely matches are preselected. Review the selections, then copy the IDs to share your choices.</p>
    </div>
    <div class="ds-toolbar">
      <label class="ds-search">
        <input id="search" aria-label="Search tracks" type="search" placeholder="Search tracks, artists or albums">
      </label>
      <label class="review-label">
        <span class="ds-label">Show</span>
        <select id="filter" class="ds-select" aria-label="Show tracks">
          <option value="all">All tracks</option>
          <option value="unchecked">Unchecked</option>
          <option value="review">Needs review</option>
          <option value="selected">Selected</option>
        </select>
      </label>
    </div>
  </header>
  <main class="review-main">
    <div class="ds-page review-page">
      <div class="ds-toolbar">
        <span id="shown" class="ds-toolbar-count" aria-live="polite"></span>
        <nav id="pages" class="ds-actions" aria-label="Checklist pages">
          <button id="previous" type="button" class="ds-btn" data-size="xs">Previous</button>
          <button id="next" type="button" class="ds-btn" data-size="xs">Next</button>
        </nav>
      </div>
      <div id="tracks"></div>
      <noscript><p>Enable JavaScript to review and copy the saved matches.</p></noscript>
    </div>
  </main>
  <footer class="review-footer">
    <div class="ds-selectbar">
      <span id="selected" aria-live="polite"></span>
      <button id="copy" class="ds-btn" data-variant="primary" data-size="md" type="button" disabled>Copy IDs</button>
      <span id="copy-status" role="status"></span>
    </div>
    <div id="copy-fallback" class="ds-page review-fallback" hidden>
      <label class="ds-field">
        <span class="ds-label">Selected IDs</span>
        <textarea id="copy-text" rows="4" class="ds-input" readonly></textarea>
      </label>
    </div>
  </footer>
  <script id="checklist" type="application/json">${safeJson({ key, tracks })}</script>
  <script>${script}</script>
</body>
</html>`
}
