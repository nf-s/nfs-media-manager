import { SyncPlaylist } from "data-types";
import React, { useEffect, useState } from "react";
import { Tooltip } from "react-tooltip";
import { useTraceUpdate } from "../Common/util.js";
import { ColumnStateContext, useColumnState } from "../Table/ColumnState.js";
import { ColumnConfigContext, ColumnsConfig } from "../Table/Columns.js";
import { NumericFilterTooltip } from "../Table/FilterRenderers.js";
import { FilterStateContext, useFilterState } from "../Table/FilterState.js";
import { useRowState } from "../Table/RowState.js";
import { FilterSelect } from "./FilterSelect.js";
import { ImageGrid } from "./ImageGrid.js";
import { SelectedRowOverlay } from "./SelectedRowOverlay.js";
import { SortSelect } from "./SortSelect.js";
import TableGrid from "./TableGrid.js";
import VisibleColumnSelect from "./VisibleColumnSelect.js";

function Browser<T>(props: {
  tag: string;
  rows: T[];

  columnsConfig: ColumnsConfig<T>;
}) {
  useTraceUpdate(props);

  const { tag, rows, columnsConfig } = props;

  const filterState = useFilterState(tag, rows, columnsConfig);
  const columnState = useColumnState(tag, columnsConfig);
  const rowState = useRowState(columnsConfig, rows, columnState, filterState);

  const [viewMode, setViewMode] = useState<"grid" | "table">(
    (localStorage.getItem(`${tag}-viewMode`) as any) ?? "table"
  );

  const [selectedRow, setSelectedRow] = useState<T | undefined>();

  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => {
    localStorage.setItem(`${tag}-viewMode`, viewMode);
  }, [viewMode, tag]);

  useEffect(() => {
    if (columnState.sortColumn && columnState.sortDirection) {
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
        sort: [columnState.sortColumn, columnState.sortDirection],
      };
      console.log(JSON.stringify(test));
    }
  }, [
    filterState.activeFilters,
    columnState.sortColumn,
    columnState.sortDirection,
    filterState.activeNumericFilters,
  ]);

  useEffect(() => {
    if (!ready && rowState.rows.length > 0 && filterState.filterData) {
      setReady(true);
    }
  }, [
    filterState.activeFilters,
    columnState.sortColumn,
    columnState.sortDirection,
    filterState.activeNumericFilters,
    ready,
    rowState.rows.length,
    filterState.filterData,
  ]);

  if (!ready) return <div className="loading">Loading...</div>;

  return (
    <ColumnConfigContext.Provider value={columnsConfig}>
      <FilterStateContext.Provider value={filterState}>
        <ColumnStateContext.Provider value={columnState}>
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
              <FilterSelect />
              <SortSelect />
              {viewMode === "table" ? <VisibleColumnSelect /> : null}
            </div>
            {viewMode === "table" ? (
              <TableGrid
                rows={rowState.rows}
                setSelectedRow={setSelectedRow}
              ></TableGrid>
            ) : (
              <ImageGrid<T>
                rows={rowState.rows}
                setSelectedRow={setSelectedRow}
              />
            )}
            <SelectedRowOverlay
              selectedRow={selectedRow}
              setSelectedRow={setSelectedRow}
            />
          </div>
          <Tooltip
            className="numeric-filter-tooltip"
            id="my-tooltip"
            place="bottom"
            clickable={true}
            render={({ activeAnchor }) => (
              <NumericFilterTooltip
                colKey={
                  activeAnchor?.getAttribute("data-column-key") ?? undefined
                }
              />
            )}
          />
        </ColumnStateContext.Provider>
      </FilterStateContext.Provider>
    </ColumnConfigContext.Provider>
  );
}

export default Browser;
