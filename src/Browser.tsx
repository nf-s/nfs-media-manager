import { GridLayout } from "@egjs/react-infinitegrid";
import React, { useEffect, useState } from "react";
import DataGrid, { SortDirection } from "react-data-grid";
import { LazyLoadImage } from "react-lazy-load-image-component";
import Select from "react-select";
import { PickProperties } from "ts-essentials";
import {
  BooleanCol,
  Col,
  FilterCol,
  GridCols,
  NumberFormat,
  NumericCol,
  StringCol,
} from "./Table/Columns";
import { ColumnWithFieldRenderer, useRowState } from "./Table/RowState";
import { useTraceUpdate } from "./util";

function Browser<T>(props: {
  tag: string;
  rows: T[];
  filterCols: FilterCol<T>[];
  defaultSort: [keyof T, SortDirection];
  defaultVisible: (keyof T | "Controls")[];
  idCol: keyof PickProperties<T, string>;
  numericCols?: NumericCol<T>[];
  textColumns?: StringCol<T>[];
  booleanColumns?: BooleanCol<T>[];
  gridColumns: GridCols<T>;
  gridButtons?: React.FC<{ row: T }>;
  customColumns?: ColumnWithFieldRenderer<T>[];
}) {
  useTraceUpdate(props);

  const {
    tag,
    rows,
    filterCols,
    defaultSort,
    idCol,
    numericCols,
    textColumns,
    booleanColumns,
    gridColumns,
    defaultVisible,
    customColumns,
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
  } = useRowState(
    tag,
    rows,
    filterCols,
    defaultSort,
    defaultVisible,
    numericCols,
    textColumns,
    booleanColumns,
    customColumns
  );

  const [viewMode, setViewMode] = useState<"grid" | "table">(
    (localStorage.getItem(`${tag}-viewMode`) as any) ?? "grid"
  );

  useEffect(() => {
    localStorage.setItem(`${tag}-viewMode`, viewMode);
  }, [viewMode, tag]);

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
            if (action.action === "set-value") {
            } else {
              setFilterInputValue(value);
            }
          }}
          filterOption={() => true} // disable native filter
          isClearable={true}
          closeMenuOnSelect={false}
          styles={{
            valueContainer: (base, props) => ({
              ...base,
              maxHeight: "36px",
              ":hover": { maxHeight: "none" },
            }),
            multiValue: (styles, { data }) => {
              const color =
                data.col.key === "artist"
                  ? "rgba(255,0,0,.3)"
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
                value: d.key as keyof T,
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
          {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
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
                    sortColumns[0].columnKey as keyof T,
                    sortColumns[0].direction,
                  ])
                : setSort(defaultSort)
            }
            className="fill-grid"
            onRowClick={(e) => console.log(e)}
            headerRowHeight={50}
            rowHeight={35}
          />
        </div>
      ) : (
        <div className={"image-grid"}>
          <div className={"image-grid-container"}>
            <GridLayout
              tag="div"
              options={{
                useRecycle: true,
                isConstantSize: true,
                isEqualSize: true,
              }}
            >
              {filteredRows.map((row, i) => {
                const art = gridColumns.art ? row[gridColumns.art] : undefined;

                const col1 = gridColumns.cols[0];
                const col2 = gridColumns.cols[1];
                const col3 = gridColumns.cols[2];

                // Only show sort column if it is not already being shown
                const sortCol =
                  col1.key !== sortColumn &&
                  col2.key !== sortColumn &&
                  col3.key !== sortColumn
                    ? [
                        ...(textColumns ?? []),
                        ...(numericCols ?? []),
                        ...(booleanColumns ?? []),
                      ].find((col) => col.key === sortColumn)
                    : undefined;

                const padding = 5;

                return typeof art === "string" ? (
                  <div
                    key={i}
                    style={{
                      width: gridColumns.width,
                      padding: `${padding}px`,
                    }}
                  >
                    <div className="image-wrapper">
                      {props.gridButtons ? (
                        <props.gridButtons row={row} />
                      ) : null}
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
                      <FieldRenderer
                        col={col1}
                        row={row}
                        addFilter={addFilter}
                      />
                    </div>
                    <div className="image-album-artist">
                      <FieldRenderer
                        col={col2}
                        row={row}
                        addFilter={addFilter}
                      />
                    </div>
                    <div className="image-album-extra">
                      <FieldRenderer
                        col={col3}
                        row={row}
                        addFilter={addFilter}
                      />
                    </div>
                    {/* Show extra line of information if sorting by a column which isn't displayed (title, artist or genre) */}
                    <div className="image-album-extra">
                      {sortCol ? (
                        <FieldRenderer
                          col={sortCol}
                          row={row}
                          addFilter={addFilter}
                        />
                      ) : null}
                    </div>
                  </div>
                ) : null;
              })}
            </GridLayout>
          </div>
        </div>
      )}
    </>
  );
}

function FieldRenderer<T>(props: {
  col: Col<T>;
  row: T;
  addFilter: (field: keyof T, value: string) => void;
}) {
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

export default Browser;
