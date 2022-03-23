import React, { useEffect, useMemo, useState } from "react";
import { Column, SortDirection } from "react-data-grid";
import {
  BooleanCol,
  BooleanField,
  FieldRenderer,
  FilterCol,
  NumericCol,
  NumericColKey,
  NumericField,
  StringCol,
} from "./Columns";
import { BooleanFilter, NumericFilter } from "./Filters";
import {
  useBooleanFilter,
  useNumericFilter,
  useTextFilter,
} from "./FilterState";

export type ColumnWithFieldRenderer<T> = Column<T> & {
  fieldRenderer?: FieldRenderer<T>;
};

export function useRowState<T>(
  tag: string,
  rows: T[],
  filterCols: FilterCol<T>[],
  defaultSort: [keyof T, SortDirection],
  defaultVisible: (keyof T | "Controls")[],
  numericCols?: NumericCol<T>[],
  textColumns?: StringCol<T>[],
  booleanColumns?: BooleanCol<T>[],
  customColumns?: ColumnWithFieldRenderer<T>[]
) {
  const [[sortColumn, sortDirection], setSort] = useState<
    [keyof T, SortDirection]
  >(
    localStorage.getItem(`${tag}-sortColumn`) &&
      localStorage.getItem(`${tag}-sortDirection`)
      ? ([
          localStorage.getItem(`${tag}-sortColumn`),
          localStorage.getItem(`${tag}-sortDirection`),
        ] as any)
      : defaultSort
  );

  const [columns, setColumns] = useState<ColumnWithFieldRenderer<T>[]>([]);

  // Default value is set in fetchData
  const [visibleColumns, setVisibleColumns] = useState<Column<T>[]>();

  const {
    activeFilters,
    addFilter,
    setFilters,
    slicedOptions,
    filterInputValue,
    setFilterInputValue,
  } = useTextFilter<T>(filterCols, rows, tag);

  const { activeNumericFilters, addNumericFilter } = useNumericFilter<T>(
    numericCols ?? []
  );

  const { activeBooleanFilters, addBooleanFilter } = useBooleanFilter<T>(
    booleanColumns ?? []
  );

  useEffect(() => {
    localStorage.setItem(`${tag}-sortColumn`, sortColumn.toString());
  }, [sortColumn, tag]);

  useEffect(() => {
    localStorage.setItem(`${tag}-sortDirection`, sortDirection);
  }, [sortDirection, tag]);

  useEffect(() => {
    if (!visibleColumns) return;
    localStorage.setItem(
      `${tag}-visibleColumns`,
      JSON.stringify(visibleColumns.map((col) => col.key))
    );
  }, [visibleColumns, tag]);

  useEffect(() => {
    console.log("setColumns");
    const maximums = (numericCols ?? []).reduce(
      (map, numCol) =>
        map.set(
          numCol.key,
          Math.max(...rows.map((r) => r[numCol.key] ?? -Infinity))
        ),
      new Map<NumericColKey<T>, number>()
    );

    const minimums = (numericCols ?? []).reduce(
      (map, numCol) =>
        map.set(
          numCol.key,
          Math.min(...rows.map((r) => r[numCol.key] ?? Infinity))
        ),
      new Map<NumericColKey<T>, number>()
    );

    const columns: ColumnWithFieldRenderer<T>[] = [
      ...(customColumns ?? []),
      ...(textColumns ?? []),
      ...(booleanColumns ?? []).map((col) => {
        const resolvedCol: ColumnWithFieldRenderer<T> = {
          ...col,
          key: col.key.toString(),
          fieldRenderer: BooleanField(col),
          headerRenderer: (props) => (
            <BooleanFilter {...props} col={col} addFilter={addBooleanFilter} />
          ),
        };
        return resolvedCol;
      }),
      ...(numericCols ?? []).map((col) => {
        const min = minimums.get(col.key);
        const max = maximums.get(col.key);
        if (col.generateMaximumFromData) {
          col.max = max;
        }
        const resolvedCol: ColumnWithFieldRenderer<T> = {
          key: col.key.toString(),
          name: col.name !== "" ? col.name : col.key.toString(),
          sortable: col.sortable ?? true,
          resizable: col.resizable ?? true,
          width: col.width ?? 80,
          fieldRenderer: NumericField(col),
          headerRenderer: (props) => (
            <NumericFilter
              {...props}
              col={col}
              min={min}
              max={max}
              addFilter={addNumericFilter}
            />
          ),
        };

        return resolvedCol;
      }),
    ]
      .filter((col) => col)
      // If column has `fieldRenderer` (which isn't part of data-grid), translate it into `formatter` so it can be used in table-cells
      .map((col) => {
        if (
          "fieldRenderer" in col! &&
          col.fieldRenderer &&
          !("formatter" in col)
        ) {
          return {
            ...col,
            key: col.key.toString(),
            formatter: (props) =>
              col.fieldRenderer!({
                data: props.row,
                addFilter,
              }),
          };
        } else {
          return { ...col, key: col!.key.toString() };
        }
      });

    const savedVisibleColumns = localStorage.getItem(`${tag}-visibleColumns`)
      ? JSON.parse(localStorage.getItem(`${tag}-visibleColumns`)!)
      : undefined;
    if (Array.isArray(savedVisibleColumns)) {
      setVisibleColumns(
        columns.filter((c) => savedVisibleColumns.includes(c.key))
      );
    } else {
      setVisibleColumns(
        columns.filter((c) => defaultVisible.includes(c.key as any))
      );
    }

    setColumns(columns);
  }, [
    rows,
    numericCols,
    textColumns,
    addFilter,
    defaultVisible,
    tag,
    addNumericFilter,
    booleanColumns,
    addBooleanFilter,
    customColumns,
  ]);

  const sortedRows = useMemo(() => {
    let sortedRows = [...rows];

    const textSortKey = (textColumns ?? []).find(
      (col) => col.key === sortColumn
    )?.key;

    if (textSortKey) {
      sortedRows = sortedRows.sort((a, b) => {
        let text = a[textSortKey];
        text = Array.isArray(text) ? text[0] : text;
        return (text ?? "").localeCompare(b[sortColumn] ?? "");
      });
    }

    const numSortKey = (numericCols ?? []).find(
      (col) => col.key === sortColumn
    )?.key;

    if (numSortKey) {
      sortedRows = sortedRows
        .filter((a) => a[numSortKey] !== undefined)
        .sort((a, b) => a[numSortKey]! - b[numSortKey]!);
    }

    return sortDirection === "DESC" ? sortedRows.reverse() : sortedRows;
  }, [rows, sortDirection, sortColumn, numericCols, textColumns]);

  const filteredRows = useMemo(() => {
    if (
      (!activeFilters || activeFilters.length === 0) &&
      activeNumericFilters.length === 0 &&
      activeBooleanFilters.length === 0
    )
      return sortedRows;

    const filterdRows = new Set<T>();

    // Apply text filters (additive - union)
    for (let i = 0; i < sortedRows.length; i++) {
      let include = true;
      const row = sortedRows[i];
      if (activeFilters && activeFilters.length !== 0) {
        include = false;
        for (let j = 0; j < activeFilters.length; j++) {
          const filter = activeFilters[j];
          const rowValue = row[filter.col.key];
          if (
            (Array.isArray(rowValue) && rowValue.includes(filter.value)) ||
            (typeof rowValue === "string" && rowValue === filter.value)
          ) {
            include = true;
          }
        }
      }

      // Numeric and boolean filters are subtractive (intersecting)
      // Apply numeric filters
      for (let j = 0; j < activeNumericFilters.length; j++) {
        const filter = activeNumericFilters[j];
        const rowValue = row[filter.field];
        if (
          include &&
          ((typeof rowValue === "number" &&
            rowValue <= filter.max &&
            rowValue >= filter.min) ||
            (typeof rowValue === "undefined" && filter.includeUndefined))
        ) {
          continue;
        }

        include = false;
      }

      // Apply boolean filters
      for (let j = 0; j < activeBooleanFilters.length; j++) {
        const filter = activeBooleanFilters[j];

        if (
          typeof filter.value === "undefined" ||
          !!row[filter.field] === filter.value
        )
          continue;

        include = false;
      }

      if (include) {
        filterdRows.add(row);
      }
    }

    return Array.from(filterdRows);
  }, [sortedRows, activeFilters, activeNumericFilters, activeBooleanFilters]);

  return {
    columns,
    filteredRows,
    setFilters,
    slicedOptions,
    filterInputValue,
    setFilterInputValue,
    sortColumn,
    setSort,
    sortDirection,
    visibleColumns,
    setVisibleColumns,
    addFilter,
    activeFilters,
  };
}
