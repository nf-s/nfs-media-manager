import { Index } from "flexsearch";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { OptionsType } from "react-select";
import {
  BooleanCol,
  BooleanColKey,
  FilterColKey,
  getColumnWithTotals,
  NumericCol,
  NumericColKey,
} from "./Columns";

export type FilterValue<T> = {
  label: string;
  value: string;
  field: FilterColKey<T>;
};

export type NumericFilterValue<T> = {
  min: number;
  max: number;
  field: NumericColKey<T>;
};

export type BooleanFilterValue<T> = {
  value: true | false | undefined;
  field: BooleanColKey<T>;
};

type SelectValues<T> = OptionsType<FilterValue<T>>;

export function useNumericFilter<T>(cols: NumericCol<T>[]) {
  function filterNumericReducer(
    state: NumericFilterValue<T>[],
    action:
      | ({ type: "add" } & NumericFilterValue<T>)
      | { type: "clear" }
      | { type: "set"; values: NumericFilterValue<T>[] }
  ): NumericFilterValue<T>[] {
    switch (action.type) {
      case "add":
        const found = cols.find((a) => a.key === action.field);
        if (found) {
          return [
            ...state.filter((f) => f.field !== action.field),
            { field: action.field, min: action.min, max: action.max },
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
    (field: NumericColKey<T>, min: number, max: number) => {
      setActiveNumericFilters({ type: "add", field, min, max });
    },
    []
  );

  return { activeNumericFilters, addNumericFilter };
}

export function useBooleanFilter<T>(cols: BooleanCol<T>[]) {
  function filterBooleanReducer(
    state: BooleanFilterValue<T>[],
    action:
      | ({ type: "add" } & BooleanFilterValue<T>)
      | { type: "clear" }
      | { type: "set"; values: BooleanFilterValue<T>[] }
  ): BooleanFilterValue<T>[] {
    switch (action.type) {
      case "add":
        const found = cols.find((a) => a.key === action.field);
        if (found) {
          return [
            ...state.filter((f) => f.field !== action.field),
            { field: action.field, value: action.value },
          ];
        }
        return state;
      case "set":
        return action.values;
      case "clear":
        return [];
    }
  }

  const [activeBooleanFilters, setActiveBooleanFilters] = useReducer(
    filterBooleanReducer,
    []
  );

  const addBooleanFilter = useCallback(
    (field: BooleanColKey<T>, value: boolean | undefined) => {
      setActiveBooleanFilters({ type: "add", field, value });
    },
    []
  );

  return { activeBooleanFilters, addBooleanFilter };
}

export function useTextFilter<T>(
  filterCols: FilterColKey<T>[],
  rows: T[],
  tag: string
) {
  const [filterData, setFilterData] = useState<{
    filters: FilterValue<T>[];
  }>({ filters: [] });

  const filterSearchIndex = useMemo(() => {
    const index = new Index({ tokenize: "full", preset: "score" });

    for (let i = 0; i < filterData.filters.length; i++) {
      const filter = filterData.filters[i];
      index.add(i, filter.value);
    }

    return index;
  }, [filterData]);

  const [filterInputValue, setFilterInputValue] = useState("");

  const filteredOptions: FilterValue<T>[] = useMemo(() => {
    if (!filterInputValue || !filterSearchIndex) {
      return filterData.filters;
    }

    const searchResults = filterSearchIndex.search(filterInputValue);

    const results: FilterValue<T>[] = [];

    searchResults.forEach((fieldResult) => {
      if (typeof fieldResult === "number" && filterData.filters[fieldResult]) {
        results.push(filterData.filters[fieldResult]);
      }
    });

    return results;
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

  const addFilter = useCallback((field: keyof T, value: string) => {
    setActiveFilters({ type: "add", field, value });
  }, []);

  const setFilters = useCallback((filter: SelectValues<T>) => {
    setActiveFilters({ type: "set", values: filter });
  }, []);

  useEffect(() => {
    if (rows.length === 0) return;
    const filters = filterCols.reduce<FilterValue<T>[]>(
      (acc, curr) => [...acc, ...getColumnWithTotals(rows, curr)],
      []
    );

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
  }, [rows, filterCols, setFilterData, setFilters, tag]);

  useEffect(() => {
    if (!activeFilters) return;
    localStorage.setItem(`${tag}-activeFilters`, JSON.stringify(activeFilters));
  }, [activeFilters, tag]);

  return {
    activeFilters,
    addFilter,
    setFilters,
    slicedOptions,
    filterInputValue,
    setFilterInputValue,
  };
}
