import React, { useContext } from "react";
import Select from "react-select";
import { ColumnStateContext } from "../Table/ColumnState.js";
import { ColumnConfigContext } from "../Table/Columns.js";

function VisibleColumnSelect() {
  const columnConfig = useContext(ColumnConfigContext);
  const columnState = useContext(ColumnStateContext);

  const allColumns = [
    ...(columnConfig?.custom ?? []),
    ...(columnConfig?.data ?? []),
  ];

  return (
    <Select
      controlShouldRenderValue={false}
      closeMenuOnSelect={false}
      isMulti
      hideSelectedOptions={false}
      isClearable={false}
      placeholder="Columns"
      className={"filter-select"}
      value={(columnState?.visibleColumns ?? []).map((colKey) => {
        const column = allColumns.find((col) => col.key === colKey);

        if (!column) return undefined;

        return {
          value: column.key,
          label:
            typeof column.name === "string" && column.name !== ""
              ? column.name
              : column.key,
        };
      })}
      onChange={(selectedCols) => {
        columnState?.visibleColumnsDispatch(
          selectedCols
            .map((selected) => {
              return allColumns.find((col) => col.key === selected?.value)?.key;
            })
            .filter((value) => value) as string[]
        );
      }}
      options={allColumns.map((col) => ({
        value: col.key,
        label:
          typeof col.name === "string" && col.name !== "" ? col.name : col.key,
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
  );
}

export default VisibleColumnSelect;
