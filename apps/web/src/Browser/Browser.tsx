import { GridLayout } from "@egjs/react-infinitegrid";
import { SortColumnKey, SortValue, SyncPlaylist } from "data-types";
import React, { useEffect, useState } from "react";
import DataGrid from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { LazyLoadImage } from "react-lazy-load-image-component";
import Select, { components } from "react-select";
import { useTraceUpdate } from "../Common/util.js";
import {
  ColumnWithFieldRenderer,
  useColumnState,
} from "../Table/ColumnState.jsx";
import { DataColumn, GridCols, NumberFormat } from "../Table/Columns.jsx";
import { AddFilter, TextFilterValueWithLabel } from "../Table/FilterState.jsx";

export type GridButtonsFC<T> = React.FC<{ row: T }>;

function Browser<T>(props: {
  tag: string;
  rows: T[];
  defaultSort: SortValue<T>;
  defaultVisible: (keyof T | "Controls")[];
  dataColumns: DataColumn<T>[];
  customColumns: ColumnWithFieldRenderer<T>[] | undefined;
  gridColumns: GridCols<T>;
  GridButtons?: GridButtonsFC<T>;
}) {
  useTraceUpdate(props);

  const {
    tag,
    rows,
    defaultSort,
    dataColumns,
    gridColumns,
    defaultVisible,
    customColumns,
    GridButtons,
  } = props;

  const {
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
  } = useColumnState(
    tag,
    rows,
    defaultSort,
    defaultVisible,
    dataColumns,
    customColumns
  );

  const [viewMode, setViewMode] = useState<"grid" | "table">(
    (localStorage.getItem(`${tag}-viewMode`) as any) ?? "table"
  );

  const [selectedRow, setSelectedRow] = useState<T | undefined>();

  useEffect(() => {
    localStorage.setItem(`${tag}-viewMode`, viewMode);
  }, [viewMode, tag]);

  useEffect(() => {
    const test: SyncPlaylist<T> = {
      name: "test",
      filters: [...(activeFilters ?? []), ...activeNumericFilters]?.map(
        (f) => ({
          ...f,
          label: undefined,
          count: undefined,
          type: undefined,
        })
      ),
      sort: [sortColumn, sortDirection],
    };
    console.log(JSON.stringify(test));
  }, [activeFilters, sortColumn, sortDirection, activeNumericFilters]);

  return (
    <>
      <div className="header">
        <button
          type="button"
          onClick={() => setViewMode(viewMode === "grid" ? "table" : "grid")}
        >
          {viewMode === "grid" ? "Table" : "Grid"}
        </button>
        <Select
          components={{
            MultiValueLabel: (props) => {
              function handleMultiValueClick(e: React.MouseEvent) {
                e.stopPropagation();
                e.preventDefault();

                const clickedFilter = props.data as
                  | TextFilterValueWithLabel<T>
                  | undefined;

                if (activeFilters && clickedFilter) {
                  // Normal -> exclude -> intersection -> normal
                  if (clickedFilter.exclude) {
                    clickedFilter.exclude = undefined;
                    clickedFilter.intersection = true;
                  } else if (clickedFilter.intersection) {
                    clickedFilter.exclude = undefined;
                    clickedFilter.intersection = undefined;
                  } else {
                    clickedFilter.exclude = true;
                    clickedFilter.intersection = undefined;
                  }
                  console.log(clickedFilter);
                  setFilters(
                    activeFilters.map((f) =>
                      f.field === clickedFilter.field &&
                      f.value === clickedFilter.value
                        ? clickedFilter
                        : f
                    )
                  );
                }
              }

              return (
                <div onClick={(e) => handleMultiValueClick(e)}>
                  <components.MultiValueLabel {...props} />
                </div>
              );
            },
          }}
          placeholder="Filter"
          className={"filter-select"}
          value={activeFilters}
          isMulti
          onChange={(filter) => {
            setFilters(filter);
          }}
          options={slicedOptions}
          inputValue={filterInputValue}
          onInputChange={(value, action) => {
            if (action.action !== "set-value") {
              setFilterInputValue(value);
            }
          }}
          filterOption={() => true} // disable native filter
          isClearable={true}
          closeMenuOnSelect={false}
          styles={{
            valueContainer: (base) => ({
              ...base,
              maxHeight: "36px",
              ":hover": { maxHeight: "none" },
            }),
            multiValue: (styles, { data }) => {
              const color = data.exclude
                ? "rgba(255,0,0,.3)"
                : data.intersection
                ? "rgba(255,0,255,.3)"
                : "rgba(0,0,255,.3)";
              return {
                ...styles,
                backgroundColor: color,
              };
            },
            // multiValueLabel: (styles, { data }) => ({
            //   ...styles,
            //   color: data.color,
            // }),
            // multiValueRemove: (styles, { data }) => ({
            //   ...styles,
            //   color: data.color,
            //   ':hover': {
            //     backgroundColor: data.color,
            //     color: 'white',
            //   },
            // })
          }}
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

        <div>
          <Select
            closeMenuOnSelect={false}
            placeholder="Sort"
            className={"filter-select sort-select"}
            value={{
              value: sortColumn,
              label:
                columns.find(
                  (c) => c.key === sortColumn && typeof c.name === "string"
                )?.name ?? sortColumn,
            }}
            onChange={(sort) => {
              sort?.value &&
                setSort([
                  sort?.value,
                  sort?.value === sortColumn
                    ? sortDirection === "ASC"
                      ? "DESC"
                      : "ASC"
                    : sortDirection,
                ]);
            }}
            options={columns
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
              setSort([sortColumn, sortDirection === "ASC" ? "DESC" : "ASC"])
            }
          >
            &#8597;
          </a>
        </div>

        {viewMode === "table" ? (
          <Select
            controlShouldRenderValue={false}
            closeMenuOnSelect={false}
            isMulti
            hideSelectedOptions={false}
            isClearable={false}
            placeholder="Columns"
            className={"filter-select"}
            value={(visibleColumns ?? []).map((col) => ({
              value: col.key,
              label:
                typeof col.name === "string" && col.name !== ""
                  ? col.name
                  : col.key,
            }))}
            onChange={(selectedCols) => {
              setVisibleColumns(
                columns.filter((col) =>
                  selectedCols.find((c) => c.value === col.key)
                )
              );
            }}
            options={columns.map((col) => ({
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
            columns={visibleColumns ?? []}
            rows={filteredRows}
            // rowClass={(row) => (row.watched ? "watched" : "unwatched")}
            defaultColumnOptions={{
              resizable: true,
            }}
            sortColumns={[
              {
                columnKey: sortColumn.toString(),
                direction: sortDirection,
              },
            ]}
            onSortColumnsChange={(sortColumns) =>
              typeof sortColumns[0] !== "undefined"
                ? setSort([
                    sortColumns[0].columnKey as any,
                    sortColumns[0].direction,
                  ])
                : setSort(defaultSort)
            }
            className="fill-grid"
            headerRowHeight={50}
            rowHeight={35}
          />
        </div>
      ) : (
        <div className={"image-grid"}>
          <div className={"image-grid-container"}>
            <ImageGrid
              rows={filteredRows}
              gridColumns={gridColumns}
              sortColumn={sortColumn}
              dataColumns={dataColumns}
              setSelectedRow={setSelectedRow}
              addFilter={addFilter}
              GridButtons={GridButtons}
            />
          </div>
        </div>
      )}
      {selectedRow ? (
        <div className={"overlay"} onClick={() => setSelectedRow(undefined)}>
          <div className={"info"} onClick={(evt) => evt.stopPropagation()}>
            <div>
              <h1>
                <FieldRenderer
                  col={(dataColumns ?? []).find(
                    (col) => col.key === gridColumns.cols[0]
                  )}
                  row={selectedRow}
                  addFilter={addFilter}
                />
              </h1>
              <h2>
                <FieldRenderer
                  col={(dataColumns ?? []).find(
                    (col) => col.key === gridColumns.cols[1]
                  )}
                  row={selectedRow}
                  addFilter={addFilter}
                />
              </h2>
              <p>
                <FieldRenderer
                  col={(dataColumns ?? []).find(
                    (col) => col.key === gridColumns.cols[2]
                  )}
                  row={selectedRow}
                  addFilter={addFilter}
                />
              </p>
              {gridColumns.art ? (
                <img src={selectedRow[gridColumns.art] as any} />
              ) : null}
            </div>
            <div className={"scroll"}>
              {(dataColumns ?? [])
                // Filter out grid cols
                .filter(
                  (col) =>
                    !gridColumns.cols.find((gridCol) => gridCol === col.key)
                )
                .map((col, i) => (
                  <React.Fragment key={i}>
                    <h3>{col.name}</h3>
                    <span>
                      <FieldRenderer
                        col={col}
                        row={selectedRow}
                        addFilter={addFilter}
                      />
                    </span>
                  </React.Fragment>
                ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function FieldRenderer<T>(props: {
  col: DataColumn<T> | undefined;
  row: T;
  addFilter: AddFilter<T>;
}) {
  if (!props.col) return <></>;
  if (props.col.type === "string") {
    if ("fieldRenderer" in props.col) {
      return props.col.fieldRenderer({
        data: props.row,
        addFilter: props.addFilter,
      });
    }
    return <>{props.row[props.col.key]}</>;
  } else if (props.col.type === "numeric") {
    const value = props.row[props.col.key];
    if (typeof value === "number") {
      return <NumberFormat col={props.col} value={value} />;
    }
    return <>{value}</>;
  } else {
    return <>{props.row[props.col.key]}</>;
  }
}

function ImageGrid<T>(props: {
  rows: T[];
  gridColumns: GridCols<T>;
  sortColumn: keyof T;
  dataColumns: DataColumn<T>[] | undefined;
  setSelectedRow: (row: T) => void;
  addFilter: AddFilter<T>;
  GridButtons?: GridButtonsFC<T>;
}) {
  const {
    rows,
    gridColumns,
    sortColumn,
    dataColumns,
    setSelectedRow,
    addFilter,
    GridButtons,
  } = props;

  useTraceUpdate(props, "Image grid");

  if (!gridColumns.art) return null;

  const col1 = (dataColumns ?? []).find(
    (col) => col.key === gridColumns.cols[0]
  );
  const col2 = (dataColumns ?? []).find(
    (col) => col.key === gridColumns.cols[1]
  );
  const col3 = (dataColumns ?? []).find(
    (col) => col.key === gridColumns.cols[2]
  );

  // Only show sort column if it is not already being shown
  const sortCol =
    col1?.key !== sortColumn &&
    col2?.key !== sortColumn &&
    col3?.key !== sortColumn
      ? (dataColumns ?? []).find((col) => col.key === sortColumn)
      : undefined;

  const padding = 5;

  return (
    <GridLayout
      tag="div"
      options={{
        useRecycle: true,
        isConstantSize: true,
        isEqualSize: true,
      }}
    >
      {rows.map((row, i) => {
        const art = row[gridColumns.art!];

        return typeof art === "string" ? (
          <div
            key={i}
            style={{
              width: gridColumns.width,
              padding: `${padding}px`,
            }}
          >
            <div className="image-wrapper" onClick={() => setSelectedRow(row)}>
              <div className="image-buttons-wrapper">
                {GridButtons ? <GridButtons row={row} /> : null}
              </div>
              <LazyLoadImage
                src={art}
                style={{
                  objectFit: "cover",
                  width: `${gridColumns.width}px`,
                  height: `${gridColumns.height}px`,
                }}
              />
            </div>

            <div className="image-album-title">
              <FieldRenderer col={col1} row={row} addFilter={addFilter} />
            </div>
            <div className="image-album-artist">
              <FieldRenderer col={col2} row={row} addFilter={addFilter} />
            </div>
            <div className="image-album-extra">
              <FieldRenderer col={col3} row={row} addFilter={addFilter} />
            </div>
            {/* Show extra line of information if sorting by a column which isn't displayed (title, artist or genre) */}
            <div className="image-album-extra">
              {sortCol ? (
                <>
                  <span className="image-album-extra-title">
                    {sortCol.name}:{" "}
                  </span>
                  <FieldRenderer
                    col={sortCol}
                    row={row}
                    addFilter={addFilter}
                  />
                </>
              ) : null}
            </div>
          </div>
        ) : null;
      })}
    </GridLayout>
  );
}

export default Browser;
