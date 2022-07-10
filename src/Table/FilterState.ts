import { Index } from "flexsearch";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { OptionsType } from "react-select";
import {
  NumericColKey,
  NumericFilterValue,
  TextFilterValue,
} from "nfs-media-scraper/src/types/fields";
import { useTraceUpdate } from "../Common/util";
import {
  DataColumn,
  FilterCol,
  getFilterCols,
  getNumericCols,
} from "./Columns";

type TextFilterValueWithLabel<T> = TextFilterValue<T> & {
  label: string;
  count: number;
};

type SelectValues<T> = OptionsType<TextFilterValueWithLabel<T>>;

export function useNumericFilter<T>(dataColumns: DataColumn<T>[] | undefined) {
  function filterNumericReducer(
    state: NumericFilterValue<T>[],
    action:
      | ({ type: "add" } & NumericFilterValue<T>)
      | { type: "clear" }
      | { type: "set"; values: NumericFilterValue<T>[] }
  ): NumericFilterValue<T>[] {
    switch (action.type) {
      case "add":
        const found = getNumericCols(dataColumns).find(
          (a) => a.key === action.field
        );
        if (found) {
          return [
            ...state.filter((f) => f.field !== action.field),
            { ...action },
          ];
        }
        return state;
      case "set":
        return action.values;
      case "clear":
        return [];
    }
  }

  const [activeNumericFilters, setActiveNumericFilters] = useReducer(
    filterNumericReducer,
    []
  );

  const addNumericFilter = useCallback(
    (
      field: NumericColKey<T>,
      min: number,
      max: number,
      includeUndefined: boolean
    ) => {
      setActiveNumericFilters({
        type: "add",
        field,
        min,
        max,
        includeUndefined,
      });
    },
    []
  );

  return { activeNumericFilters, addNumericFilter };
}

export type AddFilter<T> = (field: keyof T, value: string) => void;

export function useTextFilter<T>(
  dataColumns: DataColumn<T>[] | undefined,
  rows: T[],
  tag: string
) {
  const [filterData, setFilterData] = useState<{
    filters: TextFilterValueWithLabel<T>[];
  }>({ filters: [] });

  const filterSearchIndex = useMemo(() => {
    const index = new Index({ tokenize: "full", preset: "score" });

    for (let i = 0; i < filterData.filters.length; i++) {
      const filter = filterData.filters[i];
      index.add(i, filter.label ?? filter.value);
    }

    return index;
  }, [filterData]);

  const [filterInputValue, setFilterInputValue] = useState("");

  const filteredOptions: TextFilterValueWithLabel<T>[] = useMemo(() => {
    if (!filterInputValue || !filterSearchIndex) {
      return filterData.filters;
    }

    const searchResults = filterSearchIndex.search(filterInputValue);

    const results: TextFilterValueWithLabel<T>[] = [];

    searchResults.forEach((fieldResult) => {
      if (typeof fieldResult === "number" && filterData.filters[fieldResult]) {
        results.push(filterData.filters[fieldResult]);
      }
    });

    return results.sort((a, b) => b.count - a.count);
  }, [filterInputValue, filterSearchIndex, filterData.filters]);

  const slicedOptions = useMemo(() => {
    return filteredOptions.slice(0, 500);
  }, [filteredOptions]);

  // Default value is set in fetchData
  function filterReducer(
    state: SelectValues<T> | undefined,
    action:
      | { type: "add"; field: keyof T; value: string }
      | { type: "clear" }
      | { type: "set"; values: SelectValues<T> }
  ): SelectValues<T> | undefined {
    switch (action.type) {
      case "add":
        const found = filterData.filters.find(
          (a) => a.field === action.field && a.value === action.value
        );
        if (found) {
          return Array.from(new Set([...(state ?? []), found]));
        }
        return state;
      case "set":
        return action.values;
      case "clear":
        return [];
    }
  }

  const [activeFilters, setActiveFilters] = useReducer(
    filterReducer,
    undefined
  );

  const addFilter: AddFilter<T> = useCallback(
    (field: keyof T, value: string) => {
      setActiveFilters({ type: "add", field, value });
    },
    []
  );

  const setFilters = useCallback((filter: SelectValues<T>) => {
    setActiveFilters({ type: "set", values: filter });
  }, []);

  useEffect(() => {
    if (rows.length === 0) return;
    const filters = getFilterCols(dataColumns)
      .reduce<TextFilterValueWithLabel<T>[]>(
        (acc, curr) => [...acc, ...getColumnWithTotals(rows, curr)],
        []
      )
      .sort((a, b) => b.count - a.count);

    // Get saved filters from local storage
    const savedActiveFilters = localStorage.getItem(`${tag}-activeFilters`)
      ? JSON.parse(localStorage.getItem(`${tag}-activeFilters`)!)
      : undefined;

    if (Array.isArray(savedActiveFilters)) {
      const found = filters.filter((a) =>
        savedActiveFilters.find(
          (b) => a.field === b.field && a.value === b.value
        )
      );
      setFilters(found);
    }

    setFilterData({
      filters,
    });
  }, [rows, dataColumns, setFilterData, setFilters, tag]);

  useEffect(() => {
    if (!activeFilters) return;
    localStorage.setItem(`${tag}-activeFilters`, JSON.stringify(activeFilters));
  }, [activeFilters, tag]);

  useTraceUpdate({
    activeFilters,
    addFilter,
    setFilters,
    slicedOptions,
    filterInputValue,
    setFilterInputValue,
  });

  return {
    activeFilters,
    addFilter,
    setFilters,
    slicedOptions,
    filterInputValue,
    setFilterInputValue,
  };
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
