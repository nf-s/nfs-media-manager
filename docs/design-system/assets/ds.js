/*
 * Media Manager design library.
 * Icons, mock data and one template function per component. Each function
 * returns the markup contract for that component; a React port should emit the
 * same structure and class names. All names and numbers here are invented.
 */
;(function () {
  'use strict'

  const esc = (value) =>
    String(value).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    )
  const attrs = (map) =>
    Object.entries(map)
      .filter(([, v]) => v !== undefined && v !== null && v !== false)
      .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
      .join('')
  const r1 = (n) => Math.round(n * 10) / 10

  /* Icons: 24px grid, 1.75 stroke, the same drawing style as lucide-react */

  const BOOK =
    '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>'
  const ICON = {
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    pause:
      '<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>',
    prev: '<path d="M19 5.5v13L9.5 12z"/><rect x="5" y="5.5" width="2.5" height="13" rx="1"/>',
    next: '<path d="M5 5.5v13l9.5-6.5z"/><rect x="16.5" y="5.5" width="2.5" height="13" rx="1"/>',
    queue: '<path d="M4 6h11M4 12h11M4 18h7M18 15v6M15 18h6"/>',
    library: '<path d="M4 19.5v-15m4 15v-15m4 15v-15m4-1 4 15"/>',
    bookPlus: `${BOOK}<path d="M12 7v6M9 10h6"/>`,
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    sparkles:
      '<path d="m11 4 1.8 4.7 4.7 1.8-4.7 1.8L11 17l-1.8-4.7-4.7-1.8 4.7-1.8z"/><path d="M18.5 15.5v4M16.5 17.5h4"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    filter:
      '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.5"/><circle cx="8" cy="17" r="2.5"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    table:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 10h17M3.5 15h17M10 4.5v15"/>',
    columns:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15M14.5 4.5v15"/>',
    more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    chevR: '<path d="m9 6 6 6-6 6"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    chevL: '<path d="m15 6-6 6 6 6"/>',
    external: '<path d="M8 16 16.5 7.5M9.5 7.5h7v7"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
    refresh:
      '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
    pencil: '<path d="m4 20 1-4L16.5 4.5l3 3L8 19z"/>',
    history:
      '<path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5M4 4v4.5h4.5M12 8v4.5l3 1.5"/>',
    music:
      '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    disc: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/>',
    film: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5"/>',
    tv: '<rect x="3.5" y="5" width="17" height="11.5" rx="2"/><path d="M8.5 20h7"/>',
    listMusic:
      '<path d="M4 6h12M4 11h8M4 16h6M17 17V8l3-1"/><circle cx="15" cy="17" r="2"/>',
    tag: '<path d="M4 4h7.5L20 12.5 12.5 20 4 11.5z"/><path d="M8 8h.01"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
    speaker:
      '<rect x="6" y="3.5" width="12" height="17" rx="2"/><circle cx="12" cy="14" r="3"/><path d="M12 7.5h.01"/>',
    shuffle:
      '<path d="M4 7h3l10 10h3M17.5 14.5 20 17l-2.5 2.5M4 17h3l2.5-2.5M14.5 9.5 17 7h3M17.5 4.5 20 7l-2.5 2.5"/>',
    repeat:
      '<path d="m17 3.5 3 3-3 3M4 11V9.5a3 3 0 0 1 3-3h13M7 20.5l-3-3 3-3M20 13v1.5a3 3 0 0 1-3 3H4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M13.5 9.5l2 2"/>',
    activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    layers:
      '<path d="M12 4 3.5 8.5 12 13l8.5-4.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>',
    download: '<path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14"/>',
    stop: '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.5"/>',
    globe:
      '<path d="M21.54 15H17a2 2 0 0 0-2 2v4.54"/><path d="M7 3.34V5a3 3 0 0 0 3 3 2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"/><path d="M11 21.95V18a2 2 0 0 0-2-2 2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"/><circle cx="12" cy="12" r="10"/>',
  }
  const FILLED = new Set(['play', 'pause', 'prev', 'next'])

  function icon(name, o = {}) {
    return `<svg class="ds-i"${attrs({ 'data-size': o.size, 'data-fill': FILLED.has(name) })} viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`
  }

  /* Mock artwork: flat shapes from a fixed set of palettes */

  const PALETTES = [
    ['#1f2a44', '#e7b05a', '#c9d2e3'],
    ['#b5533c', '#f1d9c0', '#3a2a2a'],
    ['#d8a7a0', '#6b3a48', '#f4e6df'],
    ['#d9a441', '#3b3a52', '#f6ead0'],
    ['#4b2e4f', '#e59a8a', '#c7b6d6'],
    ['#e6dccb', '#b5533c', '#33415c'],
    ['#5b7499', '#f0e4d0', '#22304a'],
    ['#23262e', '#d86f4c', '#8ea3c2'],
    ['#b9b0d6', '#3f3560', '#f2c078'],
    ['#8c2f39', '#f0c9a8', '#2d2a3e'],
    ['#a9c4e2', '#2b3f66', '#f3efe6'],
    ['#3a3326', '#e1b34f', '#b9c0cc'],
  ]

  function art(seed) {
    const [bg, a, b] = PALETTES[seed % PALETTES.length]
    const shapes = [
      `<circle cx="62" cy="58" r="34" fill="${a}"/><circle cx="30" cy="28" r="12" fill="${b}"/>`,
      `<rect y="46" width="100" height="18" fill="${a}"/><rect y="70" width="100" height="8" fill="${b}"/>`,
      `<circle cx="0" cy="100" r="72" fill="${a}"/><circle cx="0" cy="100" r="40" fill="${b}"/>`,
      `<path d="M0 100 100 0v100z" fill="${a}"/><circle cx="34" cy="34" r="14" fill="${b}"/>`,
      `<circle cx="50" cy="50" r="32" fill="none" stroke="${a}" stroke-width="9"/><circle cx="50" cy="50" r="12" fill="${b}"/>`,
    ]
    return `<svg class="ds-artimg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="100" height="100" fill="${bg}"/>${shapes[(seed * 7 + 3) % shapes.length]}</svg>`
  }

  const KIND_ICON = {
    album: 'disc',
    track: 'music',
    artist: 'user',
    film: 'film',
    video: 'tv',
    playlist: 'listMusic',
  }
  const KIND_RATIO = {
    film: 'poster',
    video: 'video',
    artist: 'round',
    person: 'round',
  }

  function artBox(item, o = {}) {
    const ratio = o.ratio || KIND_RATIO[item.kind]
    const inner =
      item.art === null
        ? `<span class="ds-art-fallback">${icon(o.icon || KIND_ICON[item.kind] || 'disc')}</span>`
        : art(item.seed)
    return `<span class="ds-art"${attrs({ 'data-ratio': ratio, 'data-size': o.size })}>${inner}${o.badge ? `<span class="ds-art-badge">${esc(o.badge)}</span>` : ''}${o.play ? play('tile', { playing: o.playing }) : ''}</span>`
  }

  function thumb(item, o = {}) {
    const ratio = o.ratio || KIND_RATIO[item.kind]
    return `<span class="ds-thumb"${attrs({ 'data-ratio': ratio, style: o.size ? `--ds-thumb:${o.size}px` : undefined })}>${item.art === null ? icon(KIND_ICON[item.kind] || 'disc') : art(item.seed)}</span>`
  }

  /* Controls */

  function btn(label, o = {}) {
    const inner = `${o.icon ? icon(o.icon, { size: 'sm' }) : ''}${label ? esc(label) : ''}${o.end ? icon(o.end, { size: 'sm' }) : ''}`
    return `<button type="button" class="ds-btn"${attrs({
      'data-variant': o.variant,
      'data-feedback': o.feedback,
      'data-size': o.size,
      'data-icon': !label && Boolean(o.icon),
      'aria-label': o.aria,
      'aria-pressed': o.pressed ? 'true' : undefined,
      disabled: o.disabled,
      title: o.title,
    })}>${inner}</button>`
  }

  function libraryAction(kind, name, o = {}) {
    if (o.saved && !o.added) return ''
    if (o.pending || o.added)
      return btn(o.pending ? 'Adding…' : 'Added', {
        icon: o.pending ? 'clock' : 'check',
        aria: `${o.pending ? 'Adding' : 'Added'} ${kind} · ${name}`,
        size: 'xs',
        variant: 'ghost',
        feedback: o.pending ? 'pending' : 'done',
        disabled: true,
      })
    const label =
      o.action === 'find'
        ? `Find ${kind} in library · ${name}`
        : `Add ${kind} to library · ${name}`
    return `<button type="button" class="ds-btn ds-library-action" data-variant="ghost" data-size="xs"${attrs(
      {
        'data-touch': o.touch,
        'aria-label': label,
        'aria-disabled': o.pending || o.disabled ? 'true' : undefined,
        'aria-busy': o.pending ? 'true' : undefined,
        title: label,
      },
    )}>${icon(o.action === 'find' ? 'search' : 'bookPlus')}<span>${o.action === 'find' ? (o.short ? 'Find' : 'Find in library') : o.short ? 'Add' : 'Add to Library'}</span></button>`
  }

  /* The header pair goes under the artwork (detailHead's o.play): a labelled
     Play that takes the artwork's width and a square Queue button. */
  function play(place = 'row', o = {}) {
    if (place === 'header') {
      return `${btn('Play', { icon: 'play', variant: 'primary', size: 'md' })}${btn('', { icon: 'queue', size: 'md', aria: 'Add to queue', title: 'Add to queue' })}`
    }
    const controls = attrs({ disabled: o.disabled })
    const link = o.provider
      ? `<a href="#" aria-label="Open on ${esc(PROVIDERS[o.provider].name)} (opens in a new tab)" target="_blank" rel="noopener noreferrer">${mark(o.provider, { size: 'sm', hidden: true })}</a>`
      : ''
    return `<span class="ds-play" data-place="${place}"><button type="button" aria-label="${o.playing ? 'Pause' : 'Play'}"${controls}>${icon(o.playing ? 'pause' : 'play', { size: 'sm' })}</button><button type="button" aria-label="Add to queue"${controls}>${icon('queue', { size: 'sm' })}</button>${link}</span>`
  }

  function pill(label, o = {}) {
    const tagName = o.static ? 'span' : 'a'
    return `<${tagName} class="ds-pill"${attrs({ href: o.static ? undefined : '#', 'data-mode': o.mode, 'data-tone': o.tone, 'data-size': o.size })}>${o.icon ? icon(o.icon) : ''}<span class="ds-pill-label">${esc(label)}</span>${o.remove ? icon('x') : ''}${o.sources ? icon('layers') : ''}</${tagName}>`
  }

  /* Tag names show in title case, as the app's formatTagName writes them */
  const TAG_MINOR = new Set(['a', 'an', 'and', 'of', 'on', 'or', 'the', 'to'])
  const tagLabel = (name) =>
    name
      .split(' ')
      .map((word, i, words) =>
        i > 0 && i < words.length - 1 && TAG_MINOR.has(word)
          ? word
          : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join(' ')

  function pills(list, o = {}) {
    const max = o.max || list.length
    const shown = list.slice(0, max).map((label) => pill(label, o.pill))
    const rest = list.length - max
    return `<span class="ds-pills"${attrs({ 'data-wrap': o.wrap })}>${shown.join('')}${rest > 0 ? `<span class="ds-more">+${rest}</span>` : ''}</span>`
  }

  const count = (n, tone) =>
    `<span class="ds-count"${attrs({ 'data-tone': tone })}>${esc(n)}</span>`

  const STATUS = {
    queued: 'Queued',
    running: 'Running',
    waiting: 'Waiting',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
    paused: 'Paused',
    attention: 'Needs attention',
    never: 'Never',
  }
  const status = (state, label) =>
    `<span class="ds-status" data-status="${state}">${esc(label || STATUS[state])}</span>`

  /* Each provider's logo file in the app, from this folder. A provider
     without one shows a globe. */
  const PUBLIC = '../../apps/web/public/'
  const PROVIDERS = {
    spotify: { name: 'Spotify', logo: `${PUBLIC}icons/services/spotify.svg` },
    tidal: { name: 'TIDAL', logo: `${PUBLIC}icons/logos/tidal.svg` },
    lastfm: { name: 'Last.fm', logo: `${PUBLIC}icons/logos/lastfm.png` },
    discogs: { name: 'Discogs', logo: `${PUBLIC}icons/ratings/discogs.png` },
    musicbrainz: { name: 'MusicBrainz', logo: `${PUBLIC}img/mb.png` },
    rym: {
      name: 'Rate Your Music',
      short: 'RYM',
      logo: `${PUBLIC}icons/logos/rym.png`,
    },
    tmdb: { name: 'TMDb', logo: `${PUBLIC}icons/ratings/tmdb.svg` },
    omdb: { name: 'OMDb' },
    mdblist: { name: 'MDBList' },
    youtube: { name: 'YouTube', logo: `${PUBLIC}icons/logos/youtube.svg` },
    sonos: { name: 'Sonos' },
    imdb: { name: 'IMDb', logo: `${PUBLIC}icons/ratings/imdb.svg` },
    letterboxd: {
      name: 'Letterboxd',
      logo: `${PUBLIC}icons/logos/letterboxd.svg`,
    },
    trakt: { name: 'Trakt', logo: `${PUBLIC}icons/ratings/trakt.svg` },
    metacritic: {
      name: 'Metacritic',
      logo: `${PUBLIC}icons/ratings/metacritic.svg`,
    },
    rottentomatoes: {
      name: 'Rotten Tomatoes',
      logo: `${PUBLIC}icons/ratings/rottentomatoes.svg`,
    },
  }
  /* Provider logo: the logo file's shape in the muted ink, so every logo is
     the same grey, or a globe. o.hidden inside a link or beside the
     provider's name, which already name it; o.size 'sm' is 14px. A relative
     url() in a custom property resolves against the stylesheet that uses
     it, so the file's path is made absolute here, as the app's paths are. */
  function mark(id, o = {}) {
    const p = PROVIDERS[id]
    const named = o.hidden
      ? { 'aria-hidden': 'true' }
      : { role: 'img', 'aria-label': p.name, title: p.name }
    return p.logo
      ? `<span class="ds-logo"${attrs({ 'data-size': o.size, style: `--ds-logo:url("${new URL(p.logo, document.baseURI).href}")`, ...named })}></span>`
      : `<span class="ds-logo" data-none=""${attrs({ 'data-size': o.size, ...named })}>${icon('globe', { size: 'sm' })}</span>`
  }
  const provider = (id, o = {}) =>
    `<span class="ds-cell-id">${mark(id, { hidden: true })}<a href="#">${(o.short && PROVIDERS[id].short) || PROVIDERS[id].name}</a></span>`
  /* An item's service logos: one link per service, opening the item there
     in a new tab. The logo is decorative; the link names the service. */
  const logoLinks = (ids) =>
    `<span class="service-links" role="group" aria-label="Service links">${ids
      .map((id) => {
        const name = PROVIDERS[id].short || PROVIDERS[id].name
        return `<a href="#" aria-label="Open on ${esc(name)} (opens in a new tab)" title="Open on ${esc(name)} (new tab)">${mark(id, { hidden: true })}</a>`
      })
      .join('')}</span>`

  const EMPTY = '<span class="ds-empty-value">–</span>'
  function rating(source, value, o = {}) {
    if (value === null || value === undefined) return EMPTY
    return `<span class="ds-rating"${attrs({ 'data-sorted': o.sorted })}><i>${esc(source)}</i>${esc(value)}</span>`
  }

  function ratingWeight(label, value) {
    return `<label class="ds-rating-weight">${esc(label)}<input type="range" min="0" max="3" step="0.5" value="${value}" aria-label="${esc(label)}" aria-valuetext="${value}×"><span class="ds-num" aria-hidden="true">${value}×</span></label>`
  }

  function ratingDifference(
    value,
    difference,
    label,
    evidenceId,
    status = 'counted',
  ) {
    const text =
      difference === null
        ? value
        : `${value} (${difference > 0 ? '+' : ''}${difference.toFixed(1)})`
    const direction =
      (status === 'counted' || status === 'trimmed') &&
      difference !== null &&
      Math.abs(difference) >= 20
        ? difference > 0
          ? 'high'
          : 'low'
        : undefined
    const shown =
      status === 'votes' || status === 'outlier'
        ? `<s>${esc(text)}</s>`
        : esc(text)
    return `<button type="button" class="ds-rating-difference"${attrs({ 'aria-label': `${label}, ${text}`, title: `${label}, ${text}`, 'aria-controls': evidenceId, 'data-status': status, 'data-direction': direction })}>${shown}</button>`
  }

  function ratingPosition(values, score) {
    if (score === null) return ''
    const label = `Source ratings ${values.map((value) => value.toFixed(1)).join(', ')}. Combined score ${score.toFixed(1)} out of 100.`
    return `<span class="ds-rating-position" role="img"${attrs({ 'aria-label': label, title: label })}>${values.map((value) => `<i data-observation="counted" style="left:${value}%"></i>`).join('')}<i data-score style="left:${score}%"></i></span>`
  }

  function tabs(items, selected = 0) {
    return `<div class="ds-tabs" role="tablist">${items
      .map((item, i) => {
        const [label, n] = Array.isArray(item) ? item : [item]
        return `<button type="button" class="ds-tab" role="tab" aria-selected="${i === selected}">${esc(label)}${n !== undefined ? count(n) : ''}</button>`
      })
      .join('')}</div>`
  }

  function workspaceTabs(items, selected = 0) {
    return `<div class="ds-workspace-tabs"><div class="ds-workspace-tab-list" role="tablist" aria-label="Workspace tabs">${items
      .map(({ label, glyph }, index) => {
        const closeLabel = `Close ${label} tab`
        const active = index === selected
        const tabIndex = active ? 0 : -1
        return `<span class="ds-workspace-tab" role="presentation">
          <button type="button" class="ds-btn" data-variant="ghost" role="tab" aria-selected="${active}" aria-keyshortcuts="Delete" tabindex="${tabIndex}" title="${esc(label)}"><span class="ds-workspace-tab-icon" aria-hidden="true">${icon(glyph)}</span><span class="ds-truncate">${esc(label)}</span></button>
          <button type="button" class="ds-btn" data-variant="ghost" data-size="xs" data-icon data-close tabindex="${tabIndex}" aria-label="${esc(closeLabel)}" title="${esc(closeLabel)}">${icon('x', { size: 'sm' })}</button>
        </span>`
      })
      .join(
        '',
      )}</div><button type="button" class="ds-btn" data-variant="ghost" data-icon aria-label="Duplicate current tab" title="Duplicate current tab">${icon('plus')}</button></div>`
  }

  function seg(items, selected = 0, o = {}) {
    return `<div class="ds-seg" role="group"${attrs({ 'aria-label': o.label, 'data-toggle': true })}>${items
      .map((item, i) => {
        const isIcon = typeof item === 'object'
        return `<button type="button"${attrs({ 'aria-pressed': String(i === selected), 'data-icon': isIcon, 'aria-label': isIcon ? item.label : undefined, 'data-value': isIcon ? item.label : item })}>${isIcon ? icon(item.icon, { size: 'sm' }) : esc(item)}</button>`
      })
      .join('')}</div>`
  }

  const VIEWS = [
    { icon: 'grid', label: 'Grid' },
    { icon: 'list', label: 'List' },
    { icon: 'table', label: 'Table' },
  ]

  function search(placeholder, o = {}) {
    return `<label class="ds-search"${attrs({ style: o.width ? `flex:none;width:${o.width}px` : undefined })}>${icon('search', { size: 'sm' })}<input type="search" placeholder="${esc(placeholder)}"${attrs({ value: o.value })} />${o.ai ? btn('', { icon: 'sparkles', size: 'xs', variant: 'ghost', aria: 'AI search' }) : ''}</label>`
  }

  const select = (options, o = {}) =>
    `<select class="ds-select"${attrs({ 'aria-label': o.label, 'data-size': o.size })}>${[]
      .concat(options)
      .map((x) => `<option>${esc(x)}</option>`)
      .join('')}</select>`

  /* Sort picker: the select's box at a fixed width; a long name is cut short
     and shown in full on hover. It opens the field list. */
  const sortPick = (label) =>
    `<button type="button" class="ds-select ds-sort" aria-haspopup="listbox" aria-expanded="false" aria-label="Sort by: ${esc(label)}" title="${esc(label)}">${esc(label)}</button>`

  /* The open field list. fields: [label, chosen]; o.query is the typed text,
     o.active the row the keyboard is on. The app shows it as a top-layer
     popover; these pages draw it in the flow. */
  function sortList(fields, o = {}) {
    const items = fields
      .map(
        ([label, on], i) =>
          `<button type="button" role="option" aria-selected="${Boolean(on)}" class="ds-menu-item"${attrs({ 'data-active': i === o.active })}>${on ? icon('check', { size: 'sm' }) : '<span class="ds-menu-slot"></span>'}${esc(label)}</button>`,
      )
      .join('')
    return `<div class="ds-pop ds-sortpop" style="position:static"><label class="ds-search">${icon('search', { size: 'sm' })}<input type="search" placeholder="Find a field" aria-label="Find a field"${attrs({ value: o.query })} /></label><div class="ds-sortpop-list" role="listbox" aria-label="Sort by">${items || '<p class="ds-sortpop-none">No field matches</p>'}</div></div>`
  }

  /* The one button for filters, columns and grid size. o.short: the icon and
     the number of filters that are on, for lists inside a detail. */
  function filtersBtn(o = {}) {
    const n = o.count || 0
    const name = n
      ? `Filters, columns and grid size, ${n} ${n === 1 ? 'filter' : 'filters'} on`
      : 'Filters, columns and grid size'
    return `<button type="button" class="ds-btn" data-filters="${o.short ? 'short' : 'full'}" aria-haspopup="dialog" aria-expanded="false" aria-label="${name}" title="${name}">${icon('filter', { size: 'sm' })}<span>${n ? `Filters · ${n}` : 'Filters'}</span>${n ? count(n) : ''}</button>`
  }

  /* Under the toolbar of a Browse list inside a detail: the active filters
     and Clear all, then the count and the link to the same result in Browse. */
  function filterLine(o = {}) {
    const active = o.filters && o.filters.length
    return `<div class="ds-filterline">${active ? `${o.filters.map((label) => pill(label, { remove: true })).join('')}${btn('Clear all', { variant: 'link', size: 'xs' })}` : ''}${o.count ? `<span class="ds-toolbar-count">${esc(o.count)}</span>` : ''}${o.link ? btn(o.link, { variant: 'link' }) : ''}</div>`
  }

  /* Browse toolbar. Order: actions, search, sort, direction, view, Filters,
     count. On a list with a view switch, grid size and columns are in the
     Filters drawer, so the button shows whenever there are filters, a Grid
     view or columns. A table without a view switch keeps its Columns button.
     o.short draws the short Filters button; leave out o.count when the count
     is on the filter line. */
  function toolbar(o) {
    const views = o.view !== undefined
    const filters = o.filters !== false || o.view === 0 || (o.columns && views)
    return `<div class="ds-toolbar">${o.actions || ''}${search(o.placeholder, { ai: o.ai !== false, value: o.query })}${
      o.sort
        ? `${sortPick(o.sort[0])}${btn('', { icon: o.dir || 'down', aria: o.dir === 'up' ? 'Sort descending' : 'Sort ascending' })}`
        : ''
    }${o.extra || ''}${views ? seg(VIEWS, o.view, { label: 'View' }) : ''}${
      filters ? filtersBtn({ count: o.filterCount, short: o.short }) : ''
    }${o.columns && !views ? btn('Columns', { icon: 'columns' }) : ''}${o.count != null ? `<span class="ds-toolbar-count">${esc(o.count)}</span>` : ''}</div>`
  }

  /* The Filters drawer. sections: [title, body], in the order View, Columns
     (Table view only), then the filters. */
  const filtersDrawer = (sections) =>
    `<aside class="ds-inspector"><div class="ds-inspector-bar"><div class="ds-crumbs"><b>Filters and view</b></div>${btn('', { icon: 'x', variant: 'ghost', aria: 'Close filters' })}</div><div class="ds-inspector-body">${sections.map(([title, body], i) => section(title, body, { flush: i === 0 })).join('')}</div></aside>`

  const checkRow = (label, on) =>
    `<label class="ds-checkrow"><input type="checkbox" class="ds-check"${on ? ' checked' : ''} /> ${esc(label)}</label>`

  /* Tag location: Auto, then the levels, disabled while Auto is ticked.
     levels: [label, ticked]; o.hint: the line under them. */
  const tagLocation = (levels, o = {}) => {
    const auto = !levels.some(([, on]) => on)
    const box = (label, on, off) =>
      `<label class="ds-checkrow"><input type="checkbox" class="ds-check"${on ? ' checked' : ''}${off ? ' disabled' : ''} /> ${esc(label)}</label>`
    return `<div class="ds-levels" role="group" aria-label="Tag location">${box('Auto: most detailed', auto)}<div class="ds-levels" data-indent>${levels.map(([label, on]) => box(label, on, auto)).join('')}</div>${o.hint ? `<span class="ds-muted">${esc(o.hint)}</span>` : ''}</div>`
  }

  /* Table. cols: { h, c(row, i), end, w, sort, raw, sticky, edge }
     sticky is the column's left offset in px; edge marks the last sticky column. */
  const stick = (c) =>
    c.sticky === undefined
      ? {}
      : {
          'data-sticky': c.edge ? 'edge' : '',
          style: `${c.w ? `width:${c.w}px;` : ''}--ds-sticky-left:${c.sticky}px`,
        }
  function table(cols, rows, o = {}) {
    const head = cols
      .map((c) => {
        const label = c.raw ? c.h : esc(c.h || '')
        const inner =
          c.sort !== undefined
            ? `<button type="button" class="ds-th-sort">${label}${c.sort ? icon(c.sort === 'ascending' ? 'up' : 'down') : ''}</button>`
            : label
        const resizer = c.resize
          ? `<span class="ds-th-resizer" role="separator" aria-orientation="vertical" aria-label="Resize ${esc(c.h || '')}" tabindex="0"></span>`
          : ''
        return `<th${attrs({ 'data-align': c.end ? 'end' : undefined, style: c.w ? `width:${c.w}px` : undefined, 'aria-sort': c.sort || undefined, ...stick(c) })}>${inner}${resizer}</th>`
      })
      .join('')
    const body = rows
      .map((r, i) =>
        r._group || r._groupHtml
          ? `<tr data-group><td colspan="${cols.length}">${r._groupHtml || esc(r._group)}</td></tr>`
          : `<tr${attrs(o.row ? o.row(r, i) : {})}>${cols.map((c) => `<td${attrs({ 'data-align': c.end ? 'end' : undefined, ...stick(c) })}>${c.c(r, i)}</td>`).join('')}</tr>`,
      )
      .join('')
    return `<table class="ds-table${o.cls ? ` ${o.cls}` : ''}"${attrs({ 'data-layout': o.layout, 'data-rows': o.rows })}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  }

  const checkCol = (isChecked, o = {}) => ({
    h: '<input type="checkbox" class="ds-check" aria-label="Select all" />',
    raw: true,
    w: 36,
    sticky: o.sticky ? 0 : undefined,
    c: (r, i) =>
      `<input type="checkbox" class="ds-check" aria-label="Select row"${isChecked && isChecked(r, i) ? ' checked' : ''} />`,
  })

  function idCell(item, o = {}) {
    return `<span class="ds-cell-id">${o.thumb === false ? '' : thumb(item)}<a class="ds-cell-title" href="#">${esc(item.title)}</a>${o.play === false ? '' : play('row', { playing: o.playing })}</span>`
  }

  /* What a record is made of. partToggle: the chevron before the title,
     named for its current state; PART_SLOT: the chevron's space on a row
     with nothing to open; partTitle: a part row's identity cell, a provider's
     mark then the part's title. Part rows are tr[data-part] under the
     record's row. */
  const partToggle = (label, open) =>
    `<button type="button" class="ds-btn ds-part-toggle" data-variant="ghost" data-size="xs" data-icon aria-expanded="${Boolean(open)}" aria-label="${esc(label)}">${icon(open ? 'chevD' : 'chevR', { size: 'sm' })}</button>`
  const PART_SLOT = '<span class="ds-part-slot" aria-hidden="true"></span>'
  const partTitle = (providerId, title) =>
    `<span class="ds-cell-id ds-part-title">${mark(providerId, { hidden: true })}<span class="ds-truncate">${esc(title)}</span></span>`

  /* A group row that carries actions: the buttons (markup), then the
     evidence, cut short. Pass it to table() as a row's _groupHtml. */
  const groupActions = (buttons, evidence) =>
    `<span class="ds-group-actions">${buttons}${evidence ? `<span class="ds-group-evidence" title="${esc(evidence)}">${esc(evidence)}</span>` : ''}</span>`

  /* A toolbar button that switches the list to another view of its rows and
     back: an icon, the label, then how many the view holds (o.count). */
  const toolbarToggle = (label, o = {}) =>
    `<button type="button" class="ds-btn" aria-pressed="${Boolean(o.pressed)}"${attrs(o.iconOnly ? { 'aria-label': label, title: label, 'data-icon': true } : {})}>${o.icon ? icon(o.icon, { size: 'sm' }) : ''}${o.iconOnly ? '' : esc(label)}${o.count === undefined ? '' : count(Number(o.count).toLocaleString('en'))}</button>`

  function card(item, o = {}) {
    const playable =
      item.kind !== 'film' && item.kind !== 'video' && o.play !== false
    return `<article class="ds-card"${attrs({ 'data-state': o.state, 'aria-selected': o.selected ? 'true' : undefined })}>${artBox(item, { play: playable, badge: o.badge, playing: o.state === 'playing' })}<a class="ds-card-title" href="#">${esc(item.title)}</a>${item.by ? `<span class="ds-card-by">${esc(item.by)}</span>` : ''}<span class="ds-card-meta">${(o.meta || []).join('')}</span>${o.tags !== false && item.tags && item.tags.length ? pills(item.tags, { max: 2 }) : ''}</article>`
  }

  function row(item, o = {}) {
    const playable =
      item.kind !== 'film' && item.kind !== 'video' && o.play !== false
    return `<div class="ds-row"${attrs({ 'data-state': o.state, 'aria-selected': o.selected ? 'true' : undefined })}>${thumb(item)}<div class="ds-row-main"><a class="ds-row-title" href="#">${esc(item.title)}</a><span class="ds-row-by">${esc(o.by || item.by || '')}</span></div>${playable ? play('row', { playing: o.state === 'playing' }) : '<span></span>'}<div class="ds-row-tags">${item.tags ? pills(item.tags, { max: o.maxTags || 3 }) : ''}</div><div class="ds-row-meta">${(o.meta || []).join('')}</div></div>`
  }

  /* Similar albums use a compact row. Tracks reuse the track detail header. */
  const SUGGESTION = {
    library: 'In library',
    spotify: 'On Spotify',
    none: 'Not on Spotify',
    unsearched: 'Not looked up on Spotify',
  }
  function suggestion(s, o = {}) {
    const track = s.kind === 'track'
    const linked = s.state === 'library'
    const service = s.state === 'spotify' ? 'Spotify' : 'TIDAL'
    const title = linked
      ? `<a class="ds-row-title" href="#">${esc(s.title)}</a>`
      : `<span class="ds-row-title">${esc(s.title)}</span>`
    const open = linked
      ? ''
      : btn('', {
          icon: 'external',
          size: 'xs',
          variant: 'ghost',
          aria: `Open on ${service} (opens in a new tab)`,
          title: `Open on ${service} (new tab)`,
        })
    const playable = linked || s.state === 'spotify'
    const badges = s.genres?.length
      ? `<span class="ds-pills" data-wrap role="group" aria-label="Genres">${s.genres.map((genre) => pill(genre, { static: true })).join('')}</span>`
      : ''
    const add = libraryAction(s.kind, s.title, { saved: linked })
    if (track) {
      const header = detailHead({
        item: s,
        kind: 'Track',
        linked: s.hasDetail,
        by: s.hasDetail
          ? `by <a href="#">${esc(s.by)}</a>${s.meta ? ` · on <a href="#">${esc(s.meta)}</a>` : ''}`
          : `by ${esc(s.by)}${s.meta ? ` · on ${esc(s.meta)}` : ''}`,
        facts: s.duration ? [s.duration] : [],
        play: play('header', { disabled: !playable }),
        links: logoLinks([...(playable ? ['spotify'] : []), 'lastfm', 'tidal']),
        actions: add,
      })
      const evidence = [
        linked ? '<a href="#">Library match</a>' : '',
        playable ? '' : 'Unavailable',
        badges,
      ].filter(Boolean)
      return `<section class="ds-section">${header}${evidence.length ? `<div class="ds-actions">${evidence.join(' ')} </div>` : ''}</section>`
    }
    const by = esc([SUGGESTION[s.state], s.by, s.meta].join(' · '))
    const controls = playable ? play('row') : '<span></span>'
    return `<div class="ds-row ds-suggestion" data-action${attrs({ 'data-state': o.state })}>${thumb(s)}<div class="ds-row-main">${title}<span class="ds-row-by">${by}</span>${badges}</div>${controls}<div class="ds-row-tags"></div><div class="ds-row-meta"></div><span class="ds-actions">${open}${add}</span></div>`
  }
  /* A list row still loading, in a compact list with a trailing action */
  const skelRow = () =>
    `<div class="ds-row" data-action aria-hidden="true"><span class="ds-thumb ds-skel"></span><div class="ds-row-main ds-skel-lines"><span class="ds-skel" style="width:60%"></span><span class="ds-skel" style="width:38%"></span></div><span></span><span></span></div>`

  const listHead = (labels, o = {}) =>
    `<div class="ds-listhead"><span style="width:${o.thumb || 40}px"></span><span>${labels[0]}</span><span style="width:${o.play === undefined ? 50 : o.play}px"></span><span>${labels[1] || ''}</span><div class="ds-row-meta">${labels.slice(2).join('')}</div></div>`

  /* Facts, stats, sections */

  const facts = (list) =>
    `<dl class="ds-facts">${list.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`
  const kv = (list) =>
    `<dl class="ds-kv">${list.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
  /* o.href makes the whole stat a link to the page the figure comes from. */
  const stat = (value, label, o = {}) => {
    const tag = o.href ? 'a' : 'div'
    return `<${tag} class="ds-stat"${attrs({ 'data-tone': o.tone, href: o.href, title: o.title })}><span class="ds-stat-value">${value}${o.extra || ''}</span><span class="ds-stat-label">${esc(label)}</span></${tag}>`
  }
  const stats = (list) =>
    `<div class="ds-stats">${list.map((s) => stat(...s)).join('')}</div>`

  function section(title, body, o = {}) {
    return `<section class="ds-section"${attrs({ 'data-flush': o.flush })}>${title ? `<div class="ds-section-head"><h3>${esc(title)}</h3>${o.note ? `<span class="ds-muted">${o.note}</span>` : ''}${o.aside ? `<span class="ds-section-aside">${o.aside}</span>` : ''}</div>` : ''}${body}</section>`
  }

  const meter = (pct, tone) =>
    `<div class="ds-meter"${attrs({ 'data-tone': tone })}><i style="width:${pct}%"></i></div>`
  const progress = (done, total, o = {}) => {
    const pct = Math.round((done / total) * 100)
    const full = `${done.toLocaleString('en')} of ${total.toLocaleString('en')}`
    return `<div class="ds-progress"${o.compact ? ` title="${full}"` : ''}>${meter(pct)}<span>${o.compact ? `${pct}%` : `${done} / ${total}`}</span></div>`
  }

  function coverage(label, have, total, o = {}) {
    const missing = total - have
    return `<div class="ds-coverage"><span>${esc(label)}</span>${meter(Math.round((have / total) * 100), o.tone)}<span class="ds-muted ds-num">${have} of ${total}</span>${missing ? btn(o.action || `Queue ${missing}`, { size: 'xs' }) : `<span class="ds-muted ds-coverage-done">Complete</span>`}</div>`
  }

  function source(o) {
    const actions =
      o.actions ||
      `${btn('', { icon: 'refresh', size: 'xs', variant: 'ghost', aria: 'Refresh from provider' })}${btn('', { icon: 'external', size: 'xs', variant: 'ghost', aria: `Open on ${PROVIDERS[o.p].name} (opens in a new tab)`, title: `Open on ${PROVIDERS[o.p].name} (new tab)` })}`
    return `<details class="ds-source"${attrs({ open: o.open })}><summary>${icon('chevR')}${mark(o.p, { hidden: true })}<span class="ds-source-main"><span class="ds-source-line"><a class="ds-source-name" href="#">${PROVIDERS[o.p].name}</a>${status(o.match[0], o.match[1])}</span><span class="ds-source-id">${esc(o.id)}</span></span><span class="ds-source-when"><span>${esc(o.when)}</span>${o.state || ''}</span><span class="ds-cell-actions">${actions}</span></summary>${o.body ? `<div class="ds-source-body">${o.body}</div>` : ''}</details>`
  }

  /* o.wrap: items end in a button (given as markup) instead of a link */
  const timeline = (items, o = {}) =>
    `<ol class="ds-timeline"${attrs({ 'data-wrap': o.wrap })}>${items.map(([when, state, text, link]) => `<li><span class="ds-muted ds-num">${esc(when)}</span>${status(state[0], state[1])}<span class="ds-truncate">${text}</span>${link ? (o.wrap ? link : `<a class="ds-muted" href="#">${esc(link)}</a>`) : '<span></span>'}</li>`).join('')}</ol>`

  function notice(text, o = {}) {
    return `<div class="ds-notice"${attrs({ 'data-tone': o.tone })}>${icon(o.icon || (o.tone ? 'alert' : 'info'), { size: 'sm' })}<span>${text}</span>${o.action || ''}</div>`
  }

  const state = (title, text, o = {}) =>
    `<div class="ds-state"${attrs({ 'data-size': o.size })}><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}${o.action || ''}</div>`

  /* Menu. An item is [icon, label, hint, hover], or a named group of
     choices, { group, choices: [[label, chosen]] }, with the chosen one
     ticked. o.label names a menu of actions, such as More. */
  const choiceGroup = (item) =>
    `<div class="ds-menu-group" role="group" aria-label="${esc(item.group)}"><div class="ds-pop-head" aria-hidden="true">${esc(item.group)}</div>${item.choices
      .map(
        ([label, on]) =>
          `<button type="button" class="ds-menu-item" role="menuitemradio" aria-checked="${Boolean(on)}">${on ? icon('check', { size: 'sm' }) : '<span class="ds-menu-slot"></span>'}${esc(label)}</button>`,
      )
      .join('')}</div>`
  const menu = (items, head, o = {}) =>
    `<div class="ds-pop"${attrs({ role: o.label ? 'menu' : undefined, 'aria-label': o.label })}>${head ? `<div class="ds-pop-head">${esc(head)}</div>` : ''}${items
      .map((item) =>
        item.group
          ? choiceGroup(item)
          : `<button type="button" class="ds-menu-item"${attrs({ role: o.label ? 'menuitem' : undefined, 'data-state': item[3] ? 'hover' : undefined })}>${item[0] ? icon(item[0], { size: 'sm' }) : ''}${esc(item[1])}${item[2] ? `<span class="ds-muted">${esc(item[2])}</span>` : ''}</button>`,
      )
      .join('')}</div>`

  /* Detail header and inspector */

  /* o.play is the play pair: under the artwork and as wide as it, or first
     in the action row when o.art is false. o.links is the line of service
     logos under the facts (logoLinks). o.actions is the action row (see
     headActions); without it, and without a pair to put there, the row is
     not drawn. */
  function detailHead(o) {
    const cover =
      o.art === false ? '' : artBox(o.item, { ratio: o.ratio, size: o.size })
    const name = esc(o.title || o.item.title)
    const art = o.linked
      ? `<a href="#" aria-label="Open details for ${name}">${cover}</a>`
      : cover
    const title = o.linked ? `<a href="#">${name}</a>` : name
    const lead =
      art && o.play
        ? `<div class="ds-detail-side">${art}<div class="ds-detail-play">${o.play}</div></div>`
        : art
    const row = `${art ? '' : o.play || ''}${o.actions || ''}`
    return `<header class="ds-detail-head"${attrs({ 'data-art': art ? undefined : 'none' })}>${lead}<div><div class="ds-kicker">${esc(o.kind)}</div><h2 class="ds-detail-title">${title}</h2>${o.by ? `<div class="ds-detail-by">${o.by}</div>` : ''}<div class="ds-detail-facts">${o.facts.map((f) => `<span>${f}</span>`).join('')}</div>${o.links ? `<div class="ds-detail-links">${o.links}</div>` : ''}${row ? `<div class="ds-detail-actions">${row}</div>` : ''}</div></header>`
  }

  /* The action row: the item's own actions (o.lead), then More at the far
     end. On a phone More is in the drawer bar, so leave the row out of a
     phone header with nothing else. */
  const headActions = (o = {}) =>
    `${o.lead || ''}<span class="ds-spacer"></span>${btn('', { icon: 'more', variant: 'ghost', size: 'md', aria: 'More actions', title: 'More actions' })}`

  function inspector(o) {
    const crumbs = o.crumbs
      .map((c, i, all) =>
        i === all.length - 1
          ? `<b>${esc(c)}</b>`
          : `<a href="#">${esc(c)}</a>${icon('chevR', { size: 'sm' })}`,
      )
      .join('')
    return `<aside class="ds-inspector"><div class="ds-inspector-bar">${btn('', { icon: 'chevL', variant: 'ghost', aria: 'Back' })}<div class="ds-crumbs">${crumbs}</div>${btn('Open page', { icon: 'expand', variant: 'ghost' })}${btn('', { icon: 'x', variant: 'ghost', aria: 'Close' })}</div><div class="ds-inspector-body">${o.head}${o.tabs ? tabs(o.tabs, o.tab || 0) : ''}${o.body}</div></aside>`
  }

  /* Shell */

  function navItem(n) {
    return `<a class="ds-nav-item" href="#"${attrs({ 'aria-current': n.current ? 'page' : undefined, 'data-level': n.level })}>${n.icon ? icon(n.icon) : ''}<span>${esc(n.label)}</span>${n.count !== undefined ? count(n.count, n.tone) : ''}</a>`
  }

  function dock(o = {}) {
    const ghost = (name, aria) =>
      btn('', { icon: name, variant: 'ghost', aria })
    const device = o.needsDevice
      ? `<span class="ds-dock-status" data-tone="attention">Choose a device to play</span>${btn('Devices', { icon: 'speaker', variant: 'primary' })}`
      : `${btn('Kitchen', { icon: 'speaker' })}`
    return `<footer class="ds-dock"><div class="ds-dock-now">${artBox(ALBUMS[0])}<div class="ds-row-main"><a class="ds-row-title" href="#">Sodium Glow</a><span class="ds-row-by">Mira Kestrel</span></div></div><div class="ds-dock-transport"><div class="ds-dock-buttons">${ghost('shuffle', 'Shuffle')}${ghost('prev', 'Previous')}<button type="button" class="ds-dock-toggle" aria-label="Pause">${icon('pause', { size: 'sm' })}</button>${ghost('next', 'Next')}${ghost('repeat', 'Repeat')}</div><div class="ds-dock-scrub"><span>1:24</span>${meter(34)}<span>4:10</span></div></div><div class="ds-dock-tools">${device}${ghost('queue', 'Queue')}</div></footer>`
  }

  function shell(o) {
    const libraries = ['Albums', 'Tracks', 'Artists', 'Films', 'Subscriptions']
    const ordered = [o.library, ...libraries.filter((l) => l !== o.library)]
    const system = [
      {
        label: 'Jobs',
        icon: 'activity',
        count: 3,
        tone: 'attention',
        current: o.current === 'Jobs',
      },
      {
        label: 'Providers',
        icon: 'layers',
        count: 1,
        tone: 'danger',
        current: o.current === 'Providers',
      },
    ]
    const chips = o.chips
      ? `<div class="ds-rail-label">Filters</div><div class="ds-rail-chips">${o.chips.map(([label, mode]) => pill(label, { mode, remove: true })).join('')}</div>`
      : ''
    return `<div class="ds-shell"><aside class="ds-rail">${select(ordered, { label: 'Library' }).replace('ds-select', 'ds-select ds-library')}${o.nav.map(navItem).join('')}<div class="ds-rail-label">System</div>${system.map(navItem).join('')}${chips}<div class="ds-rail-foot">${navItem({ label: 'Account', icon: 'user' })}</div></aside><section class="ds-main">${o.main}</section>${dock(o.dock)}</div>`
  }

  const libraryNav = (current) =>
    [
      ['Browse', 'grid'],
      ['Playlists', 'listMusic'],
      ['Tags', 'tag'],
      ['Imports', 'download'],
    ].map(([label, ic]) => ({ label, icon: ic, current: label === current }))

  /* Mock data */

  const ALBUMS = [
    [
      'Harbour Lights',
      'Mira Kestrel',
      '2019-03-08',
      '2026-10-02',
      11,
      '42:18',
      412,
      '3.71',
      ['dream pop', 'shoegaze', 'ethereal', 'nocturnal', 'lush'],
    ],
    [
      'Glasshouse Weather',
      'The Lowlands',
      '2022-09-16',
      '2026-09-27',
      10,
      '38:54',
      268,
      '3.52',
      ['indie folk', 'chamber pop', 'pastoral'],
    ],
    [
      'Paper Moons',
      'Odile Varga',
      '2016-05-20',
      '2026-09-14',
      9,
      '36:02',
      190,
      '3.88',
      ['art pop', 'baroque pop', 'melancholic', 'theatrical'],
    ],
    [
      'Night Bus Atlas',
      'Tenth Floor',
      '2021-11-05',
      '2026-08-30',
      12,
      '51:40',
      344,
      '3.64',
      ['downtempo', 'trip hop', 'urban', 'nocturnal'],
    ],
    [
      'Salt Maps',
      'Ferro & Vane',
      '2018-02-02',
      '2026-08-11',
      8,
      '44:27',
      97,
      '3.40',
      ['ambient', 'modern classical'],
    ],
    [
      'Low Tide Radio',
      'Kite Assembly',
      '2023-06-23',
      '2026-07-19',
      13,
      '47:15',
      156,
      '3.29',
      ['indie rock', 'jangle pop', 'summery'],
    ],
    [
      'Understory',
      'Imogen Hale',
      '2020-04-17',
      '2026-07-02',
      10,
      '40:09',
      231,
      '3.95',
      ['singer-songwriter', 'folk', 'intimate', 'acoustic'],
    ],
    [
      'Static Bloom',
      'Marlow Quay',
      '2024-01-26',
      '2026-06-21',
      11,
      '43:33',
      78,
      null,
      ['post-punk', 'new wave'],
    ],
    [
      'Slow Electric',
      'June Okafor',
      '2017-10-13',
      '2026-06-03',
      9,
      '39:48',
      305,
      '3.77',
      ['neo-soul', 'r&b', 'warm', 'sensual'],
    ],
    [
      'Field Notes Vol. 2',
      'Hollow Coast',
      '2015-08-07',
      '2026-05-18',
      14,
      '58:21',
      64,
      '3.18',
      ['field recordings', 'ambient', 'drone'],
    ],
    [
      'Ceramic',
      'Yuki Arden',
      '2025-03-14',
      '2026-04-29',
      10,
      '35:56',
      122,
      '3.83',
      ['electronic', 'idm', 'glitch', 'playful'],
    ],
    [
      'Open Signal',
      'Nine Rivers',
      '2012-11-30',
      '2026-04-06',
      12,
      '49:02',
      88,
      '3.46',
      ['post-rock', 'instrumental', 'cinematic'],
    ],
  ].map(
    (
      [title, by, released, added, tracks, duration, plays, rym, tags],
      seed,
    ) => ({
      kind: 'album',
      seed,
      title,
      by,
      released,
      year: released.slice(0, 4),
      added,
      tracks,
      duration,
      plays,
      rym,
      tags: tags.map(tagLabel),
      art: seed === 7 ? null : undefined,
    }),
  )

  const ALBUM_TRACKS = [
    ['Breakwater', '3:42', 48],
    ['Sodium Glow', '4:10', 61],
    ['Harbour Lights', '3:48', 74],
    ['Ferry Timetable', '2:57', 22],
    ['Low Cloud', '4:33', 35],
    ['Signal Box', '3:21', 29],
    ['Tide Tables', '5:02', 41],
    ['Lanterns Out', '3:39', 33],
    ['Quay Song', '2:46', 18],
    ['Small Hours', '4:18', 37],
    ['Undertow, Again', '4:02', 14],
  ].map(([title, duration, plays], i) => ({
    kind: 'track',
    seed: 0,
    n: i + 1,
    title,
    duration,
    plays,
    by: 'Mira Kestrel',
    album: 'Harbour Lights',
  }))

  const TRACKS = [
    ['Harbour Lights', 0, '3:48', 74, '2026-10-02', ['Late shift', 'Kitchen']],
    ['Sodium Glow', 0, '4:10', 61, '2026-10-02', ['Late shift']],
    ['Conservatory', 1, '3:27', 52, '2026-09-27', ['Sunday slow']],
    ['Paper Moons', 2, '4:41', 47, '2026-09-14', []],
    ['Route 9, Night Service', 3, '5:16', 66, '2026-08-30', ['Late shift']],
    ['Isobar', 4, '7:02', 19, '2026-08-11', ['Sunday slow']],
    ['Longwave', 5, '3:12', 38, '2026-07-19', ['Kitchen']],
    ['Moss and Wire', 6, '3:55', 58, '2026-07-02', ['Sunday slow', 'Kitchen']],
    ['Slow Electric', 8, '4:24', 71, '2026-06-03', ['Late shift', 'Kitchen']],
    ['Kiln', 10, '3:03', 26, '2026-04-29', []],
    ['Carrier Wave', 11, '6:38', 21, '2026-04-06', ['Late shift']],
  ].map(([title, a, duration, plays, added, playlists]) => ({
    kind: 'track',
    seed: a,
    title,
    by: ALBUMS[a].by,
    album: ALBUMS[a].title,
    duration,
    plays,
    added,
    playlists,
    tags: ALBUMS[a].tags.slice(0, 2),
  }))

  const ARTISTS = [
    [
      'Mira Kestrel',
      'New Zealand',
      3,
      31,
      902,
      '2026-10-02',
      ['dream pop', 'shoegaze'],
    ],
    [
      'The Lowlands',
      'United Kingdom',
      2,
      21,
      411,
      '2026-09-27',
      ['indie folk', 'chamber pop'],
    ],
    [
      'Odile Varga',
      'France',
      4,
      38,
      655,
      '2026-09-14',
      ['art pop', 'baroque pop'],
    ],
    [
      'Tenth Floor',
      'Germany',
      2,
      24,
      512,
      '2026-08-30',
      ['downtempo', 'trip hop'],
    ],
    ['June Okafor', 'Nigeria', 3, 29, 731, '2026-06-03', ['neo-soul', 'r&b']],
    [
      'Imogen Hale',
      'Australia',
      2,
      20,
      388,
      '2026-07-02',
      ['singer-songwriter', 'folk'],
    ],
    ['Hollow Coast', 'Iceland', 5, 61, 140, '2026-05-18', ['ambient', 'drone']],
    ['Yuki Arden', 'Japan', 1, 10, 122, '2026-04-29', ['electronic', 'idm']],
  ].map(([title, country, albums, tracks, plays, added, tags], i) => ({
    kind: 'artist',
    seed: i + 4,
    title,
    country,
    albums,
    tracks,
    plays,
    added,
    tags: tags.map(tagLabel),
    art: i === 6 ? null : undefined,
  }))

  const FILMS = [
    [
      'The Quiet Meridian',
      'Anneke Solberg',
      '2021',
      '1h 52m',
      ['7.4', '78', '91%', '3.8'],
      ['drama', 'slow cinema', 'coastal'],
      '2026-09-21',
      '2026-08-02',
    ],
    [
      'Paper Lanterns',
      'Hiro Tanabe',
      '2018',
      '1h 38m',
      ['7.9', '84', '95%', '4.1'],
      ['family', 'drama'],
      '2026-10-30',
      '2026-07-15',
    ],
    [
      'North of Ordinary',
      'Wren Calloway',
      '2023',
      '2h 04m',
      ['6.8', '66', '74%', '3.4'],
      ['road movie', 'comedy'],
      null,
      '2026-10-11',
    ],
    [
      'A Small Weather',
      'Leila Marchetti',
      '2015',
      '1h 29m',
      ['7.1', '71', '88%', '3.7'],
      ['romance', 'chamber piece'],
      '2025-12-28',
      '2025-11-30',
    ],
    [
      'Glass Orchard',
      'Tomas Ibarra',
      '2024',
      '1h 47m',
      ['7.6', '81', '93%', '3.9'],
      ['mystery', 'thriller', 'rural'],
      null,
      '2026-11-01',
    ],
    [
      'Last Ferry Home',
      'Dov Arendt',
      '2010',
      '1h 41m',
      ['8.0', '88', '97%', '4.2'],
      ['drama', 'coming-of-age'],
      '2026-03-02',
      '2025-09-19',
    ],
  ].map(([title, by, year, runtime, r, tags, watched, added], i) => ({
    kind: 'film',
    seed: i + 2,
    title,
    by,
    year,
    runtime,
    imdb: r[0],
    mc: r[1],
    rt: r[2],
    lb: r[3],
    tags: tags.map(tagLabel),
    watched,
    added,
  }))

  const VIDEOS = [
    ['Restoring a 1974 mixing desk', 'Slow Workshop', '2026-11-12', '28:14'],
    [
      'Dawn chorus from an estuary hide',
      'Field Recordist',
      '2026-11-10',
      '41:07',
    ],
    ['Tape loops for beginners', 'Analogue Hours', '2026-11-08', '17:52'],
    ['Rewiring a patch bay', 'Slow Workshop', '2026-11-03', '22:36'],
  ].map(([title, by, published, duration], i) => ({
    kind: 'video',
    seed: i + 5,
    title,
    by,
    published,
    duration,
  }))

  const PLAYLISTS = [
    {
      kind: 'playlist',
      seed: 3,
      title: 'Late shift',
      by: 'Spotify',
      tracks: 42,
      duration: '2h 51m',
      updated: '2026-11-09',
    },
    {
      kind: 'playlist',
      seed: 8,
      title: 'Kitchen',
      by: 'Spotify',
      tracks: 118,
      duration: '7h 12m',
      updated: '2026-11-14',
    },
    {
      kind: 'playlist',
      seed: 10,
      title: 'Sunday slow',
      by: 'Spotify',
      tracks: 67,
      duration: '4h 38m',
      updated: '2026-10-26',
    },
  ]

  /* Listening and activity series: daily counts, generated from a fixed seed */

  const DAY = 86400000
  const TODAY = Date.UTC(2026, 10, 16)
  const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const iso = (t) => new Date(t).toISOString().slice(0, 10)

  function rng(seed) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function daily(seed, start, rate, o = {}) {
    const rand = rng(seed)
    const first = Date.parse(`${start}T00:00:00Z`)
    const n = Math.round((TODAY - first) / DAY) + 1
    const days = []
    let mood = 1
    for (let i = 0; i < n; i++) {
      if (rand() < (o.vary ? 0.3 : 0.02))
        mood = o.vary ? 0.55 + rand() * 0.9 : 0.25 + rand() * 2.4
      const burst = 1 + (o.burst || 0) * Math.exp(-i / 45)
      const lambda =
        rate *
        mood *
        burst *
        (1 + 0.25 * Math.sin((i / 365) * 2 * Math.PI + seed))
      let v
      if (lambda > 30) {
        v = Math.max(
          0,
          Math.round(
            lambda + (rand() + rand() + rand() - 1.5) * Math.sqrt(lambda) * 1.6,
          ),
        )
      } else {
        const limit = Math.exp(-lambda)
        let k = 0
        let p = 1
        do {
          k++
          p *= rand()
        } while (p > limit)
        v = k - 1
      }
      days.push({ t: first + i * DAY, v })
    }
    if (o.total) {
      let sum = days.reduce((s, d) => s + d.v, 0)
      while (sum !== o.total) {
        const d = days[Math.floor(rand() * n)]
        if (sum > o.total && d.v > 0) {
          d.v--
          sum--
        } else if (sum < o.total && (d.v > 0 || rand() < 0.1)) {
          d.v++
          sum++
        }
      }
    }
    return days
  }

  const SETS = {
    album: () => daily(11, '2019-04-02', 0.14, { burst: 5, total: 412 }),
    track: () => daily(23, '2019-04-02', 0.03, { burst: 5, total: 74 }),
    artist: () => daily(37, '2017-06-10', 0.3, { burst: 2, total: 902 }),
    playlist: () => daily(41, '2024-02-01', 1.3, { total: 1284 }),
    recent: () => daily(53, '2026-10-26', 0.6, { total: 14 }),
    requests: () => daily(67, '2026-05-01', 420, { vary: true }),
    jobs: () => daily(71, '2026-05-01', 180, { vary: true }),
  }
  const cache = {}
  const series = (name) => (cache[name] = cache[name] || SETS[name]())
  /*
   * The earliest scrobble of the whole library. "All" on every listening
   * chart and every listening sparkline start here, not at the first scrobble
   * of the item, so they all cover the same period.
   */
  const HISTORY_FROM = Date.UTC(2014, 2, 10)
  const LISTENING = ['album', 'track', 'artist', 'playlist', 'recent']
  const historyFrom = (name) =>
    LISTENING.includes(name) ? HISTORY_FROM : undefined

  /*
   * Granularity follows the data, so the line reads as a line. Of day, week,
   * month, quarter and year, take the finest that averages three or more per
   * point with 10 to 120 points on screen. A sparse history falls back to the
   * coarsest that still gives ten points. "All" never shows less than 30 days.
   */
  const GRAINS = ['day', 'week', 'month', 'quarter', 'year']
  function grainKey(t, g) {
    const d = new Date(t)
    if (g === 'day') return t
    if (g === 'week') return t - ((d.getUTCDay() + 6) % 7) * DAY
    if (g === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    if (g === 'quarter')
      return Date.UTC(
        d.getUTCFullYear(),
        Math.floor(d.getUTCMonth() / 3) * 3,
        1,
      )
    return Date.UTC(d.getUTCFullYear(), 0, 1)
  }
  function bucket(days, range, maxPoints = 120, start = TODAY) {
    const spans = { '30d': 29, '90d': 89, '1y': 364, '5y': 1825 }
    const first = Math.min(days.length ? days[0].t : TODAY, start)
    const from =
      range in spans
        ? TODAY - spans[range] * DAY
        : Math.min(first, TODAY - 29 * DAY)
    const build = (g) => {
      const start = grainKey(from, g)
      const map = new Map()
      for (let t = start; t <= TODAY; t += DAY)
        if (!map.has(grainKey(t, g))) map.set(grainKey(t, g), 0)
      for (const d of days)
        if (d.t >= start && d.t <= TODAY)
          map.set(grainKey(d.t, g), map.get(grainKey(d.t, g)) + d.v)
      return { g, points: [...map].map(([t, v]) => ({ t, v })) }
    }
    const all = GRAINS.map(build)
    const options = all.filter((c) => c.points.length <= maxPoints)
    const fits = options.filter((c) => c.points.length >= 10)
    const total = (c) => c.points.reduce((s, p) => s + p.v, 0)
    return (
      fits.find((c) => total(c) / c.points.length >= 3) ||
      fits[fits.length - 1] ||
      options[0] ||
      all[all.length - 1]
    )
  }

  /* Monotone cubic through the points: smooth, and never dips below a value */
  function smooth(pts) {
    const n = pts.length
    const start = `M${pts[0][0]} ${pts[0][1]}`
    if (n < 3)
      return { start, segs: pts.slice(1).map((p) => `L${p[0]} ${p[1]}`) }
    const dx = []
    const slope = []
    for (let i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1][0] - pts[i][0]
      slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]
    }
    const tan = [slope[0]]
    for (let i = 1; i < n - 1; i++) {
      tan[i] =
        slope[i - 1] * slope[i] <= 0
          ? 0
          : (2 * slope[i - 1] * slope[i]) / (slope[i - 1] + slope[i])
    }
    tan[n - 1] = slope[n - 2]
    const segs = []
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3
      segs.push(
        `C${r1(pts[i][0] + h)} ${r1(pts[i][1] + tan[i] * h)} ${r1(pts[i + 1][0] - h)} ${r1(pts[i + 1][1] - tan[i + 1] * h)} ${pts[i + 1][0]} ${pts[i + 1][1]}`,
      )
    }
    return { start, segs }
  }

  function ticks(max) {
    const steps = [
      1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000,
      10000, 20000, 50000,
    ]
    const step = steps.find((s) => max / s <= 3.2) || 100000
    const top = Math.max(step, Math.ceil(max / step) * step)
    const out = []
    for (let v = 0; v <= top; v += step) out.push(v)
    return out
  }

  const QUARTERS = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec']
  function periodLabel(t, g, isLast) {
    const d = new Date(t)
    const label =
      g === 'day'
        ? iso(t)
        : g === 'week'
          ? `Week of ${iso(t)}`
          : g === 'month'
            ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
            : g === 'quarter'
              ? `${QUARTERS[d.getUTCMonth() / 3]} ${d.getUTCFullYear()}`
              : String(d.getUTCFullYear())
    return isLast && g !== 'day' ? `${label}, so far` : label
  }

  function axisLabels(points, g, room) {
    const all = []
    points.forEach((p, i) => {
      const d = new Date(p.t)
      if (g === 'day' && d.getUTCDay() === 1)
        all.push([i, `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`])
      if (g === 'week' && d.getUTCDate() <= 7)
        all.push([
          i,
          d.getUTCMonth() === 0
            ? `Jan ${d.getUTCFullYear()}`
            : MONTHS[d.getUTCMonth()],
        ])
      if ((g === 'month' || g === 'quarter') && d.getUTCMonth() === 0)
        all.push([i, String(d.getUTCFullYear())])
      if (g === 'year') all.push([i, String(d.getUTCFullYear())])
    })
    const step = Math.max(1, Math.ceil(all.length / room))
    return all.filter((_, i) => i % step === 0)
  }

  function drawChart(el) {
    const days = series(el.dataset.chart)
    const range = el.dataset.range || 'all'
    const unit = el.dataset.unit || 'scrobbles'
    const W = Math.max(240, el.clientWidth)
    const H = Number(el.dataset.height) || 168
    const m = { t: 10, r: 6, b: 22, l: 32 }
    const iw = W - m.l - m.r
    const ih = H - m.t - m.b
    /* No more than one point every 8px, so a narrow chart takes a coarser grain */
    const { g, points } = bucket(
      days,
      range,
      Math.min(120, Math.max(12, Math.floor(iw / 8))),
      historyFrom(el.dataset.chart),
    )
    const tk = ticks(Math.max(1, ...points.map((p) => p.v)))
    const top = tk[tk.length - 1]
    const x = (i) =>
      r1(m.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw))
    const y = (v) => r1(m.t + ih - (v / top) * ih)
    const pts = points.map((p, i) => [x(i), y(p.v)])
    const path = smooth(pts)
    const partial = g !== 'day' && path.segs.length > 1
    const solid =
      path.start + (partial ? path.segs.slice(0, -1) : path.segs).join('')
    const last = pts[pts.length - 1]
    const dashed = partial
      ? `M${pts[pts.length - 2][0]} ${pts[pts.length - 2][1]}${path.segs[path.segs.length - 1]}`
      : ''
    const area = `${path.start}${path.segs.join('')}L${last[0]} ${y(0)}L${pts[0][0]} ${y(0)}Z`
    const grid = tk
      .map((v) =>
        v === 0
          ? `<line class="ds-chart-base" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/><text x="${m.l - 8}" y="${y(0) + 4}" text-anchor="end">0</text>`
          : `<line class="ds-chart-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toLocaleString('en')}</text>`,
      )
      .join('')
    const xl = axisLabels(points, g, Math.floor(iw / 72))
      .map(([i, text]) => {
        const anchor =
          x(i) < m.l + 20 ? 'start' : x(i) > W - m.r - 20 ? 'end' : 'middle'
        return `<text x="${x(i)}" y="${H - 5}" text-anchor="${anchor}">${text}</text>`
      })
      .join('')
    const total = points.reduce((s, p) => s + p.v, 0)
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${total.toLocaleString('en')} ${unit}, by ${g}">${grid}${xl}<path class="ds-chart-area" d="${area}"/><path class="ds-chart-line" d="${solid}"/>${dashed ? `<path class="ds-chart-line" stroke-dasharray="1 5" d="${dashed}"/>` : ''}<g data-hover style="display:none"><line class="ds-chart-cross" y1="${m.t}" y2="${y(0)}"/><circle class="ds-chart-dot" r="4"/></g><rect x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent"/></svg><div class="ds-chart-tip" hidden></div>`
    const caption = el
      .closest('[data-chartbox]')
      ?.querySelector('[data-chart-caption]')
    if (caption)
      caption.textContent = `${unit[0].toUpperCase()}${unit.slice(1)} per ${g}`

    const hover = el.querySelector('[data-hover]')
    const tip = el.querySelector('.ds-chart-tip')
    const hit = el.querySelector('rect')
    hit.addEventListener('pointermove', (event) => {
      const box = hit.getBoundingClientRect()
      const i = Math.max(
        0,
        Math.min(
          points.length - 1,
          Math.round(
            ((event.clientX - box.left) / box.width) * (points.length - 1),
          ),
        ),
      )
      hover.style.display = ''
      hover.querySelector('line').setAttribute('x1', pts[i][0])
      hover.querySelector('line').setAttribute('x2', pts[i][0])
      hover.querySelector('circle').setAttribute('cx', pts[i][0])
      hover.querySelector('circle').setAttribute('cy', pts[i][1])
      tip.hidden = false
      tip.innerHTML = `<b>${points[i].v.toLocaleString('en')} ${unit}</b><span>${periodLabel(points[i].t, g, i === points.length - 1)}</span>`
      const scale = el.clientWidth / W
      const left = pts[i][0] * scale
      tip.style.left =
        left > el.clientWidth - 150
          ? `${left - tip.offsetWidth - 10}px`
          : `${left + 10}px`
    })
    hit.addEventListener('pointerleave', () => {
      hover.style.display = 'none'
      tip.hidden = true
    })
  }

  function chartBox(set, o = {}) {
    const ranges = o.ranges || ['30d', '1y', '5y', 'All']
    const selected = Math.max(0, ranges.indexOf(o.range || 'All'))
    return `<div data-chartbox><div class="ds-charthead"><span class="ds-muted ds-chart-caption" data-chart-caption></span>${o.extra || ''}${ranges.length > 1 ? seg(ranges, selected, { label: 'Range' }) : ''}</div><div class="ds-chart"${attrs({ 'data-chart': set, 'data-range': (ranges[selected] || 'All').toLowerCase(), 'data-unit': o.unit, 'data-height': o.height })}></div></div>`
  }

  /* Histogram: bars are [label, count, state]; state is 'selected' or
     'partial'. A bar with no count is still loading. */
  function hist(bars, o = {}) {
    const top = Math.max(1, ...bars.map(([, n]) => n || 0))
    return `<div class="ds-hist" role="group"${attrs({ 'aria-label': o.label })}>${bars
      .map(([label, n, state]) => {
        const loading = n === undefined || n === null
        return `<button type="button" class="ds-hist-bar"${attrs({ 'aria-pressed': String(state === 'selected'), 'data-partial': state === 'partial' })}><span class="ds-hist-count">${loading ? '' : n.toLocaleString('en')}</span>${loading ? '<span class="ds-hist-track ds-skel"></span>' : `<span class="ds-hist-track"><i style="height:${Math.round(Math.sqrt(n / top) * 100)}%"></i></span>`}<span>${esc(label)}</span></button>`
      })
      .join('')}</div>`
  }

  /* Condition: an outlined card of lines. Each line is a list of parts; a
     part is a word, or an object for a control:
     { select: 'At most' }, { number: 6 }, { date: '2019-01-01' } */
  const condPart = (part) =>
    typeof part === 'string'
      ? `<span>${esc(part)}</span>`
      : part.select !== undefined
        ? select([part.select], { label: part.label })
        : part.number !== undefined
          ? `<input class="ds-input" type="number" min="0"${attrs({ value: part.number, 'aria-label': part.label })} />`
          : `<input class="ds-input" type="date"${attrs({ value: part.date, 'aria-label': part.label })} />`
  const condLine = (parts) =>
    `<div class="ds-cond-line">${parts.map(condPart).join('')}</div>`
  const cond = (lines) =>
    `<div class="ds-cond">${lines.map(condLine).join('')}${btn('Remove', { icon: 'x', variant: 'ghost' })}</div>`

  function spark(values, o = {}) {
    const w = o.w || 72
    const h = o.h || 20
    const max = Math.max(1, ...values)
    const pts = values.map((v, i) => [
      r1((i / (values.length - 1)) * w),
      r1(h - 2 - (v / max) * (h - 4)),
    ])
    const path = smooth(pts)
    const d = path.start + path.segs.join('')
    return `<svg class="ds-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path data-area d="${d}L${w} ${h}L0 ${h}Z"/><path d="${d}"/></svg>`
  }

  /*
   * Sparkline of a named series: every month since the start of the
   * listening history, or the last 30 days. Values merge into at most 16
   * equal runs counted from the end, so only the oldest run can be short.
   */
  function sparkOf(set, range = 'all') {
    let values
    if (range === 'all') {
      const months = new Map()
      for (let t = HISTORY_FROM; t <= TODAY; t += DAY)
        months.set(grainKey(t, 'month'), 0)
      for (const d of series(set))
        months.set(
          grainKey(d.t, 'month'),
          months.get(grainKey(d.t, 'month')) + d.v,
        )
      values = [...months.values()]
    } else {
      values = bucket(series(set), range)
        .points.slice(0, -1)
        .map((p) => p.v)
    }
    const size = Math.ceil(values.length / 16)
    const merged = []
    for (let end = values.length; end > 0; end -= size)
      merged.unshift(
        values.slice(Math.max(0, end - size), end).reduce((s, v) => s + v, 0),
      )
    return spark(merged)
  }
  const sparkSeed = (seed) => {
    const rand = rng(seed)
    let v = 4 + rand() * 6
    return spark(
      Array.from(
        { length: 14 },
        () => (v = Math.max(0, v + (rand() - 0.5) * 6)),
      ),
    )
  }

  /* Page chrome and behaviour */

  const PAGES = [
    ['index.html', 'Overview'],
    ['foundations.html', 'Foundations'],
    ['components.html', 'Components'],
    ['screens-browse.html', 'Browse screens'],
    ['screens-detail.html', 'Detail screens'],
    ['screens-data.html', 'Sources and listening'],
    ['screens-ops.html', 'Jobs and providers'],
  ]

  function hydrate(root) {
    root.querySelectorAll('.ds-rating-weight input').forEach((input) => {
      input.addEventListener('input', () => {
        const text = `${input.value}×`
        input.nextElementSibling.textContent = text
        input.setAttribute('aria-valuetext', text)
      })
    })
    root
      .querySelectorAll('.ds-rating-difference[aria-controls]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          const evidence = document.getElementById(
            button.getAttribute('aria-controls'),
          )
          if (evidence) evidence.open = true
        })
      })
    const charts = [...root.querySelectorAll('[data-chart]')]
    charts.forEach(drawChart)
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (Math.abs(entry.contentRect.width - (entry.target._w || 0)) > 2) {
            entry.target._w = entry.contentRect.width
            drawChart(entry.target)
          }
        }
      })
      charts.forEach((c) => observer.observe(c))
    }
    root.querySelectorAll('.ds-table-wrap').forEach((wrap) => {
      const tableEl = wrap.querySelector('.ds-table')
      const sync = () =>
        tableEl.toggleAttribute('data-scrolled', wrap.scrollLeft > 0)
      wrap.addEventListener('scroll', sync, { passive: true })
      sync()
    })
    root.addEventListener('click', (event) => {
      const segButton = event.target.closest('.ds-seg[data-toggle] button')
      if (segButton) {
        segButton.parentElement
          .querySelectorAll('button')
          .forEach((b) =>
            b.setAttribute('aria-pressed', String(b === segButton)),
          )
        const chart = segButton
          .closest('[data-chartbox]')
          ?.querySelector('[data-chart]')
        if (chart) {
          chart.dataset.range = segButton.dataset.value.toLowerCase()
          drawChart(chart)
        }
      }
      const tab = event.target.closest('.ds-tab')
      if (tab)
        tab.parentElement
          .querySelectorAll('.ds-tab')
          .forEach((t) => t.setAttribute('aria-selected', String(t === tab)))
      if (event.target.closest('a[href="#"]')) event.preventDefault()
    })
  }

  function page(o) {
    const here = document.body.dataset.page
    const nav = `<nav class="g-nav" aria-label="Design library"><div class="g-nav-title">Media Manager</div><div class="g-nav-sub">Design library</div>${PAGES.map(
      ([href, label]) =>
        `<a href="${href}"${href === here ? ' aria-current="page"' : ''}>${label}</a>${href === here ? o.sections.map((s) => `<a data-sub href="#${s.id}">${esc(s.title)}</a>`).join('') : ''}`,
    ).join('')}</nav>`
    const main = `<main class="g-main"><header class="g-head"><h1>${esc(o.title)}</h1><p>${o.lede}</p></header>${o.sections.map((s) => `<section class="g-sec" id="${s.id}"><h2>${esc(s.title)}</h2>${s.body}</section>`).join('')}</main>`
    document.body.innerHTML = nav + main
    hydrate(document.body)
  }

  /* Default columns for each resource, in the shared column order:
     identity, creator, parent, properties, dates, counts, ratings, pills */

  const link = (text) => `<a href="#">${esc(text)}</a>`
  const mono = (value) =>
    value === null || value === undefined
      ? EMPTY
      : `<span class="ds-mono">${esc(value)}</span>`
  const COLS = {
    albums: [
      { h: 'Title', sort: '', c: (r) => idCell(r) },
      { h: 'Artists', sort: '', c: (r) => link(r.by) },
      { h: 'Released', sort: '', c: (r) => r.released },
      { h: 'Added', sort: 'descending', c: (r) => r.added },
      { h: 'Tracks', sort: '', end: true, c: (r) => r.tracks },
      { h: 'Scrobbles', sort: '', end: true, c: (r) => r.plays },
      { h: 'RYM', sort: '', end: true, c: (r) => mono(r.rym) },
      { h: 'Tags', c: (r) => pills(r.tags, { max: 2 }) },
    ],
    tracks: [
      { h: 'Title', sort: '', c: (r) => idCell(r) },
      { h: 'Artists', sort: '', c: (r) => link(r.by) },
      { h: 'Album', sort: '', c: (r) => link(r.album) },
      { h: 'Duration', sort: '', end: true, c: (r) => r.duration },
      { h: 'Added', sort: 'descending', c: (r) => r.added },
      { h: 'Scrobbles', sort: '', end: true, c: (r) => r.plays },
      {
        h: 'Playlists',
        c: (r) => (r.playlists.length ? pills(r.playlists, { max: 2 }) : EMPTY),
      },
      { h: 'Tags', c: (r) => pills(r.tags, { max: 2 }) },
    ],
    albumTracks: [
      {
        h: '#',
        w: 40,
        end: true,
        c: (r) => `<span class="ds-muted">${r.n}</span>`,
      },
      { h: 'Title', c: (r) => idCell(r, { thumb: false, playing: r.n === 2 }) },
      { h: 'Duration', end: true, w: 80, c: (r) => r.duration },
      { h: 'Scrobbles', end: true, w: 88, c: (r) => r.plays },
    ],
    artists: [
      { h: 'Artist', sort: '', c: (r) => idCell(r) },
      { h: 'Country', sort: '', c: (r) => r.country },
      { h: 'Added', sort: 'descending', c: (r) => r.added },
      { h: 'Albums', sort: '', end: true, c: (r) => r.albums },
      { h: 'Tracks', sort: '', end: true, c: (r) => r.tracks },
      { h: 'Scrobbles', sort: '', end: true, c: (r) => r.plays },
      { h: 'Tags', c: (r) => pills(r.tags, { max: 2 }) },
    ],
    films: [
      { h: 'Title', sort: '', c: (r) => idCell(r, { play: false }) },
      { h: 'Directors', sort: '', c: (r) => link(r.by) },
      { h: 'Released', sort: '', c: (r) => r.year },
      { h: 'Runtime', sort: '', end: true, c: (r) => r.runtime },
      { h: 'Watched', sort: '', c: (r) => r.watched || EMPTY },
      { h: 'Added', sort: 'descending', c: (r) => r.added },
      { h: 'IMDb', sort: '', end: true, c: (r) => mono(r.imdb) },
      { h: 'Metacritic', sort: '', end: true, c: (r) => mono(r.mc) },
      { h: 'RT', sort: '', end: true, c: (r) => mono(r.rt) },
      { h: 'Tags', c: (r) => pills(r.tags, { max: 2 }) },
    ],
  }

  /* Gallery helpers */
  const g = {
    spec: (html, o = {}) =>
      `<div class="g-spec"${attrs({ 'data-flush': o.flush, style: o.style })}>${html}</div>`,
    flow: (items, o = {}) =>
      `<div class="g-flow"${attrs({ 'data-top': o.top })}>${items.join('')}</div>`,
    item: (html, caption) =>
      `<div class="g-item">${html}<small>${caption}</small></div>`,
    rules: (list) =>
      `<ul class="g-rules">${list.map((r) => `<li>${r}</li>`).join('')}</ul>`,
    note: (label, text) => `<p class="g-note"><b>${label}</b> ${text}</p>`,
    sub: (text) => `<h3 class="g-sub">${text}</h3>`,
    label: (text, kind) =>
      `<span class="g-label"${attrs({ 'data-kind': kind })}>${text}</span>`,
    tag: (kind) =>
      kind === 'api'
        ? '<span class="g-tag" data-kind="api">Needs API</span>'
        : '<span class="g-tag">UI only</span>',
    doc: (head, rows) =>
      `<table class="ds-table g-doc"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
  }

  window.DS = {
    COLS,
    g,
    link,
    mono,
    esc,
    icon,
    ICON,
    art,
    artBox,
    thumb,
    btn,
    play,
    libraryAction,
    pill,
    pills,
    count,
    status,
    STATUS,
    mark,
    provider,
    logoLinks,
    PROVIDERS,
    rating,
    ratingWeight,
    ratingDifference,
    ratingPosition,
    EMPTY,
    tabs,
    workspaceTabs,
    seg,
    VIEWS,
    search,
    select,
    sortPick,
    sortList,
    filtersBtn,
    filterLine,
    toolbar,
    filtersDrawer,
    checkRow,
    tagLocation,
    table,
    checkCol,
    idCell,
    partToggle,
    PART_SLOT,
    partTitle,
    groupActions,
    toolbarToggle,
    card,
    row,
    suggestion,
    SUGGESTION,
    skelRow,
    listHead,
    facts,
    kv,
    stat,
    stats,
    section,
    meter,
    progress,
    coverage,
    source,
    timeline,
    notice,
    state,
    menu,
    detailHead,
    headActions,
    inspector,
    navItem,
    dock,
    shell,
    libraryNav,
    chartBox,
    hist,
    cond,
    condLine,
    spark,
    sparkOf,
    sparkSeed,
    series,
    bucket,
    page,
    data: { ALBUMS, ALBUM_TRACKS, TRACKS, ARTISTS, FILMS, VIDEOS, PLAYLISTS },
  }
})()
