import { applyFilters, applySort } from "data-types";
import { useMemo } from "react";
import { ColumnsConfig, isNumericCol } from "./Columns.js";
import { FilterState } from "./FilterState.js";
import { ColumnState } from "./ColumnState.js";

export interface RowState<T> {
  rows: T[];
}

export function useRowState<T>(
  columnsConfig: ColumnsConfig<T>,
  rows: T[],
  sortState: ColumnState<T>,
  filterState: FilterState<T>
): RowState<T> {
  const processedRows = useMemo(() => {
    return rows.map((row) => {
      columnsConfig.data.forEach((col) => {
        if (
          isNumericCol(col) &&
          typeof col.default !== "undefined" &&
          typeof row[col.key] === "undefined"
        ) {
          row[col.key] = col.default as any;
        }
      });
      return row;
    });
  }, [rows, columnsConfig]);

  const sortedRows = useMemo(() => {
    if (sortState.sortColumn && sortState.sortDirection)
      return applySort(processedRows, [
        sortState.sortColumn,
        sortState.sortDirection,
      ]);
    else return processedRows;
  }, [processedRows, sortState.sortColumn, sortState.sortDirection]);

  const filteredRows = useMemo(() => {
    if (
      (!filterState.activeFilters || filterState.activeFilters.length === 0) &&
      filterState.activeNumericFilters.length === 0
    )
      return sortedRows;

    return applyFilters(sortedRows, [
      ...(filterState.activeFilters ?? []),
      ...filterState.activeNumericFilters,
    ]);
  }, [sortedRows, filterState.activeFilters, filterState.activeNumericFilters]);

  return { rows: filteredRows };
}
