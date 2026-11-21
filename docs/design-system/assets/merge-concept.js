/*
 * Invented library for the merge concept page.
 *
 * A record (one row in Tracks, Albums or Artists) is a set of parts. A part is
 * a scrobbled name from Last.fm or a version from Spotify. Merging moves parts
 * into one record and separating moves one out again. Parts are never changed
 * or deleted, and every change is a journal entry that can be undone.
 *
 * All names, counts and dates here are invented.
 */
;(() => {
  const version = (id, kind, rec, fields) => ({
    id,
    kind,
    rec,
    type: 'version',
    plays: 0,
    ...fields,
  })
  const name = (id, kind, rec, fields) => ({
    id,
    kind,
    rec,
    type: 'name',
    art: null,
    ...fields,
  })

  const MIRA = 'Mira Kestrel'
  const HARBOUR = 'Harbour Lights'

  const albumTrack = (key, title, n, duration, plays, seed = 0) => [
    version(`t-${key}`, 'track', `t-${key}`, {
      title,
      by: MIRA,
      album: HARBOUR,
      albumPart: 'b-harbour',
      n,
      duration,
      seed,
      from: 'Album track',
    }),
    name(`t-${key}-n`, 'track', `t-${key}`, {
      title,
      by: MIRA,
      album: HARBOUR,
      albumPart: 'b-harbour-n',
      plays,
    }),
  ]

  const PARTS = [
    /* Artists */
    version('a-mira', 'artist', 'a-mira', {
      title: MIRA,
      seed: 4,
      detail: '3 albums · 31 tracks',
    }),
    name('a-mira-n', 'artist', 'a-mira', { title: MIRA, plays: 902 }),
    name('a-mira-n2', 'artist', 'a-mira-n2', {
      title: 'Mira Kestrell',
      plays: 5,
    }),
    version('a-low', 'artist', 'a-low', {
      title: 'The Lowlands',
      seed: 5,
      detail: '2 albums · 21 tracks',
    }),
    name('a-low-n', 'artist', 'a-low', { title: 'The Lowlands', plays: 411 }),
    name('a-low-n2', 'artist', 'a-low-n2', { title: 'Lowlands', plays: 23 }),
    version('a-ferro', 'artist', 'a-ferro', {
      title: 'Ferro & Vane',
      seed: 8,
      detail: '1 album · 8 tracks',
    }),
    name('a-ferro-n', 'artist', 'a-ferro', {
      title: 'Ferro & Vane',
      plays: 97,
    }),
    name('a-ferro-n2', 'artist', 'a-ferro', {
      title: 'Ferro and Vane',
      plays: 31,
    }),
    version('a-hollow', 'artist', 'a-hollow', {
      title: 'Hollow Coast',
      seed: 10,
      detail: '5 albums · 61 tracks',
    }),
    name('a-hollow-n', 'artist', 'a-hollow', {
      title: 'Hollow Coast',
      plays: 140,
    }),
    version('a-hollows', 'artist', 'a-hollows', {
      title: 'Hollow Coasts',
      seed: 3,
      detail: '1 album · 9 tracks',
    }),
    name('a-hollows-n', 'artist', 'a-hollows', {
      title: 'Hollow Coasts',
      plays: 18,
    }),
    version('a-tenth', 'artist', 'a-tenth', {
      title: 'Tenth Floor',
      seed: 7,
      detail: '2 albums · 24 tracks',
    }),
    name('a-tenth-n', 'artist', 'a-tenth', {
      title: 'Tenth Floor',
      plays: 512,
    }),
    version('a-june', 'artist', 'a-june', {
      title: 'June Okafor',
      seed: 12,
      detail: '3 albums · 29 tracks',
    }),
    name('a-june-n', 'artist', 'a-june', { title: 'June Okafor', plays: 731 }),
    version('a-imogen', 'artist', 'a-imogen', {
      title: 'Imogen Hale',
      seed: 9,
      detail: '2 albums · 20 tracks',
    }),
    name('a-imogen-n', 'artist', 'a-imogen', {
      title: 'Imogen Hale',
      plays: 388,
    }),

    /* Albums */
    version('b-harbour', 'album', 'b-harbour', {
      title: HARBOUR,
      by: MIRA,
      seed: 0,
      detail: '2019 · 11 tracks',
    }),
    name('b-harbour-n', 'album', 'b-harbour', {
      title: HARBOUR,
      by: MIRA,
      plays: 398,
    }),
    version('b-harbour-dlx', 'album', 'b-harbour-dlx', {
      title: 'Harbour Lights (Deluxe)',
      by: MIRA,
      seed: 0,
      detail: '2020 · 14 tracks',
    }),
    name('b-harbour-dlx-n', 'album', 'b-harbour-dlx', {
      title: 'Harbour Lights (Deluxe)',
      by: MIRA,
      plays: 14,
    }),
    name('b-harbor-n', 'album', 'b-harbor-n', {
      title: 'Harbor Lights',
      by: MIRA,
      plays: 9,
    }),
    name('b-harbour-n3', 'album', 'b-harbour-n3', {
      title: HARBOUR,
      by: 'Mira Kestrell',
      plays: 5,
    }),
    version('b-glass', 'album', 'b-glass', {
      title: 'Glasshouse Weather',
      by: 'The Lowlands',
      seed: 1,
      detail: '2022 · 10 tracks',
    }),
    name('b-glass-n', 'album', 'b-glass', {
      title: 'Glasshouse Weather',
      by: 'The Lowlands',
      plays: 268,
    }),
    version('b-night', 'album', 'b-night', {
      title: 'Night Bus Atlas',
      by: 'Tenth Floor',
      seed: 3,
      detail: '2021 · 12 tracks',
    }),
    name('b-night-n', 'album', 'b-night', {
      title: 'Night Bus Atlas',
      by: 'Tenth Floor',
      plays: 344,
    }),
    version('b-under', 'album', 'b-under', {
      title: 'Understory',
      by: 'Imogen Hale',
      seed: 6,
      detail: '2020 · 10 tracks',
    }),
    name('b-under-n', 'album', 'b-under', {
      title: 'Understory',
      by: 'Imogen Hale',
      plays: 301,
    }),
    version('b-slow', 'album', 'b-slow', {
      title: 'Slow Electric',
      by: 'June Okafor',
      seed: 8,
      detail: '2017 · 9 tracks',
    }),
    name('b-slow-n', 'album', 'b-slow', {
      title: 'Slow Electric',
      by: 'June Okafor',
      plays: 512,
    }),

    /* Tracks on Harbour Lights */
    ...albumTrack('break', 'Breakwater', 1, '3:42', 48),
    name('t-break-n2', 'track', 't-break-n2', {
      title: 'Breakwater',
      by: MIRA,
      album: 'Harbor Lights',
      albumPart: 'b-harbor-n',
      plays: 4,
    }),
    ...albumTrack('sodium', 'Sodium Glow', 2, '4:10', 61),
    name('t-sodium-feat', 'track', 't-sodium-feat', {
      title: 'Sodium Glow (feat. June Okafor)',
      by: MIRA,
      album: HARBOUR,
      albumPart: 'b-harbour-n',
      plays: 8,
    }),
    ...albumTrack('harbour', HARBOUR, 3, '3:48', 74),
    version('t-harbour-dlx', 'track', 't-harbour', {
      title: HARBOUR,
      by: MIRA,
      album: 'Harbour Lights (Deluxe)',
      albumPart: 'b-harbour-dlx',
      n: 3,
      duration: '3:48',
      seed: 0,
      from: 'Album track',
    }),
    ...albumTrack('ferry', 'Ferry Timetable', 4, '2:57', 22),
    ...albumTrack('low', 'Low Cloud', 5, '4:33', 35),
    name('t-low-n2', 'track', 't-low-n2', {
      title: 'Low Cloud',
      by: 'Mira Kestrell',
      album: HARBOUR,
      albumPart: 'b-harbour-n3',
      plays: 5,
    }),
    ...albumTrack('signal', 'Signal Box', 6, '3:21', 29),
    ...albumTrack('tide', 'Tide Tables', 7, '5:02', 41),
    name('t-tide-n2', 'track', 't-tide-n2', {
      title: 'Tide Tables',
      by: MIRA,
      album: 'Harbor Lights',
      albumPart: 'b-harbor-n',
      plays: 3,
    }),
    ...albumTrack('lanterns', 'Lanterns Out', 8, '3:39', 33),
    name('t-lanterns-n2', 'track', 't-lanterns-n2', {
      title: 'Lanterns Out - Single Version',
      by: MIRA,
      album: HARBOUR,
      albumPart: 'b-harbour-n',
      plays: 6,
    }),
    ...albumTrack('quay', 'Quay Song', 9, '2:46', 18),
    name('t-quay-demo', 'track', 't-quay-demo', {
      title: 'Quay Song (Demo)',
      by: MIRA,
      album: 'Harbor Lights',
      albumPart: 'b-harbor-n',
      plays: 2,
    }),
    ...albumTrack('small', 'Small Hours', 10, '4:18', 37),
    ...albumTrack('under', 'Undertow, Again', 11, '4:02', 14),

    /* Tracks elsewhere */
    version('t-route', 'track', 't-route', {
      title: 'Route 9, Night Service',
      by: 'Tenth Floor',
      album: 'Night Bus Atlas',
      albumPart: 'b-night',
      n: 4,
      duration: '5:16',
      seed: 3,
      from: 'Album track',
    }),
    name('t-route-n', 'track', 't-route', {
      title: 'Route 9, Night Service',
      by: 'Tenth Floor',
      album: 'Night Bus Atlas',
      albumPart: 'b-night-n',
      plays: 66,
    }),
    name('t-route-n2', 'track', 't-route', {
      title: 'Route 9 (Night Service)',
      by: 'Tenth Floor',
      album: 'Night Bus Atlas',
      albumPart: 'b-night-n',
      plays: 12,
    }),
    version('t-route-live', 'track', 't-route-live', {
      title: 'Route 9, Night Service - Live at Funkhaus',
      by: 'Tenth Floor',
      album: 'Funkhaus Sessions',
      duration: '6:02',
      seed: 7,
      from: 'Playlist',
    }),
    name('t-route-live-n', 'track', 't-route-live', {
      title: 'Route 9, Night Service - Live at Funkhaus',
      by: 'Tenth Floor',
      album: 'Funkhaus Sessions',
      plays: 5,
    }),
    version('t-slow', 'track', 't-slow', {
      title: 'Slow Electric',
      by: 'June Okafor',
      album: 'Slow Electric',
      albumPart: 'b-slow',
      n: 1,
      duration: '4:24',
      seed: 8,
      from: 'Album track',
    }),
    name('t-slow-n', 'track', 't-slow', {
      title: 'Slow Electric',
      by: 'June Okafor',
      album: 'Slow Electric',
      albumPart: 'b-slow-n',
      plays: 71,
    }),
    version('t-slow-single', 'track', 't-slow-single', {
      title: 'Slow Electric',
      by: 'June Okafor',
      album: 'Slow Electric (Single)',
      duration: '4:24',
      seed: 11,
      from: 'Liked Songs',
    }),
    version('t-slow-edit', 'track', 't-slow-edit', {
      title: 'Slow Electric - Radio Edit',
      by: 'June Okafor',
      album: 'Slow Electric (Single)',
      duration: '3:31',
      seed: 11,
      from: 'Playlist',
    }),
    name('t-slow-edit-n', 'track', 't-slow-edit', {
      title: 'Slow Electric - Radio Edit',
      by: 'June Okafor',
      album: 'Slow Electric (Single)',
      plays: 9,
    }),
    version('t-moss', 'track', 't-moss', {
      title: 'Moss and Wire',
      by: 'Imogen Hale',
      album: 'Understory',
      albumPart: 'b-under',
      n: 2,
      duration: '3:55',
      seed: 6,
      from: 'Album track',
    }),
    name('t-moss-n', 'track', 't-moss', {
      title: 'Moss and Wire',
      by: 'Imogen Hale',
      album: 'Understory',
      albumPart: 'b-under-n',
      plays: 58,
    }),
    name('t-moss-n2', 'track', 't-moss-n2', {
      title: 'Moss and Wire (2021 Remaster)',
      by: 'Imogen Hale',
      album: 'Understory',
      albumPart: 'b-under-n',
      plays: 7,
    }),
    version('t-isobar', 'track', 't-isobar', {
      title: 'Isobar',
      by: 'Ferro & Vane',
      album: 'Salt Maps',
      n: 3,
      duration: '7:02',
      seed: 4,
      from: 'Album track',
    }),
    name('t-isobar-n', 'track', 't-isobar', {
      title: 'Isobar',
      by: 'Ferro & Vane',
      album: 'Salt Maps',
      plays: 19,
    }),
  ]

  /* Likely duplicates the app found but did not merge on its own. */
  const SUGGESTIONS = [
    {
      id: 's-break',
      kind: 'track',
      parts: ['t-break', 't-break-n2'],
      evidence: ['Same title and artist', 'Album names one letter apart'],
    },
    {
      id: 's-sodium',
      kind: 'track',
      parts: ['t-sodium', 't-sodium-feat'],
      evidence: ['Same title without the featured credit', 'Same album'],
    },
    {
      id: 's-low',
      kind: 'track',
      parts: ['t-low', 't-low-n2'],
      evidence: ['Same title and album', 'Artist names one letter apart'],
    },
    {
      id: 's-tide',
      kind: 'track',
      parts: ['t-tide', 't-tide-n2'],
      evidence: ['Same title and artist', 'Album names one letter apart'],
    },
    {
      id: 's-lanterns',
      kind: 'track',
      parts: ['t-lanterns', 't-lanterns-n2'],
      evidence: ['Same title without “Single Version”', 'Same album'],
    },
    {
      id: 's-quay',
      kind: 'track',
      parts: ['t-quay', 't-quay-demo'],
      evidence: ['Same title without “Demo”'],
    },
    {
      id: 's-slow',
      kind: 'track',
      parts: ['t-slow', 't-slow-single', 't-slow-edit'],
      evidence: [
        'Same title and artist',
        'Two are 4:24; the Radio Edit is 3:31',
      ],
    },
    {
      id: 's-moss',
      kind: 'track',
      parts: ['t-moss', 't-moss-n2'],
      evidence: ['Same title without “2021 Remaster”', 'Same album'],
    },
    {
      id: 's-harbour-dlx',
      kind: 'album',
      parts: ['b-harbour', 'b-harbour-dlx'],
      evidence: ['Same artist', 'The first 11 tracks are the same recordings'],
    },
    {
      id: 's-harbor',
      kind: 'album',
      parts: ['b-harbour', 'b-harbor-n'],
      evidence: [
        'Names one letter apart',
        '2 of 3 scrobbled tracks are on the track list',
      ],
    },
    {
      id: 's-harbour-n3',
      kind: 'album',
      parts: ['b-harbour', 'b-harbour-n3'],
      evidence: ['Same title', 'Artist names one letter apart'],
    },
    {
      id: 's-mira',
      kind: 'artist',
      parts: ['a-mira', 'a-mira-n2'],
      evidence: [
        'Names one letter apart',
        'Its one scrobbled album is a Mira Kestrel album',
      ],
    },
    {
      id: 's-low-artist',
      kind: 'artist',
      parts: ['a-low', 'a-low-n2'],
      evidence: [
        'Same name without “The”',
        '3 of 3 scrobbled tracks are The Lowlands tracks',
      ],
    },
    {
      id: 's-hollow',
      kind: 'artist',
      parts: ['a-hollow', 'a-hollows'],
      evidence: ['Names one letter apart'],
    },
  ]

  /*
   * A scrobble is recorded as artist, album and title. When a name higher up
   * is merged, the names under it follow; when a name lower down is merged,
   * the name above it is merged with it. `join` is the pair that follows,
   * `after` the pairs that bring it along and `brings` what it brings in turn.
   */
  const FOLLOWS = [
    {
      id: 'f-harbor',
      kind: 'album',
      join: ['b-harbor-n', 'b-harbour'],
      after: [
        ['t-break-n2', 't-break'],
        ['t-tide-n2', 't-tide'],
        ['t-quay-demo', 't-quay'],
      ],
      brings: [
        ['t-break-n2', 't-break'],
        ['t-tide-n2', 't-tide'],
      ],
    },
    {
      id: 'f-mira',
      kind: 'artist',
      join: ['a-mira-n2', 'a-mira'],
      after: [
        ['t-low-n2', 't-low'],
        ['b-harbour-n3', 'b-harbour'],
      ],
      brings: [
        ['b-harbour-n3', 'b-harbour'],
        ['t-low-n2', 't-low'],
      ],
    },
  ]

  /* Merges the app made on its own before the page opened. */
  const AUTOMATIC = [
    {
      at: '2026-11-18 06:02',
      kind: 'track',
      rule: 'Same title, ignoring punctuation',
      part: 't-route-n2',
      from: 't-route-n2',
      to: 't-route',
    },
    {
      at: '2026-11-16 06:01',
      kind: 'artist',
      rule: '“and” and “&” are the same',
      part: 'a-ferro-n2',
      from: 'a-ferro-n2',
      to: 'a-ferro',
    },
    {
      at: '2026-11-14 21:40',
      kind: 'track',
      rule: 'Same recording code (ISRC)',
      part: 't-harbour-dlx',
      from: 't-harbour-dlx',
      to: 't-harbour',
    },
  ]

  const NOUN = {
    track: ['track', 'tracks'],
    album: ['album', 'albums'],
    artist: ['artist', 'artists'],
  }
  const VERSION_WORDS = [
    'live',
    'demo',
    'remix',
    'radio edit',
    'acoustic',
    'instrumental',
  ]
  const seconds = (text) => {
    const [m, s] = text.split(':').map(Number)
    return m * 60 + s
  }
  const clock = (total) =>
    `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  const plural = (n, kind) => `${n} ${NOUN[kind][n === 1 ? 0 : 1]}`

  function create() {
    const parts = new Map(PARTS.map((p) => [p.id, p]))
    const recordOf = new Map(PARTS.map((p) => [p.id, p.rec]))
    const lead = new Map()
    const kept = new Set()
    const journal = []
    let serial = 0
    let minute = 0

    const stamp = () => {
      minute += 1
      return `2026-11-21 10:${String(10 + minute).padStart(2, '0')}`
    }

    for (const auto of AUTOMATIC)
      journal.push({
        id: `j${++serial}`,
        at: auto.at,
        by: 'Automatic',
        rule: auto.rule,
        kind: auto.kind,
        text: `Merged “${parts.get(auto.part).title}” into “${parts.get(auto.to).title}”`,
        moves: [{ part: auto.part, from: auto.from, to: auto.to }],
        keeps: [],
        blocks: [],
        plays: parts.get(auto.part).plays,
        undone: false,
      })

    const membersOf = (map, id) =>
      PARTS.filter((p) => map.get(p.id) === id).map((p) => p.id)

    function view(id, map = recordOf) {
      const ids = membersOf(map, id)
      if (!ids.length) return null
      const list = ids.map((partId) => parts.get(partId))
      const versions = list.filter((p) => p.type === 'version')
      const names = list.filter((p) => p.type === 'name')
      const chosen = lead.get(id)
      const first =
        (chosen && ids.includes(chosen) && parts.get(chosen)) ||
        versions[0] ||
        [...names].sort((a, b) => b.plays - a.plays)[0]
      /* A track is listed under its album record, whatever name it was
         scrobbled under. */
      const above = first.albumPart && view(map.get(first.albumPart), map)
      return {
        id,
        kind: first.kind,
        lead: first,
        parts: list,
        versions,
        names,
        title: first.title,
        by: first.by,
        album: above ? above.title : first.album,
        duration: (versions[0] || first).duration,
        detail: (versions[0] || first).detail,
        n: first.n,
        seed: first.seed,
        art: first.art,
        plays: names.reduce((sum, p) => sum + p.plays, 0),
      }
    }

    const records = (kind) =>
      [...new Set(recordOf.values())]
        .map((id) => view(id))
        .filter((r) => r && r.kind === kind)
        .sort(
          (a, b) => a.title.localeCompare(b.title, 'en') || b.plays - a.plays,
        )

    const madeOf = (r) => {
      const bits = []
      if (r.versions.length) {
        const word = r.kind === 'artist' ? 'profile' : 'version'
        bits.push(
          `${r.versions.length} ${r.versions.length === 1 ? word : `${word}s`}`,
        )
      }
      if (r.names.length)
        bits.push(
          `${r.names.length} ${r.names.length === 1 ? 'name' : 'names'}`,
        )
      return bits.join(' · ')
    }

    /* The record that keeps its ID: one with a version, then the most played. */
    const survivor = (ids, map) =>
      ids
        .map((id) => view(id, map))
        .sort(
          (a, b) =>
            Number(b.versions.length > 0) - Number(a.versions.length > 0) ||
            b.plays - a.plays,
        )[0].id

    function join(map, ids, moves) {
      const distinct = [...new Set(ids)]
      if (distinct.length < 2) return distinct[0]
      const to = survivor(distinct, map)
      for (const from of distinct) {
        if (from === to) continue
        for (const part of membersOf(map, from)) {
          map.set(part, to)
          moves.push({ part, from, to })
        }
      }
      return to
    }

    const together = (map, [a, b]) => map.get(a) === map.get(b)

    /* What a merge of these records would do, without doing it. */
    function plan(ids, o = {}) {
      const map = new Map(recordOf)
      const moves = []
      const before = ids.map((id) => view(id))
      const kind = before[0].kind
      const target = join(map, ids, moves)
      const follows = []
      if (o.follow !== false) {
        let changed = true
        while (changed) {
          changed = false
          for (const rule of FOLLOWS) {
            if (follows.some((f) => f.rule === rule)) continue
            const joined = together(map, rule.join)
            const direct = !together(recordOf, rule.join) && joined
            const triggered = rule.after.some(
              (pair) => !together(recordOf, pair) && together(map, pair),
            )
            if (!direct && !triggered) continue
            const extra = []
            if (!joined)
              join(map, [map.get(rule.join[0]), map.get(rule.join[1])], extra)
            const brought = []
            for (const pair of rule.brings) {
              if (together(map, pair)) continue
              join(map, [map.get(pair[0]), map.get(pair[1])], extra)
              brought.push(pair)
            }
            if (!extra.length) continue
            moves.push(...extra)
            follows.push({ rule, direct, brought, moves: extra })
            changed = true
          }
        }
      }
      const result = view(target, map)
      return {
        kind,
        before,
        target,
        moves,
        follows,
        result,
        added: result.plays - view(target).plays,
        cautions: cautions(before, follows),
        text: followText(follows),
      }
    }

    function followText(follows) {
      return follows.map(({ rule, direct, brought }) => {
        const from = parts.get(rule.join[0])
        const to = parts.get(rule.join[1])
        const names = `${brought.length} ${brought.length === 1 ? 'name' : 'names'} scrobbled under`
        if (direct)
          return {
            kind: rule.kind,
            line: brought.length ? `${names} “${from.title}”` : '',
          }
        return {
          kind: rule.kind,
          line: `${rule.kind} name “${from.title}” into “${to.title}”${brought.length ? `, with ${names} it` : ''}`,
        }
      })
    }

    function cautions(list, follows) {
      const out = []
      const kind = list[0].kind
      if (kind === 'track') {
        const titles = list.map((r) => r.title.toLowerCase())
        for (const word of VERSION_WORDS) {
          const hits = titles.filter((t) => t.includes(word)).length
          if (hits && hits < titles.length)
            out.push(
              `“${word.replace(/^./, (c) => c.toUpperCase())}” is in ${hits === 1 ? 'one title' : `${hits} titles`} only.`,
            )
        }
        const lengths = list
          .flatMap((r) => r.versions.map((v) => v.duration))
          .filter(Boolean)
          .map(seconds)
        const span = lengths.length
          ? Math.max(...lengths) - Math.min(...lengths)
          : 0
        if (span > 10) out.push(`Lengths differ by ${clock(span)}.`)
        const artists = [...new Set(list.map((r) => r.by))]
        const artistFollows = follows.some((f) => f.rule.kind === 'artist')
        if (artists.length > 1 && !artistFollows)
          out.push(`Credited to different artists: ${artists.join(', ')}.`)
      }
      if (kind === 'artist' && list.filter((r) => r.versions.length).length > 1)
        out.push('Each has its own Spotify profile and albums.')
      return out
    }

    function record(entry) {
      journal.unshift({
        id: `j${++serial}`,
        at: stamp(),
        by: 'You',
        keeps: [],
        moves: [],
        blocks: [],
        undone: false,
        ...entry,
      })
      return journal[0]
    }

    function apply(moves) {
      for (const move of moves) recordOf.set(move.part, move.to)
    }

    function merge(ids, o = {}) {
      const p = plan(ids, o)
      apply(p.moves)
      if (o.lead) lead.set(p.target, o.lead)
      const also = p.text.map((t) => t.line).filter(Boolean)
      return record({
        kind: p.kind,
        text: `Merged ${plural(ids.length, p.kind)} into “${view(p.target).title}”`,
        also,
        moves: p.moves,
        plays: p.added,
        target: p.target,
      })
    }

    function block(ids, blocked) {
      for (const entry of journal)
        if (ids.includes(entry.id)) entry.blocked = blocked
    }

    function separate(partId) {
      const from = recordOf.get(partId)
      const part = parts.get(partId)
      const title = view(from).title
      const to = `${partId}~${++serial}`
      /* Separating a part an automatic merge placed is a decision too. */
      const blocks = journal
        .filter(
          (entry) =>
            entry.by === 'Automatic' &&
            !entry.undone &&
            entry.moves.some((m) => m.part === partId && m.to === from),
        )
        .map((entry) => entry.id)
      block(blocks, true)
      recordOf.set(partId, to)
      return record({
        kind: part.kind,
        text: `Separated “${part.title}” from “${title}”`,
        blocks,
        moves: [{ part: partId, from, to }],
        plays: part.plays,
        target: from,
      })
    }

    function keepSeparate(suggestionId) {
      const s = SUGGESTIONS.find((x) => x.id === suggestionId)
      kept.add(s.id)
      const titles = [...new Set(s.parts.map((id) => recordOf.get(id)))].map(
        (id) => `“${view(id).title}”`,
      )
      return record({
        kind: s.kind,
        text: `Kept ${plural(titles.length, s.kind)} separate: ${titles.join(', ')}`,
        keeps: [s.id],
        plays: 0,
      })
    }

    /* A change can be undone while every part is still where it put it, and
       redone while every part is still where the undo left it. After a later
       change has moved a part, that later change is undone first. */
    const canUndo = (entry) =>
      !entry.undone && entry.moves.every((m) => recordOf.get(m.part) === m.to)
    const canRedo = (entry) =>
      entry.undone && entry.moves.every((m) => recordOf.get(m.part) === m.from)

    function undo(id) {
      const entry = journal.find((j) => j.id === id)
      if (!entry || !canUndo(entry)) return
      for (const move of [...entry.moves].reverse())
        recordOf.set(move.part, move.from)
      for (const s of entry.keeps) kept.delete(s)
      block(entry.blocks, false)
      entry.undone = true
      /* Undoing an automatic merge is a decision: it is not made again. */
      if (entry.by === 'Automatic') entry.blocked = true
    }

    function redo(id) {
      const entry = journal.find((j) => j.id === id)
      if (!entry || !canRedo(entry)) return
      apply(entry.moves)
      for (const s of entry.keeps) kept.add(s)
      block(entry.blocks, true)
      entry.undone = false
      entry.blocked = false
    }

    const suggestions = (kind) =>
      SUGGESTIONS.filter((s) => s.kind === kind && !kept.has(s.id))
        .map((s) => ({
          ...s,
          records: [...new Set(s.parts.map((id) => recordOf.get(id)))].map(
            (id) => view(id),
          ),
        }))
        .filter((s) => s.records.length > 1)

    const suggestionsFor = (recordId) => {
      const r = view(recordId)
      return r
        ? suggestions(r.kind).filter((s) =>
            s.records.some((x) => x.id === recordId),
          )
        : []
    }

    /* Journal entries that moved a part into or out of this record. */
    const changesTo = (recordId) => {
      const own = new Set(membersOf(recordOf, recordId))
      return journal.filter((j) =>
        j.moves.some(
          (m) => own.has(m.part) || m.to === recordId || m.from === recordId,
        ),
      )
    }

    /* Tracks of an album record, and scrobbled names under it that match no
       track on its list. */
    function albumTracks(albumRecordId) {
      const albumParts = new Set(membersOf(recordOf, albumRecordId))
      const first = view(albumRecordId).versions[0]
      const all = records('track')
      const listed = all
        .filter((r) => r.versions.some((v) => v.albumPart === first?.id))
        .sort(
          (a, b) =>
            a.versions.find((v) => v.albumPart === first.id).n -
            b.versions.find((v) => v.albumPart === first.id).n,
        )
      const loose = all.filter(
        (r) =>
          !r.versions.length &&
          r.names.some((p) => albumParts.has(p.albumPart)),
      )
      return { listed, loose }
    }

    const setLead = (recordId, partId) => lead.set(recordId, partId)

    return {
      parts,
      view,
      records,
      madeOf,
      plan,
      merge,
      separate,
      keepSeparate,
      undo,
      redo,
      canUndo,
      canRedo,
      suggestions,
      suggestionsFor,
      changesTo,
      albumTracks,
      setLead,
      recordOf: (partId) => recordOf.get(partId),
      journal: () => journal,
      plural,
    }
  }

  window.MergeConcept = { create }
})()
