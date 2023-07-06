import { applySort, applyFilters } from "data-types";
import { useMemo } from "react";
import { ColumnsConfig } from "./ColumnState.js";
import { isNumericCol } from "./Columns.js";
import { SortState } from "./SortState.js";
import { FilterState } from "./FilterState.js";

export interface RowState<T> {
  rows: T[];
}

export function useRowState<T>(
  columnsConfig: ColumnsConfig<T>,
  rows: T[],
  sortState: SortState<T>,
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
    return applySort(processedRows, [sortState.column, sortState.direction]);
  }, [processedRows, sortState.column, sortState.direction]);

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
