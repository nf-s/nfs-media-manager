import { updateJobSelection } from './job-selection'

/**
 * A table's selection: ticked rows by ID, or (PL-30) the whole result of the
 * view less the rows unticked since. `identity` names the view; a selection
 * made in another view reads as empty.
 */
export type RowSelectionState = {
  identity: string
  ids: string[]
  anchor: string | null
  matching: {
    /** How many rows the result held when it was selected. */
    total: number
    excluded: string[]
    /** Of `excluded`, the rows that were outside the library. */
    outside: string[]
  } | null
}

/** The rows a table has for its selection. */
export type SelectionRows = {
  /** The rows the table has, in display order. */
  ordered: readonly string[]
  /**
   * Where the whole result can be selected: the rows of the result the table
   * has (not, say, a recording's release versions) and the result's count once
   * known.
   */
  result?: { ids: readonly string[]; total?: number }
  /** Loaded rows outside the library. */
  outside?: readonly string[]
}

export function emptyRowSelection(identity = ''): RowSelectionState {
  return { identity, ids: [], anchor: null, matching: null }
}

/** The selection for a view: empty when it was made in another. */
export function rowSelectionFor(state: RowSelectionState, identity: string) {
  return state.identity === identity ? state : emptyRowSelection(identity)
}

/** What a table shows and offers for a selection. */
export function describeRowSelection(
  state: RowSelectionState,
  rows: SelectionRows,
) {
  const { matching } = state
  const resultIds = rows.result?.ids ?? []
  const inResult = new Set(resultIds)
  const excluded = new Set(matching?.excluded)
  const picked = new Set(state.ids)
  const has = (id: string) =>
    matching ? inResult.has(id) && !excluded.has(id) : picked.has(id)
  // Release versions are not part of the result, so a whole-result selection
  // is judged on the result's rows.
  const header = matching ? resultIds : rows.ordered
  const shown = header.filter(has).length
  const all = header.length > 0 && shown === header.length
  const total = rows.result?.total ?? matching?.total
  const everyMatch = matching !== null && matching.excluded.length === 0
  return {
    /** The ticked rows; none while the whole result is selected. */
    ids: state.ids,
    count: matching
      ? Math.max(0, (total ?? 0) - matching.excluded.length)
      : state.ids.length,
    /** How many rows the result holds, once counted. */
    total,
    has,
    /** Every row the table has is selected. */
    all,
    /** Some of the table's rows are selected. */
    some: shown > 0 && shown < header.length,
    /** The whole result is selected, less `excludeIds`. */
    matching: matching !== null,
    /** The whole result is selected and no row is unticked. */
    everyMatch,
    excludeIds: matching?.excluded ?? [],
    /** Of `excludeIds`, how many were outside the library. */
    outsideExcluded: matching?.outside.length ?? 0,
    /** Select all matching can be offered: there is a result not all selected. */
    canSelectMatching:
      rows.result !== undefined &&
      rows.result.total !== undefined &&
      rows.result.total > 0 &&
      !everyMatch,
    /** Every loaded row is ticked and more match than are ticked. */
    offerMatching:
      matching === null &&
      rows.result?.total !== undefined &&
      all &&
      rows.result.total > state.ids.length,
    /** A row outside the result cannot be ticked into a whole-result selection. */
    selectable: (id: string) => !matching || inResult.has(id),
  }
}

/** Ticks or unticks a row; with shift, the range from the last one. */
export function toggleRow(
  state: RowSelectionState,
  rows: SelectionRows,
  id: string,
  checked: boolean,
  shift: boolean,
): RowSelectionState {
  const { matching } = state
  if (!matching)
    return {
      ...state,
      ids: updateJobSelection(
        state.ids,
        [...rows.ordered],
        id,
        state.anchor,
        shift,
        checked,
      ),
      anchor: id,
    }
  const resultIds = [...(rows.result?.ids ?? [])]
  const excluded = new Set(matching.excluded)
  const ticked = new Set(
    updateJobSelection(
      resultIds.filter((row) => !excluded.has(row)),
      resultIds,
      id,
      state.anchor,
      shift,
      checked,
    ),
  )
  for (const row of resultIds)
    if (ticked.has(row)) excluded.delete(row)
    else excluded.add(row)
  const outside = new Set([...matching.outside, ...(rows.outside ?? [])])
  const next = [...excluded]
  return {
    ...state,
    anchor: id,
    matching: {
      ...matching,
      excluded: next,
      outside: next.filter((row) => outside.has(row)),
    },
  }
}

/**
 * The header checkbox. Ticked, it selects the loaded rows (and takes them
 * back into a whole-result selection); unticked, it unticks them, or clears
 * a whole-result selection.
 */
export function setLoadedRows(
  state: RowSelectionState,
  rows: SelectionRows,
  checked: boolean,
): RowSelectionState {
  const { matching } = state
  if (matching) {
    if (!checked) return emptyRowSelection(state.identity)
    const loaded = new Set(rows.result?.ids)
    const excluded = matching.excluded.filter((id) => !loaded.has(id))
    return {
      ...state,
      anchor: null,
      matching: {
        ...matching,
        excluded,
        outside: matching.outside.filter((id) => excluded.includes(id)),
      },
    }
  }
  const loaded = new Set(rows.ordered)
  return {
    ...state,
    ids: checked
      ? [...new Set([...state.ids, ...rows.ordered])]
      : state.ids.filter((id) => !loaded.has(id)),
    anchor: null,
  }
}

/** Select all matching: the whole result of the view (PL-30). */
export function selectMatchingRows(
  state: RowSelectionState,
  rows: SelectionRows,
): RowSelectionState {
  const total = rows.result?.total
  if (total === undefined) return state
  return {
    ...state,
    ids: [],
    anchor: null,
    matching: { total, excluded: [], outside: [] },
  }
}

/** Ticks exactly these rows, as when a merge comes back as the selection. */
export function replaceRows(
  state: RowSelectionState,
  ids: string[],
): RowSelectionState {
  return { ...state, ids, anchor: null, matching: null }
}
