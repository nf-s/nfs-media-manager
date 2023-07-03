import React, { useEffect, useMemo, useState } from "react";
import { Column } from "react-data-grid";
import { applyFilters, applySort, NumericColKey, SortValue } from "data-types";
import { NumericFilter } from "./ColumnFilters.jsx";
import {
  BooleanField,
  DataColumn,
  FieldRenderer,
  getNumericCols,
  isBooleanCol,
  isNumericCol,
  NumericField,
} from "./Columns.jsx";
import { useNumericFilter, useTextFilter } from "./FilterState.js";

export type ColumnWithFieldRenderer<T> = Readonly<
  Column<T> & {
    fieldRenderer?: FieldRenderer<T>;
  }
>;

export function useColumnState<T>(
  tag: string,
  rows: T[],
  defaultSort: SortValue<T>,
  defaultVisible: (keyof T | "Controls")[],
  dataColumns: DataColumn<T>[],
  customColumns?: ColumnWithFieldRenderer<T>[]
) {
  const [[sortColumn, sortDirection], setSort] = useState<SortValue<T>>(
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
        Math.max(...rows.map((r) => r[numCol.key] ?? (-Infinity as any)))
      );

      minimums.set(
        numCol.key,
        Math.min(...rows.map((r) => r[numCol.key] ?? (Infinity as any)))
      );
    });

    const columns: ColumnWithFieldRenderer<T>[] = [
      ...(customColumns ?? []),
      ...dataColumns.map((col) => {
        if (isNumericCol(col)) {
          const min = minimums.get(col.key);
          const max = maximums.get(col.key);
          if (col.generateMaximumFromData) {
            col.max = max;
          }
          console.log(`Numeric ${col.key as any}`);
          const resolvedCol: ColumnWithFieldRenderer<T> = {
            key: col.key.toString(),
            name: col.name !== "" ? col.name : col.key.toString(),
            sortable: col.sortable ?? true,
            resizable: col.resizable ?? true,
            width: col.width ?? 80,
            fieldRenderer: NumericField(col),
            renderHeaderCell: (props) => (
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
          renderCell: (props) =>
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

  const processedRows = useMemo(() => {
    return rows.map((row) => {
      dataColumns.forEach((col) => {
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
  }, [rows, dataColumns]);

  const sortedRows = useMemo(() => {
    return applySort(processedRows, [sortColumn, sortDirection]);
  }, [processedRows, sortDirection, sortColumn]);

  const filteredRows = useMemo(() => {
    if (
      (!activeFilters || activeFilters.length === 0) &&
      activeNumericFilters.length === 0
    )
      return sortedRows;

    return applyFilters(sortedRows, [
      ...(activeFilters ?? []),
      ...activeNumericFilters,
    ]);
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
    activeNumericFilters,
  };
}
