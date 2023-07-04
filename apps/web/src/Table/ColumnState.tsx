import {
  IdColKey,
  NumericColKey,
  SortValue,
  applyFilters,
  applySort,
} from "data-types";
import React, { useEffect, useMemo, useState } from "react";
import { Column } from "react-data-grid";
import { PickProperties } from "ts-essentials";
import { NumericFilter } from "./ColumnFilters.jsx";
import {
  BooleanField,
  DataColumn,
  DataColumnKey,
  FieldRenderer,
  NumericField,
  getNumericCols,
  isBooleanCol,
  isNumericCol,
} from "./Columns.jsx";
import { useNumericFilter, useTextFilter } from "./FilterState.js";

export type GridButtonsFC<T> = React.FC<{ row: T }>;

export type GridConfig<T> = {
  readonly width: number;
  readonly height: number;
  readonly art?: keyof PickProperties<T, string | undefined>;
  /** maximum of 3 columns */ readonly cols: [
    DataColumnKey<T>,
    DataColumnKey<T>,
    DataColumnKey<T>
  ];
  buttons?: GridButtonsFC<T>;
};

export interface ColumnsConfig<T> {
  data: DataColumn<T>[];
  custom?: ColumnWithFieldRenderer<T>[];
  grid: GridConfig<T>;
  id: IdColKey<T>;
  defaultSort: SortValue<T>;
  defaultVisible: (keyof T | "Controls")[];
}

export type ColumnWithFieldRenderer<T> = Readonly<
  Column<T> & {
    fieldRenderer?: FieldRenderer<T>;
  }
>;

export function useColumnState<T>(
  tag: string,
  rows: T[],
  columnsConfig: ColumnsConfig<T>
) {
  const [[sortColumn, sortDirection], setSort] = useState<SortValue<T>>(
    localStorage.getItem(`${tag}-sortColumn`) &&
      localStorage.getItem(`${tag}-sortDirection`)
      ? ([
          localStorage.getItem(`${tag}-sortColumn`),
          localStorage.getItem(`${tag}-sortDirection`),
        ] as any)
      : columnsConfig.defaultSort
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
  } = useTextFilter<T>(columnsConfig.data, rows, tag);

  const { activeNumericFilters, addNumericFilter } = useNumericFilter<T>(
    columnsConfig.data
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
    const maximums = new Map<NumericColKey<T>, number>();
    const minimums = new Map<NumericColKey<T>, number>();

    getNumericCols(columnsConfig.data).forEach((numCol) => {
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
      ...(columnsConfig.custom ?? []),
      ...columnsConfig.data.map((col) => {
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
        columns.filter((c) =>
          columnsConfig.defaultVisible.includes(c.key as any)
        )
      );
    }

    setColumns(columns);
  }, [rows, columnsConfig, addFilter, tag, addNumericFilter]);

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
