import { IdColKey, NumericColKey, SortValue } from "data-types";
import React, { createContext, useEffect, useMemo, useState } from "react";
import { Column } from "react-data-grid";
import { PickProperties } from "ts-essentials";
import { ColumnFieldRenderer } from "../Browser/FieldRenderer.js";
import { NumericFilter } from "./ColumnFilters.jsx";
import {
  BooleanField,
  DataColumn,
  DataColumnKey,
  NumericField,
  getNumericCols,
  isBooleanCol,
  isNumericCol,
} from "./Columns.jsx";

export type ColumnWithFieldRenderer<T> = Readonly<
  Column<T> & {
    fieldRenderer?: ColumnFieldRenderer<T>;
  }
>;

export const ColumnConfigContext = createContext<
  ColumnsConfig<any> | undefined
>(undefined);

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
  ButtonFC?: GridButtonsFC<T>;
};

export interface ColumnsConfig<T> {
  data: DataColumn<T>[];
  custom?: Column<T>[];
  grid: GridConfig<T>;
  id: IdColKey<T>;
  defaultSort: SortValue<T>;
  defaultVisible: (keyof T | "Controls")[];
}

export interface ColumnsState<T> {
  columns: Column<T>[];
  visibleColumns: Column<T>[] | undefined;
  setVisibleColumns: React.Dispatch<
    React.SetStateAction<Column<T>[] | undefined>
  >;
}

export function useColumnsState<T>(
  tag: string,
  rows: T[],
  columnsConfig: ColumnsConfig<T>
): ColumnsState<T> {
  const [columns, setColumns] = useState<Column<T>[]>([]);

  // Default value is set in fetchData
  const [visibleColumns, setVisibleColumns] = useState<Column<T>[]>();

  useEffect(() => {
    if (!visibleColumns) return;
    localStorage.setItem(
      `${tag}-visibleColumns`,
      JSON.stringify(visibleColumns.map((col) => col.key))
    );
  }, [visibleColumns, tag]);

  useMemo(() => {
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
            renderCell: (props) =>
              NumericField({
                data: props.row,
                col,
              }),
            renderHeaderCell: (props) => (
              <NumericFilter {...props} col={col} min={min} max={max} />
            ),
          };

          return resolvedCol;
        }

        if (isBooleanCol(col)) {
          const resolvedCol: ColumnWithFieldRenderer<T> = {
            ...col,
            key: col.key.toString(),
            renderCell: (props) =>
              BooleanField({
                data: props.row,
                col,
              }),
          };
          return resolvedCol;
        }

        // StringCol / FilterCol
        const resolvedCol: ColumnWithFieldRenderer<T> = {
          ...col,
          key: col.key.toString(),
          sortable: col.sortable ?? true,
          resizable: col.resizable ?? true,
          renderCell:
            "fieldRenderer" in col
              ? (props) => {
                  return col.fieldRenderer({
                    data: props.row,
                    col,
                  });
                }
              : undefined,
        };
        return resolvedCol;
      }),
    ];

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
  }, [rows, columnsConfig, tag]);

  return {
    columns,
    visibleColumns,
    setVisibleColumns,
  };
}
