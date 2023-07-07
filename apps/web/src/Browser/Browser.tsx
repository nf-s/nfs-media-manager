import { SyncPlaylist } from "data-types";
import React, { useEffect, useState } from "react";
import DataGrid from "react-data-grid";
import "react-data-grid/lib/styles.css";
import Select from "react-select";
import { useTraceUpdate } from "../Common/util.js";
import {
  ColumnConfigContext,
  ColumnsConfig,
  useColumnsState,
} from "../Table/ColumnState.jsx";
import { FilterStateContext, useFilterState } from "../Table/FilterState.js";
import { useRowState } from "../Table/RowState.js";
import { useSortState } from "../Table/SortState.js";
import { Filter } from "./Filter.js";
import { ImageGrid } from "./ImageGrid.js";
import { SelectedRow } from "./SelectedRow.js";
import { Sort } from "./Sort.js";

function Browser<T>(props: {
  tag: string;
  rows: T[];

  columnsConfig: ColumnsConfig<T>;
}) {
  useTraceUpdate(props);

  const { tag, rows, columnsConfig } = props;

  const columnState = useColumnsState(tag, rows, columnsConfig);
  const filterState = useFilterState(tag, rows, columnsConfig);
  const sortState = useSortState(tag, columnsConfig);
  const rowState = useRowState(columnsConfig, rows, sortState, filterState);

  const [viewMode, setViewMode] = useState<"grid" | "table">(
    (localStorage.getItem(`${tag}-viewMode`) as any) ?? "table"
  );

  const [selectedRow, setSelectedRow] = useState<T | undefined>();

  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => {
    localStorage.setItem(`${tag}-viewMode`, viewMode);
  }, [viewMode, tag]);

  useEffect(() => {
    const test: SyncPlaylist<T> = {
      name: "test",
      filters: [
        ...(filterState.activeFilters ?? []),
        ...filterState.activeNumericFilters,
      ]?.map((f) => ({
        ...f,
        label: undefined,
        count: undefined,
        type: undefined,
      })),
      sort: [sortState.column, sortState.direction],
    };
    console.log(JSON.stringify(test));
  }, [
    filterState.activeFilters,
    sortState.column,
    sortState.direction,
    filterState.activeNumericFilters,
  ]);

  useEffect(() => {
    if (
      !ready &&
      rowState.rows.length > 0 &&
      columnState.columns.length > 0 &&
      filterState.filterData.length > 0
    ) {
      setReady(true);
    }
  }, [
    filterState.activeFilters,
    sortState.column,
    sortState.direction,
    filterState.activeNumericFilters,
    ready,
    rowState.rows.length,
    columnState.columns.length,
    filterState.filterData.length,
  ]);

  if (!ready) return <div className="loading">Loading...</div>;

  return (
    <ColumnConfigContext.Provider value={columnsConfig}>
      <FilterStateContext.Provider value={filterState}>
        <div className="browser-root">
          <div className="header">
            <span>{/*Dummy element for app-toolbar*/}</span>
            <button
              type="button"
              onClick={() =>
                setViewMode(viewMode === "grid" ? "table" : "grid")
              }
            >
              {viewMode === "grid" ? "Table" : "Grid"}
            </button>
            <Filter filterState={filterState} />
            <Sort sortState={sortState} columnsState={columnState} />

            {viewMode === "table" ? (
              <Select
                controlShouldRenderValue={false}
                closeMenuOnSelect={false}
                isMulti
                hideSelectedOptions={false}
                isClearable={false}
                placeholder="Columns"
                className={"filter-select"}
                value={(columnState.visibleColumns ?? []).map((col) => ({
                  value: col.key,
                  label:
                    typeof col.name === "string" && col.name !== ""
                      ? col.name
                      : col.key,
                }))}
                onChange={(selectedCols) => {
                  columnState.setVisibleColumns(
                    columnState.columns.filter((col) =>
                      selectedCols.find((c) => c.value === col.key)
                    )
                  );
                }}
                options={columnState.columns.map((col) => ({
                  value: col.key,
                  label:
                    typeof col.name === "string" && col.name !== ""
                      ? col.name
                      : col.key,
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
            ) : null}
          </div>
          {viewMode === "table" ? (
            <div className={"data-grid"}>
              <DataGrid
                onCellDoubleClick={(cell) => setSelectedRow(cell.row)}
                columns={columnState.visibleColumns ?? []}
                rows={rowState.rows}
                // rowClass={(row) => (row.watched ? "watched" : "unwatched")}
                defaultColumnOptions={{
                  resizable: true,
                }}
                sortColumns={[
                  {
                    columnKey: sortState.column.toString(),
                    direction: sortState.direction,
                  },
                ]}
                onSortColumnsChange={(sortColumns) =>
                  typeof sortColumns[0] !== "undefined"
                    ? sortState.dispatch([
                        sortColumns[0].columnKey as any,
                        sortColumns[0].direction,
                      ])
                    : sortState.dispatch(columnsConfig.defaultSort)
                }
                className="fill-grid"
                headerRowHeight={50}
                rowHeight={35}
              />
            </div>
          ) : (
            <ImageGrid<T>
              rows={rowState.rows}
              sortColumn={sortState.column}
              setSelectedRow={setSelectedRow}
            />
          )}
          <SelectedRow
            selectedRow={selectedRow}
            setSelectedRow={setSelectedRow}
          />
        </div>
      </FilterStateContext.Provider>
    </ColumnConfigContext.Provider>
  );
}

export default Browser;
