import React, { useEffect, useMemo, useState } from "react";
import { Column, SortDirection } from "react-data-grid";
import { NumericFilter } from "./ColumnFilters";
import {
  BooleanField,
  DataColumn,
  FieldRenderer,
  getNumericCols,
  getStringCols,
  isBooleanCol,
  isNumericCol,
  NumericColKey,
  NumericField,
} from "./Columns";
import { useNumericFilter, useTextFilter } from "./FilterState";

export type ColumnWithFieldRenderer<T> = Readonly<
  Column<T> & {
    fieldRenderer?: FieldRenderer<T>;
  }
>;

export function useColumnState<T>(
  tag: string,
  rows: T[],
  defaultSort: [keyof T, SortDirection],
  defaultVisible: (keyof T | "Controls")[],
  dataColumns: DataColumn<T>[],
  customColumns: ColumnWithFieldRenderer<T>[]
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
  } = useTextFilter<T>(dataColumns, rows, tag);

  const { activeNumericFilters, addNumericFilter } =
    useNumericFilter<T>(dataColumns);

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
    const maximums = new Map<NumericColKey<T>, number>();
    const minimums = new Map<NumericColKey<T>, number>();

    getNumericCols(dataColumns).forEach((numCol) => {
      maximums.set(
        numCol.key,
        Math.max(...rows.map((r) => r[numCol.key] ?? -Infinity))
      );

      minimums.set(
        numCol.key,
        Math.min(...rows.map((r) => r[numCol.key] ?? Infinity))
      );
    });

    const columns: ColumnWithFieldRenderer<T>[] = [
      ...customColumns,
      ...dataColumns.map((col) => {
        if (isNumericCol(col)) {
          const min = minimums.get(col.key);
          const max = maximums.get(col.key);
          // if (col.generateMaximumFromData) {
          //   col.max = max;
          // }
          console.log(`Numeric ${col.key}`);
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
        }

        if (isBooleanCol(col)) {
          const resolvedCol: ColumnWithFieldRenderer<T> = {
            ...col,
            key: col.key.toString(),
            fieldRenderer: BooleanField(col),
          };
          return resolvedCol;
        }

        // StringCol / FilterCol
        return {
          ...col,
          sortable: col.sortable ?? true,
          resizable: col.resizable ?? true,
        };
      }),
    ].map((col) => {
      // If column has `fieldRenderer` (which isn't part of data-grid), translate it into `formatter` so it can be used in table-cells
      if (
        "fieldRenderer" in col! &&
        col.fieldRenderer &&
        !("formatter" in col)
      ) {
        const resolvedCol: ColumnWithFieldRenderer<T> = {
          ...col,
          key: col.key.toString(),
          formatter: (props) =>
            col.fieldRenderer!({
              data: props.row,
              addFilter,
            }),
        };

        return resolvedCol;
      } else {
        return { ...col, key: col.key.toString() };
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
    dataColumns,
    addFilter,
    defaultVisible,
    tag,
    addNumericFilter,
    customColumns,
  ]);

  const sortedRows = useMemo(() => {
    let sortedRows = [...rows];

    const textSortKey = getStringCols(dataColumns).find(
      (col) => col.key === sortColumn
    )?.key;

    if (textSortKey) {
      sortedRows = sortedRows.sort((a, b) => {
        let text = a[textSortKey];
        text = Array.isArray(text) ? text[0] : text;
        return (text ?? "").localeCompare(b[sortColumn] ?? "");
      });
    }

    const numSortKey = getNumericCols(dataColumns).find(
      (col) => col.key === sortColumn
    )?.key;

    if (numSortKey) {
      sortedRows = sortedRows
        .filter((a) => a[numSortKey] !== undefined)
        .sort((a, b) => a[numSortKey]! - b[numSortKey]!);
    }

    return sortDirection === "DESC" ? sortedRows.reverse() : sortedRows;
  }, [rows, sortDirection, sortColumn, dataColumns]);

  const filteredRows = useMemo(() => {
    if (
      (!activeFilters || activeFilters.length === 0) &&
      activeNumericFilters.length === 0
    )
      return sortedRows;

    const filteredRows = new Set<T>();

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

      if (include) {
        filteredRows.add(row);
      }
    }

    return Array.from(filteredRows);
  }, [sortedRows, activeFilters, activeNumericFilters]);

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
