import { NumericFilterValue, TextFilterValue } from "data-types";
import { createContext, useEffect, useMemo, useReducer, useState } from "react";
import {
  ColumnsConfig,
  FilterCol,
  NumericCol,
  getFilterCols,
  getNumericCols,
} from "./Columns.js";

export type TextFilterValueWithLabel<T> = TextFilterValue<T> & {
  label: string;
  count: number;
};

export interface NumericFilterData<T> {
  col: NumericCol<T>;
  min: number;
  max: number;
}
export interface FilterState<T> {
  filterData: TextFilterValueWithLabel<T>[] | undefined;
  activeFilters: TextFilterValueWithLabel<T>[] | undefined;
  activeFiltersDispatch: React.Dispatch<FilterDispatchActions<T>>;
  numericFilterData: NumericFilterData<T>[] | undefined;
  activeNumericFilters: NumericFilterValue<T>[];
  activeNumericFiltersDispatch: React.Dispatch<NumericFilterDispatchActions<T>>;
}

type FilterDispatchActions<T> =
  | { type: "add"; value: TextFilterValueWithLabel<T> }
  | { type: "clear" }
  | { type: "set"; values: TextFilterValueWithLabel<T>[] };

type NumericFilterDispatchActions<T> =
  | { type: "add"; value: NumericFilterValue<T> }
  | { type: "clear" }
  | { type: "set"; values: NumericFilterValue<T>[] };

export const FilterStateContext = createContext<FilterState<any> | undefined>(
  undefined
);

export function useFilterState<T>(
  tag: string,
  rows: T[],

  columnsConfig: ColumnsConfig<T>
): FilterState<T> {
  const [filterData, setFilterData] = useState<
    TextFilterValueWithLabel<T>[] | undefined
  >(undefined);

  const [activeFilters, activeFiltersDispatch] = useReducer(
    filterReducer<T>,
    undefined
  );

  const [activeNumericFilters, activeNumericFiltersDispatch] = useReducer(
    filterNumericReducer<T>,
    []
  );

  const [numericFilterData, setNumericFilterData] =
    useState<NumericFilterData<T>[]>();

  // Set filterData
  useMemo(() => {
    if (rows.length === 0) return;
    const filters = getFilterCols(columnsConfig.data)
      .reduce<TextFilterValueWithLabel<T>[]>(
        (acc, curr) => [...acc, ...getColumnWithTotals(rows, curr)],
        []
      )
      .sort((a, b) => b.count - a.count);

    setFilterData(filters);
  }, [rows, columnsConfig.data, setFilterData]);

  // Set numericFilterData
  useMemo(() => {
    const numericFilters = getNumericCols(columnsConfig.data).map((numCol) => ({
      col: numCol,
      max:
        numCol.max ??
        Math.max(...rows.map((r) => r[numCol.key] ?? (-Infinity as any))),
      min:
        numCol.min ??
        Math.min(...rows.map((r) => r[numCol.key] ?? (Infinity as any))),
    }));

    setNumericFilterData(numericFilters);
  }, [columnsConfig.data, rows]);

  // Get activeFilters from localStorage
  useEffect(() => {
    if (!filterData) return;

    // TODO add validation
    const savedActiveFilters = localStorage.getItem(`${tag}-activeFilters`)
      ? JSON.parse(localStorage.getItem(`${tag}-activeFilters`)!)
      : undefined;
    if (Array.isArray(savedActiveFilters)) {
      const found = savedActiveFilters.filter((a) =>
        filterData.find((b) => a.field === b.field && a.value === b.value)
      );
      activeFiltersDispatch({ type: "set", values: found });
    }
  }, [filterData, tag]);

  // Save activeFilters to localStorage
  useEffect(() => {
    if (!activeFilters) return;

    localStorage.setItem(`${tag}-activeFilters`, JSON.stringify(activeFilters));
  }, [activeFilters, tag]);

  return {
    filterData,
    activeFilters,
    activeFiltersDispatch,
    numericFilterData,
    activeNumericFilters,
    activeNumericFiltersDispatch,
  };
}

function filterReducer<T>(
  state: TextFilterValueWithLabel<T>[] | undefined,
  action: FilterDispatchActions<T>
): TextFilterValueWithLabel<T>[] | undefined {
  switch (action.type) {
    case "add": {
      if (!state) {
        return [action.value];
      }
      const index = state.findIndex(
        (filterValue) =>
          filterValue.field === action.value.field &&
          filterValue.value === action.value.value
      );
      if (index === -1) {
        return [...state, action.value];
      } else {
        return [
          ...state.slice(0, index),
          action.value,
          ...state.slice(index + 1),
        ];
      }
    }
    case "set":
      return action.values;
    case "clear":
      return [];
  }
}

export function addFilter<T>(
  filterState: FilterState<T>,
  value: TextFilterValue<T>
) {
  if (!filterState) return;

  const found = filterState.filterData?.find(
    (f) => f.field === value.field && f.value === value.value
  );
  if (found) filterState.activeFiltersDispatch({ type: "add", value: found });
}

function filterNumericReducer<T>(
  state: NumericFilterValue<T>[],
  action: NumericFilterDispatchActions<T>
): NumericFilterValue<T>[] {
  switch (action.type) {
    case "add": {
      return [
        ...state.filter((f) => f.field !== action.value.field),
        { ...action.value },
      ];
    }
    case "set":
      return action.values;
    case "clear":
      return [];
  }
}

/** Returns all unique values for a given column, with a total/count */
function getColumnWithTotals<K>(
  rows: K[],
  filterCol: FilterCol<K>,
  sort: "key" | "value" = "key"
): TextFilterValueWithLabel<K>[] {
  const total = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const value = rows[i][filterCol.key];
    const values =
      typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (let j = 0; j < values.length; j++) {
      total.set(values[j], (total.get(values[j]) ?? 0) + 1);
    }
  }

  let totalArray = Array.from(total).sort((a, b) =>
    (a[0] ?? "").localeCompare(b[0] ?? "")
  );

  if (sort === "value") {
    totalArray = totalArray.sort((a, b) => a[1] - b[1]);
  }

  return totalArray.map((r) => ({
    label: `${filterCol.name}: ${
      filterCol.filterLabel ? filterCol.filterLabel(r[0]) : r[0]
    } (${r[1]})`,
    value: r[0],
    count: r[1],
    field: filterCol.key,
  }));
}
