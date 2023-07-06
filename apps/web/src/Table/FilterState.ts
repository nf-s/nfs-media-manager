import { NumericFilterValue, TextFilterValue } from "data-types";
import { createContext, useEffect, useMemo, useReducer, useState } from "react";
import { ColumnsConfig } from "./ColumnState.js";
import { FilterCol, getFilterCols } from "./Columns.js";

export type TextFilterValueWithLabel<T> = TextFilterValue<T> & {
  label: string;
  count: number;
};

export interface FilterState<T> {
  filterData: TextFilterValueWithLabel<T>[];
  activeFilters: TextFilterValue<T>[];
  activeFiltersDispatch: React.Dispatch<
  FilterDispatchActions<T>
  >;
  activeNumericFilters: NumericFilterValue<T>[];
  activeNumericFiltersDispatch: React.Dispatch<
  NumericFilterDispatchActions<T>
  >;
}

type FilterDispatchActions<T> =
  | { type: "add"; value: TextFilterValue<T> }
  | { type: "clear" }
  | { type: "set"; values: TextFilterValue<T>[] }


  type NumericFilterDispatchActions<T> =
  | ({ type: "add" } & NumericFilterValue<T>)
  | { type: "clear" }
  | { type: "set"; values: NumericFilterValue<T>[] }

  export const FilterStateContext = createContext<FilterState<any> | undefined>(
    undefined
  );

export function useFilterState<T>(tag: string, rows: T[],

  columnsConfig: ColumnsConfig<T>): FilterState<T> {
  const [filterData, setFilterData] = useState<TextFilterValueWithLabel<T>[]>(
    []
  );
  
  const [activeFilters, activeFiltersDispatch] = useReducer(
    filterReducer<T>,
    []
  );

  useMemo(() => {
    if (rows.length === 0) return;
    const filters = getFilterCols(columnsConfig.data)
      .reduce<TextFilterValueWithLabel<T>[]>(
        (acc, curr) => [...acc, ...getColumnWithTotals(rows, curr)],
        []
      )
      .sort((a, b) => b.count - a.count);

    setFilterData(filters);
  }, [rows, columnsConfig, setFilterData]);

  // useEffect(() => {
    
  //   if (filterData.length === 0) return;

  //   console.log("set form localstorage");

  //   // Get saved filters from local storage
  //   const savedActiveFilters = localStorage.getItem(`${tag}-activeFilters`)
  //   ? JSON.parse(localStorage.getItem(`${tag}-activeFilters`)!)
  //   : undefined;

  //   console.log(savedActiveFilters);

  //   if (Array.isArray(savedActiveFilters)) {
      
  //     const found = filterData.filter((a) =>
  //       savedActiveFilters.find(
  //         (b) => a.field === b.field && a.value === b.value
  //       )
  //     );
  //     activeFiltersDispatch({type:"set", values:found});
  //   }
  // }, [filterData, tag])

  useEffect(() => {
    if (!activeFilters) return;
    console.log("set to localstorage");
    localStorage.setItem(`${tag}-activeFilters`, JSON.stringify(activeFilters));
  }, [activeFilters, tag]);

  const [activeNumericFilters, activeNumericFiltersDispatch] = useReducer(
    filterNumericReducer<T>,
    []
  );

  return {
    filterData,
    activeFilters,
    activeFiltersDispatch,
    activeNumericFilters,
    activeNumericFiltersDispatch,
  };
}

// Default value is set in fetchData
function filterReducer<T>(
  state: TextFilterValue<T>[],
  action:
  FilterDispatchActions<T>
): TextFilterValue<T>[] {
  switch (action.type) {
    case "add": {
      if (!state) {
        return [action.value]
      }
      const index = state.findIndex(filterValue => filterValue.field === action.value.field && filterValue.value === action.value.value)
      if (index === -1) {
        return [...state, action.value]
      } else {
        return [...state.slice(0, index), action.value, ...state.slice(index+1)]
      }
    }
    case "set":
      return action.values;
    case "clear":
      return [];
  }
}
function filterNumericReducer<T>(
  state: NumericFilterValue<T>[],
  action:
  NumericFilterDispatchActions<T>
): NumericFilterValue<T>[] {
  switch (action.type) {
    case "add": {
      return [...state.filter((f) => f.field !== action.field), { ...action }];
    }
    case "set":
      return action.values;
    case "clear":
      return [];
  }
}

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
