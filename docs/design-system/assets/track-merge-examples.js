;(() => {
  const range = (first, last) =>
    Array.from({ length: last - first + 1 }, (_, index) => first + index)
  const unique = (values) => [...new Set(values)]
  const uniqueBy = (values, key) => {
    const seen = new Set()
    return values.filter((value) => {
      const id = key(value)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  const parent = (id, name, detail, evidenceKey, evidence) => ({
    id,
    name,
    detail,
    evidenceKey,
    evidence,
    originalNames: [name],
  })
  const credit = (id, role = 'Artist') => ({ id, role })
  const position = (id, number) => ({ id, number })
  const track = (
    id,
    title,
    recording,
    albumId,
    artistId,
    plays,
    options = {},
  ) => ({
    id,
    title,
    recording,
    albumIds: [albumId],
    credits: [credit(artistId)],
    plays,
    kind: 'track',
    art: null,
    sources: [options.spotify ? 'Album track list' : 'Last.fm'],
    originalNames: options.spotify ? [] : [title],
    positions: [],
    ...options,
  })

  // All names, identifiers, scrobbles and memberships here are invented.
  const fixtures = {
    shared: {
      label: 'Shared album and artist',
      selected: ['remix', 'remix-punctuation'],
      albums: [
        parent('glass', 'Prism Survey', '2021 remix single'),
        parent(
          'glass-club',
          'Prism Survey (Club Edition)',
          '2023 club edition',
        ),
      ],
      artists: [
        parent('remixer', 'Orrin Fold', 'Remixer and primary artist credit'),
      ],
      tracks: [
        track(
          'remix',
          'The Glass Meridian – Orrin Fold Remix',
          'glass-remix',
          'glass',
          'remixer',
          range(1, 9),
          {
            spotify: 'glass-remix',
            seed: 4,
            art: undefined,
            positions: [position('glass', 2)],
          },
        ),
        track(
          'remix-punctuation',
          'The Glass Meridian (Orrin Fold Remix)',
          'glass-remix',
          'glass',
          'remixer',
          range(1, 9),
        ),
        track(
          'glass-intro',
          'Aperture Notes',
          'glass-intro',
          'glass',
          'remixer',
          range(11, 14),
          {
            spotify: 'glass-intro',
            seed: 4,
            art: undefined,
            positions: [position('glass', 1)],
          },
        ),
        track(
          'glass-club-mix',
          'The Glass Meridian (Club Mix)',
          'glass-club',
          'glass-club',
          'remixer',
          range(21, 26),
          {
            spotify: 'glass-club',
            seed: 8,
            art: undefined,
            positions: [position('glass-club', 1)],
          },
        ),
      ],
    },
    related: {
      label: 'Separate album and artist entries',
      selected: ['lanterns', 'lanterns-import'],
      albums: [
        parent(
          'echo',
          'Echo Cartography',
          'Spotify album import · 2025 · 8 tracks',
          'echo-release',
          'Both records have the same saved release ID and ordered track list.',
        ),
        parent(
          'echo-import',
          'Echo Cartography [Album]',
          'Legacy import · 2025 · 8 tracks',
          'echo-release',
          'Both records have the same saved release ID and ordered track list.',
        ),
        parent(
          'echo-expanded',
          'Echo Cartography (Expanded)',
          '2026 expanded edition · 12 tracks',
        ),
      ],
      artists: [
        parent(
          'orvane',
          'Tess Orvane',
          'Spotify profile · recording credits',
          'orvane-profile',
          'The saved artist ID agrees with the credited recordings.',
        ),
        parent(
          'orvane-import',
          'T. Orvane',
          'Legacy credit · recording credits',
          'orvane-profile',
          'The saved artist ID agrees with the credited recordings.',
        ),
        parent('vale', 'Sable Vorren', 'Featured artist · own artist record'),
      ],
      tracks: [
        track(
          'lanterns',
          'Low Lanterns',
          'low-lanterns',
          'echo',
          'orvane',
          range(1, 15),
          {
            spotify: 'low-lanterns',
            seed: 6,
            art: undefined,
            credits: [credit('orvane'), credit('vale', 'Featured artist')],
            positions: [position('echo', 3)],
          },
        ),
        track(
          'lanterns-import',
          'Low Lanterns',
          'low-lanterns',
          'echo-import',
          'orvane-import',
          range(12, 18),
        ),
        track(
          'small-transits',
          'Small Transits',
          'small-transits',
          'echo-import',
          'orvane-import',
          range(23, 27),
          {
            spotify: 'small-transits',
            seed: 6,
            art: undefined,
            positions: [position('echo-import', 4)],
          },
        ),
        track(
          'pulse',
          'Paper Pulse',
          'paper-pulse',
          'echo',
          'orvane',
          range(31, 33),
          {
            spotify: 'paper-pulse',
            seed: 6,
            art: undefined,
            positions: [position('echo', 5)],
          },
        ),
        track(
          'intertidal',
          'Intertidal Sketch',
          'intertidal',
          'echo-expanded',
          'orvane-import',
          range(41, 43),
          {
            spotify: 'intertidal',
            seed: 10,
            art: undefined,
            positions: [position('echo-expanded', 9)],
          },
        ),
      ],
    },
    overlap: {
      label: 'Overlapping scrobbles',
      selected: ['album', 'straight', 'plain'],
      albums: [
        parent('harbour', 'Harbour Lights', 'Studio album · 2024'),
        parent('sessions', 'Relay Sessions', 'Live release · 2025'),
      ],
      artists: [parent('kestrel', 'Mira Kestrel', 'Primary artist credit')],
      tracks: [
        track(
          'lines',
          'Signal Lines',
          'signal-lines',
          'harbour',
          'kestrel',
          range(40, 45),
          {
            spotify: 'lines',
            seed: 7,
            art: undefined,
            positions: [position('harbour', 1)],
          },
        ),
        track(
          'album',
          'Winter’s Relay',
          'relay-studio',
          'harbour',
          'kestrel',
          range(1, 24),
          {
            spotify: 'album',
            seed: 7,
            art: undefined,
            positions: [position('harbour', 2)],
          },
        ),
        track(
          'straight',
          "Winter's Relay",
          'relay-studio',
          'harbour',
          'kestrel',
          range(1, 8),
        ),
        track(
          'plain',
          'Winters Relay',
          'relay-studio',
          'harbour',
          'kestrel',
          range(23, 27),
        ),
        track(
          'live',
          'Winter’s Relay (Live)',
          'relay-live',
          'sessions',
          'kestrel',
          range(50, 61),
          {
            spotify: 'live',
            seed: 3,
            art: undefined,
            positions: [position('sessions', 1)],
          },
        ),
        track(
          'wires',
          'Wires at Dawn',
          'wires-at-dawn',
          'harbour',
          'kestrel',
          range(70, 73),
          {
            spotify: 'wires',
            seed: 7,
            art: undefined,
            positions: [position('harbour', 3)],
          },
        ),
      ],
    },
  }

  const examples = Object.entries(fixtures).map(([id, { label }]) => ({
    id,
    label,
  }))

  function withLabels(state) {
    const albumNames = new Map(state.albums.map(({ id, name }) => [id, name]))
    const artistNames = new Map(state.artists.map(({ id, name }) => [id, name]))
    return {
      ...state,
      tracks: state.tracks.map((row) => ({
        ...row,
        album: row.albumIds.map((id) => albumNames.get(id)).join(' · '),
        by: unique(row.credits.map(({ id }) => artistNames.get(id))).join(', '),
      })),
    }
  }

  function load(id) {
    const { tracks, albums, artists, selected } =
      fixtures[id] ?? fixtures.shared
    return withLabels(structuredClone({ tracks, albums, artists, selected }))
  }

  const kinds = [
    { kind: 'album', label: 'Album', ids: (row) => row.albumIds },
    {
      kind: 'artist',
      label: 'Artist',
      ids: (row) => row.credits.map(({ id }) => id),
    },
  ]
  const trackCount = (count) => `${count} ${count === 1 ? 'track' : 'tracks'}`

  const recordingFamilies = {
    'glass-remix': 'glass',
    'glass-club': 'glass',
    'relay-studio': 'relay',
    'relay-live': 'relay',
  }

  function trackConflict(rows) {
    if (unique(rows.map(({ spotify }) => spotify).filter(Boolean)).length > 1)
      return 'The selection contains different Spotify recordings.'
    const recordings = unique(rows.map(({ recording }) => recording))
    if (recordings.length < 2) return ''

    const families = recordings
      .map((id) => recordingFamilies[id])
      .filter(Boolean)
    if (unique(families).length < families.length)
      return 'The selection includes different versions of the same track.'
    return 'The selection includes different recordings.'
  }

  function related(state, rows) {
    const selectedIds = new Set(rows.map(({ id }) => id))
    return kinds.map(({ kind, label, ids }) => {
      const attached = new Set(rows.flatMap(ids))
      const records = state[`${kind}s`].filter(({ id }) => attached.has(id))
      if (!records.length)
        return {
          kind,
          label,
          status: 'none',
          summary: `No linked ${kind}`,
          evidence: '',
          records,
        }
      if (records.length === 1) {
        return {
          kind,
          label,
          status: 'shared',
          summary: `One ${kind} entry · ${records[0].name}`,
          evidence: rows.every((row) => ids(row).includes(records[0].id))
            ? `All selected tracks already link to the same ${kind} entry.`
            : `One ${kind} entry is linked across the selection.`,
          records,
        }
      }

      if (rows.every((row) => unique(ids(row)).length === records.length))
        return {
          kind,
          label,
          status: 'shared',
          summary: `Shared ${kind === 'artist' ? 'artist credits' : 'album entries'}`,
          evidence: `All selected tracks already link to the same ${kind} entries.`,
          records,
        }

      const pairs = records.flatMap((record, index) =>
        records
          .slice(index + 1)
          .flatMap((other) =>
            record.evidenceKey && record.evidenceKey === other.evidenceKey
              ? [[record, other]]
              : [],
          ),
      )
      if (pairs.length !== 1)
        return {
          kind,
          label,
          status: 'separate',
          summary: `Separate ${kind} entries`,
          evidence:
            kind === 'album'
              ? 'The selection includes separate releases.'
              : 'The selection includes distinct artist credits.',
          records,
        }

      const pair = pairs[0]
      const candidates = new Set(pair.map(({ id }) => id))
      const separateRecords = records.filter(({ id }) => !candidates.has(id))
      const affected = state.tracks.filter((row) =>
        ids(row).some((id) => candidates.has(id)),
      )
      return {
        kind,
        label,
        status: 'candidate',
        summary: `Two ${kind} entries match`,
        evidence: pair[0].evidence,
        affectedTracks: affected.length,
        otherTracks: affected.filter(({ id }) => !selectedIds.has(id)).length,
        separateRecords,
        records: pair.map((kept) => {
          const source = pair.find(({ id }) => id !== kept.id)
          const moved = affected.filter((row) => ids(row).includes(source.id))
          const otherTracks = moved.filter(
            ({ id }) => !selectedIds.has(id),
          ).length
          return {
            ...kept,
            affectedTracks: moved.length,
            otherTracks,
            impact: `${label} links move on ${trackCount(moved.length)}${otherTracks ? `, including ${otherTracks} outside this selection` : ''}.`,
          }
        }),
      }
    })
  }

  function apply(state, rows, keptId, choices = {}) {
    const ids = new Set(rows.map(({ id }) => id))
    const selected = state.tracks.filter(({ id }) => ids.has(id))
    const kept = selected.find(({ id }) => id === keptId)
    if (
      keptId !== null &&
      (!kept || selected.length < 2 || trackConflict(selected))
    )
      return { state, effects: [] }

    const albumRedirect = new Map()
    const artistRedirect = new Map()
    const effects = []
    const parents = { albums: state.albums, artists: state.artists }
    for (const group of related(state, selected)) {
      if (group.status !== 'candidate') continue
      const target = group.records.find(({ id }) => id === choices[group.kind])
      if (!target) continue
      const source = group.records.find(({ id }) => id !== target.id)
      const redirect = group.kind === 'album' ? albumRedirect : artistRedirect
      redirect.set(source.id, target.id)
      const key = `${group.kind}s`
      parents[key] = parents[key].flatMap((row) => {
        if (row.id === source.id) return []
        if (row.id !== target.id) return [row]
        return [
          {
            ...row,
            originalNames: unique([
              ...row.originalNames,
              ...source.originalNames,
            ]),
            originalSources: unique([
              ...(row.originalSources ?? [row.detail]),
              ...(source.originalSources ?? [source.detail]),
            ]),
          },
        ]
      })
      effects.push(target.impact)
    }
    if (!kept && !effects.length) return { state, effects }

    const mapId = (redirect, id) => redirect.get(id) ?? id
    const mapLinks = (row) => ({
      ...row,
      albumIds: unique(row.albumIds.map((id) => mapId(albumRedirect, id))),
      credits: uniqueBy(
        row.credits.map((credit) => ({
          ...credit,
          id: mapId(artistRedirect, credit.id),
        })),
        ({ id, role }) => JSON.stringify([id, role]),
      ),
      positions: uniqueBy(
        row.positions.map((position) => ({
          ...position,
          id: mapId(albumRedirect, position.id),
        })),
        ({ id, number }) => JSON.stringify([id, number]),
      ),
    })
    let tracks = state.tracks.map(mapLinks)
    if (kept) {
      const selected = tracks.filter(({ id }) => ids.has(id))
      const survivor = selected.find(({ id }) => id === keptId)
      const ordered = [survivor, ...selected.filter(({ id }) => id !== keptId)]
      const catalog = ordered.find(({ spotify }) => spotify)
      const merged = mapLinks({
        ...survivor,
        ...(catalog && {
          spotify: catalog.spotify,
          seed: catalog.seed,
          art: catalog.art,
        }),
        albumIds: ordered.flatMap(({ albumIds }) => albumIds),
        credits: ordered.flatMap(({ credits }) => credits),
        positions: ordered.flatMap(({ positions }) => positions),
        plays: unique(ordered.flatMap(({ plays }) => plays)),
        sources: unique(ordered.flatMap(({ sources }) => sources)),
        originalNames: unique(
          ordered.flatMap(({ originalNames }) => originalNames),
        ),
      })
      tracks = tracks.flatMap((row) =>
        row.id === keptId ? [merged] : ids.has(row.id) ? [] : [row],
      )
    }
    return { state: withLabels({ ...parents, tracks, selected: [] }), effects }
  }

  window.TrackMergeExamples = { examples, load, related, trackConflict, apply }
})()
