import { SortColumnKey } from "data-types";
import React from "react";
import Select from "react-select";
import { ColumnsState } from "../Table/ColumnState.jsx";
import { SortState } from "../Table/SortState.js";

export function Sort<T>(props: {
  sortState: SortState<T>;
  columnsState: ColumnsState<T>;
}) {
  const { sortState, columnsState } = props;

  return (
    <div>
      <Select
        closeMenuOnSelect={false}
        placeholder="Sort"
        className={"filter-select sort-select"}
        value={{
          value: sortState.column,
          label:
            columnsState.columns.find(
              (c) => c.key === sortState.column && typeof c.name === "string"
            )?.name ?? sortState.column,
        }}
        onChange={(sort) => {
          sort?.value &&
            sortState.dispatch([
              sort?.value,
              sort?.value === sortState.column
                ? sortState.direction === "ASC"
                  ? "DESC"
                  : "ASC"
                : sortState.direction,
            ]);
        }}
        options={columnsState.columns
          .filter((c) => c.sortable)
          .map((d) => ({
            value: d.key as SortColumnKey<T>,
            label: typeof d.name === "string" ? d.name : d.key,
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
          sortState.dispatch([
            sortState.column,
            sortState.direction === "ASC" ? "DESC" : "ASC",
          ])
        }
      >
        &#8597;
      </a>
    </div>
  );
}
