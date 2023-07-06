import { SortColumnKey, SortValue } from "data-types";
import { useEffect, useState } from "react";
import { ColumnsConfig } from "./ColumnState.js";

export interface SortState<T> {
  column: SortColumnKey<T>;
  direction: "ASC" | "DESC";
  dispatch: React.Dispatch<React.SetStateAction<SortValue<T>>>;
}

export function useSortState<T>(
  tag: string,
  columnsConfig: ColumnsConfig<T>
): SortState<T> {
  const [[sortColumn, sortDirection], setSort] = useState<SortValue<T>>(
    localStorage.getItem(`${tag}-sortColumn`) &&
      localStorage.getItem(`${tag}-sortDirection`)
      ? ([
          localStorage.getItem(`${tag}-sortColumn`),
          localStorage.getItem(`${tag}-sortDirection`),
        ] as any)
      : columnsConfig.defaultSort
  );

  useEffect(() => {
    localStorage.setItem(`${tag}-sortColumn`, sortColumn.toString());
  }, [sortColumn, tag]);

  useEffect(() => {
    localStorage.setItem(`${tag}-sortDirection`, sortDirection);
  }, [sortDirection, tag]);

  return { column: sortColumn, direction: sortDirection, dispatch: setSort };
}
