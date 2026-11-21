function startChecklist(browser) {
  'use strict'

  const document = browser.document
  const byId = (id) => document.getElementById(id)
  const data = JSON.parse(byId('checklist').textContent)
  const storageKey = 'spotify-review:' + data.key
  const pageSize = 50
  const assessments = {
    likely: 'Likely match',
    review: 'Needs review',
    unlikely: 'Unlikely match',
  }
  const empty = '–'
  const numberFormat = new Intl.NumberFormat('en')
  const collator = new Intl.Collator('en', { sensitivity: 'base' })
  const filter = byId('filter')
  const search = byId('search')
  const list = byId('tracks')
  const shown = byId('shown')
  const previous = byId('previous')
  const next = byId('next')
  const copy = byId('copy')
  const copyStatus = byId('copy-status')
  const copyFallback = byId('copy-fallback')
  const copyText = byId('copy-text')
  const tracks = new Map(data.tracks.map((track) => [track.id, track]))
  const selected = new Map(
    data.tracks.map((track) => [track.id, track.initialId]),
  )
  const previewed = new Map()
  const overrides = new Map()
  let page = 0

  try {
    const saved = JSON.parse(browser.localStorage.getItem(storageKey) || '[]')
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (!Array.isArray(entry) || entry.length !== 2) continue
        const [id, candidateId] = entry
        const track = tracks.get(id)
        if (
          track &&
          (candidateId === null ||
            track.candidates.some(({ id }) => id === candidateId))
        ) {
          selected.set(id, candidateId)
          overrides.set(id, candidateId)
        }
      }
    }
  } catch {
    // The page remains usable when a browser forbids storage for local files.
  }

  // Keep the review order stable while the user works through the page.
  const priority = { review: 0, likely: 1, unlikely: 2 }
  const ordered = [...data.tracks].sort(
    (a, b) =>
      Number(selected.get(a.id) !== null) -
        Number(selected.get(b.id) !== null) ||
      priority[a.assessment] - priority[b.assessment] ||
      collator.compare(a.title, b.title) ||
      collator.compare(a.artists, b.artists),
  )
  const searchText = new Map(
    ordered.map((track) => [
      track.id,
      [
        track.title,
        track.artists,
        track.albums,
        ...track.candidates.flatMap(({ title, artists, albums }) => [
          title,
          artists,
          albums,
        ]),
      ]
        .join(' ')
        .toLowerCase(),
    ]),
  )

  function element(tag, className, text) {
    const item = document.createElement(tag)
    if (className) item.className = className
    if (text !== undefined) item.textContent = text
    return item
  }

  function keyValues(values) {
    const group = element('dl', 'ds-kv')
    for (const [key, value] of values) {
      group.append(element('dt', '', key), element('dd', '', value || empty))
    }
    return group
  }

  function recording(kind, item) {
    const section = element('section', 'ds-section')
    section.dataset.flush = ''
    const heading = element('div', 'ds-section-head')
    heading.append(element('h3', '', kind))
    section.append(
      heading,
      keyValues([
        ['Title', item.title],
        ['Artists', item.artists],
        ['Album', item.albums],
        ['Duration', item.duration],
      ]),
    )
    return section
  }

  function comparison(track, candidate) {
    const section = element('div', 'review-comparison')
    section.append(
      recording('Library recording', track),
      recording('Spotify recording', candidate),
    )
    return section
  }

  function evidence(candidate, expanded) {
    const section = element('details')
    section.open = expanded
    section.append(element('summary', '', 'Match evidence'))
    const date = candidate.historical ? 'Earlier search' : 'Saved search'
    section.append(
      element(
        'p',
        'ds-help',
        assessments[candidate.assessment] +
          ' · ' +
          date +
          ' · ' +
          candidate.date,
      ),
    )
    if (candidate.summary) section.append(element('p', '', candidate.summary))
    for (const reason of candidate.reasons) {
      const explanation = element('p')
      explanation.append(element('strong', '', reason.explanation))
      section.append(
        explanation,
        keyValues([
          ['Library', reason.library],
          ['Spotify', reason.spotify],
        ]),
      )
    }
    return section
  }

  function updateSelection(track, candidateId) {
    selected.set(track.id, candidateId)
    if (track.initialId === candidateId) overrides.delete(track.id)
    else overrides.set(track.id, candidateId)
    try {
      browser.localStorage.setItem(storageKey, JSON.stringify([...overrides]))
    } catch {
      // Leave the in-memory selection available for copying.
    }
    copyStatus.textContent = ''
    copyFallback.hidden = true
    renderSelection()
  }

  function renderTrack(track, index) {
    const article = element('article', 'ds-section review-track')
    const headingId = 'track-heading-' + index
    article.setAttribute('aria-labelledby', headingId)
    const header = element('div', 'ds-section-head')
    const heading = element('h3', '', track.title)
    heading.id = headingId
    const status = element('span', 'ds-status', assessments[track.assessment])
    status.dataset.status =
      track.assessment === 'review' ? 'attention' : 'never'
    header.append(heading, status)

    const controls = element('div', 'review-controls')
    const label = element('label', 'ds-field')
    const chooser = element('select', 'ds-select')
    for (const candidate of track.candidates) {
      const option = element(
        'option',
        '',
        [candidate.title, candidate.artists, candidate.albums].join(' · '),
      )
      option.value = candidate.id
      chooser.append(option)
    }
    chooser.value =
      selected.get(track.id) ??
      previewed.get(track.id) ??
      track.candidates[0].id
    label.append(element('span', 'ds-label', 'Spotify candidate'), chooser)

    const includeLabel = element('label', 'ds-checkrow')
    const include = element('input', 'ds-check')
    include.type = 'checkbox'
    include.checked = selected.get(track.id) !== null
    includeLabel.append(include, element('span', '', 'Include this match'))
    controls.append(label, includeLabel)

    const details = element('div')
    const showCandidate = () => {
      const candidate =
        track.candidates.find(({ id }) => id === chooser.value) ??
        track.candidates[0]
      const expanded = details.querySelector('details')?.open ?? false
      details.replaceChildren(comparison(track, candidate))
      if (candidate.query) {
        const query = element('p', 'ds-help')
        query.append(element('strong', '', 'Saved query'), ' ', candidate.query)
        details.append(query)
      }
      details.append(evidence(candidate, expanded))
    }
    chooser.addEventListener('change', () => {
      previewed.set(track.id, chooser.value)
      if (include.checked) updateSelection(track, chooser.value)
      showCandidate()
    })
    include.addEventListener('change', () => {
      previewed.set(track.id, chooser.value)
      updateSelection(track, include.checked ? chooser.value : null)
      if (filter.value === 'unchecked' || filter.value === 'selected') {
        const controls = [...list.querySelectorAll('input[type="checkbox"]')]
        const position = controls.indexOf(include)
        renderTracks()
        const remaining = [...list.querySelectorAll('input[type="checkbox"]')]
        const focused = remaining[position] ?? remaining.at(-1) ?? filter
        focused.focus()
      }
    })
    showCandidate()
    article.append(header, controls, details)
    return article
  }

  function isVisible(track) {
    const hasSelection = selected.get(track.id) !== null
    const mode = filter.value
    return (
      (mode !== 'unchecked' || !hasSelection) &&
      (mode !== 'selected' || hasSelection) &&
      (mode !== 'review' || track.assessment === 'review') &&
      searchText.get(track.id).includes(search.value.trim().toLowerCase())
    )
  }

  function renderTracks() {
    const matching = ordered.filter(isVisible)
    const lastPage = Math.max(0, Math.ceil(matching.length / pageSize) - 1)
    page = Math.min(page, lastPage)
    const start = page * pageSize
    const end = Math.min(start + pageSize, matching.length)
    const count = numberFormat.format(matching.length)
    const total = numberFormat.format(ordered.length)
    shown.textContent = matching.length
      ? numberFormat.format(start + 1) +
        '–' +
        numberFormat.format(end) +
        ' of ' +
        count +
        ' tracks' +
        (matching.length === ordered.length ? '' : ' · ' + total + ' total')
      : '0 tracks · ' + total + ' total'
    previous.disabled = page === 0
    next.disabled = page === lastPage
    byId('pages').hidden = lastPage === 0
    list.replaceChildren(...matching.slice(start, end).map(renderTrack))
    if (!matching.length) {
      list.append(
        element(
          'p',
          'review-track ds-muted',
          ordered.length
            ? 'No tracks match these filters.'
            : 'No tracks to review.',
        ),
      )
    }
  }

  function selectedLines() {
    return data.tracks.flatMap(({ id }) => {
      const candidateId = selected.get(id)
      return candidateId ? [id + '\t' + candidateId] : []
    })
  }

  function renderSelection() {
    const lines = selectedLines()
    byId('selected').textContent =
      numberFormat.format(lines.length) +
      ' of ' +
      numberFormat.format(tracks.size) +
      ' tracks selected'
    copy.disabled = lines.length === 0
  }

  function resetPage() {
    page = 0
    renderTracks()
    document.querySelector('.review-main').scrollTop = 0
  }

  function changePage(offset) {
    page += offset
    renderTracks()
    document.querySelector('.review-main').scrollTop = 0
  }

  search.addEventListener('input', resetPage)
  filter.addEventListener('change', resetPage)
  previous.addEventListener('click', () => changePage(-1))
  next.addEventListener('click', () => changePage(1))
  copy.addEventListener('click', async () => {
    const lines = selectedLines()
    const text = lines.join('\n')
    const success =
      'Copied ' +
      numberFormat.format(lines.length) +
      (lines.length === 1 ? ' match.' : ' matches.')
    if (!text) return
    try {
      await browser.navigator.clipboard.writeText(text)
      copyFallback.hidden = true
      copyStatus.textContent = success
      return
    } catch {
      copyText.value = text
      copyFallback.hidden = false
      copyText.focus()
      copyText.select()
      try {
        if (document.execCommand('copy')) {
          copyFallback.hidden = true
          copyStatus.textContent = success
          copy.focus()
          return
        }
      } catch {
        // Keep the text selected so the user can copy it manually.
      }
      copyStatus.textContent = 'Copy the selected text below.'
    }
  })

  renderTracks()
  renderSelection()
}

// The generated page embeds this file as a classic browser script.
startChecklist(this)
