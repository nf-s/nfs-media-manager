import { SortColumnDirection, SortColumnKey, SortValue } from "data-types";
import { createContext, useEffect, useState } from "react";
import { ColumnsConfig } from "./Columns.js";

export interface ColumnState<T> {
  sortColumn: SortColumnKey<T> | undefined;
  sortDirection: SortColumnDirection | undefined;
  sortDispatch: React.Dispatch<React.SetStateAction<SortValue<T> | undefined>>;
  visibleColumns: string[] | undefined;
  visibleColumnsDispatch: React.Dispatch<
    React.SetStateAction<string[] | undefined>
  >;
}

export const ColumnStateContext = createContext<ColumnState<any> | undefined>(
  undefined
);

export function useColumnState<T>(
  tag: string,
  columnsConfig: ColumnsConfig<T>
): ColumnState<T> {
  const [sortColumn, setSort] = useState<SortValue<T>>();
  const [visibleColumns, setVisibleColumns] = useState<string[] | undefined>();

  // Get saved sort columns from local storage
  useEffect(() => {
    if (sortColumn) return;

    setSort(
      localStorage.getItem(`${tag}-sortColumn`) &&
        localStorage.getItem(`${tag}-sortDirection`)
        ? ([
            localStorage.getItem(`${tag}-sortColumn`),
            localStorage.getItem(`${tag}-sortDirection`),
          ] as any)
        : columnsConfig.defaultSort
    );
  }, [columnsConfig, tag, sortColumn]);

  // Save sort parameters to local storage
  useEffect(() => {
    if (!sortColumn) return;
    localStorage.setItem(`${tag}-sortColumn`, sortColumn[0].toString());
    localStorage.setItem(`${tag}-sortDirection`, sortColumn[1]);
  }, [sortColumn, tag]);

  // Get saved visible columns from local storage
  useEffect(() => {
    if (visibleColumns) return;

    // Get saved visible columns from localStorage
    // If none saved, use defaultVisible from config
    const savedVisibleColumns = localStorage.getItem(`${tag}-visibleColumns`)
      ? JSON.parse(localStorage.getItem(`${tag}-visibleColumns`)!)
      : undefined;
    if (Array.isArray(savedVisibleColumns)) {
      setVisibleColumns(savedVisibleColumns);
    } else {
      setVisibleColumns(
        [...(columnsConfig.custom ?? []), ...columnsConfig.data]
          .filter((c) => columnsConfig.defaultVisible.includes(c.key as any))
          .map((col) => col.key.toString())
      );
    }
  }, [visibleColumns, columnsConfig, tag]);

  // Save visibleColumns to localStorage
  useEffect(() => {
    if (!visibleColumns) return;
    localStorage.setItem(
      `${tag}-visibleColumns`,
      JSON.stringify(visibleColumns)
    );
  }, [visibleColumns, tag]);

  return {
    sortColumn: sortColumn?.[0],
    sortDirection: sortColumn?.[1],
    sortDispatch: setSort,
    visibleColumns,
    visibleColumnsDispatch: setVisibleColumns,
  };
}
