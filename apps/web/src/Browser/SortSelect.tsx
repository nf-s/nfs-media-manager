import { SortColumnKey } from "data-types";
import React, { useContext } from "react";
import Select from "react-select";
import { ColumnConfigContext, ColumnsConfig } from "../Table/Columns.js";
import { ColumnState, ColumnStateContext } from "../Table/ColumnState.js";

export function SortSelect<T>() {
  const columnConfig = useContext<ColumnsConfig<T> | undefined>(
    ColumnConfigContext
  );
  const sortState = useContext<ColumnState<T> | undefined>(ColumnStateContext);

  if (!sortState) return null;

  return (
    <div>
      <Select
        closeMenuOnSelect={false}
        placeholder="Sort"
        className={"filter-select sort-select"}
        value={{
          value: sortState.sortColumn,
          label:
            columnConfig?.data?.find(
              (c) =>
                c.key === sortState.sortColumn && typeof c.name === "string"
            )?.name ?? sortState.sortColumn,
        }}
        onChange={(sort) => {
          sort?.value &&
            sortState.sortDirection &&
            sortState.sortDispatch([
              sort.value,
              sort.value === sortState.sortColumn
                ? sortState.sortDirection === "ASC"
                  ? "DESC"
                  : "ASC"
                : sortState.sortDirection,
            ]);
        }}
        options={columnConfig?.data
          ?.filter((c) => !("sortable" in c) || c.sortable)
          .map((d) => ({
            value: d.key as SortColumnKey<T>,
            label: typeof d.name === "string" ? d.name : (d.key as string),
          }))}
        theme={(theme) => ({
          ...theme,
          colors: {
            ...theme.colors,
            primary25: "#00ffab24",
            primary50: "#00ffab50",
            primary75: "#00ffab",
            primary: "#00c583",
          },
        })}
      />
      <a
        className="reverse-sort"
        onClick={() =>
          sortState.sortColumn &&
          sortState.sortDispatch([
            sortState.sortColumn,
            sortState.sortDirection === "ASC" ? "DESC" : "ASC",
          ])
        }
      >
        &#8597;
      </a>
    </div>
  );
}
