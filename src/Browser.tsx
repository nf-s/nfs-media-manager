import { GridLayout } from "@egjs/react-infinitegrid";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import DataGrid, { Column, SortDirection } from "react-data-grid";
import { LazyLoadImage } from "react-lazy-load-image-component";
import Select, { OptionsType } from "react-select";
import { PickProperties } from "ts-essentials";
import {
  FieldRenderer,
  getColumnWithTotals,
  Numeric,
  NumericCol,
  StringCol,
} from "./Table/Columns";

export type FilterValue<T> = {
  label: string;
  value: string;
  field: keyof T;
};

type ColumnWithFieldRenderer<T> = Column<T> & {
  fieldRenderer?: FieldRenderer<T>;
};
type SelectValues<T> = OptionsType<FilterValue<T>>;

function Browser<T>(props: {
  rows: T[];
  filterCols: (keyof T)[];
  defaultSort: [keyof T, SortDirection];
  defaultVisible: (keyof T | "Controls")[];
  numericCols: NumericCol<T>[];
  textColumns: StringCol<T>[];
  gridColumns: {
    art: keyof PickProperties<T, string | undefined>;
    /** maximum of 3 columns */ cols: (StringCol<T> | NumericCol<T>)[];
  };
  play: (item: T) => void;
  queue: (item: T) => void;
}) {
  const {
    rows,
    play,
    queue,
    filterCols,
    defaultSort,
    numericCols,
    textColumns,
    gridColumns,
    defaultVisible,
  } = props;

  const [filterData, setFilterData] = useState<{
    filters: FilterValue<T>[];
  }>({ filters: [] });
  const [columns, setColumns] = useState<ColumnWithFieldRenderer<T>[]>([]);

  const [viewMode, setViewMode] = useState<"grid" | "table">(
    (localStorage.getItem("viewMode") as any) ?? "grid"
  );

  const [[sortColumn, sortDirection], setSort] = useState<
    [keyof T, SortDirection]
  >(
    localStorage.getItem("sortColumn") && localStorage.getItem("sortDirection")
      ? ([
          localStorage.getItem("sortColumn"),
          localStorage.getItem("sortDirection"),
        ] as any)
      : defaultSort
  );

  // Default value is set in fetchData
  const [visibleColumns, setVisibleColumns] = useState<Column<T>[]>();

  // Default value is set in fetchData
  function filterReducer(
    state: SelectValues<T> | undefined,
    action:
      | { type: "add"; field: keyof T; value: string }
      | { type: "clear" }
      | { type: "set"; values: SelectValues<T> }
  ): SelectValues<T> | undefined {
    switch (action.type) {
      case "add":
        const found = filterData.filters.find(
          (a) => a.field === action.field && a.value === action.value
        );
        if (found) {
          return Array.from(new Set([...(state ?? []), found]));
        }
        return state;
      case "set":
        return action.values;
      case "clear":
        return [];
    }
  }

  const [activeFilters, setActiveFilters] = useReducer(
    filterReducer,
    undefined
  );

  const addFilter = useCallback((field: keyof T, value: string) => {
    setActiveFilters({ type: "add", field, value });
  }, []);

  useEffect(() => {
    // storing input name
    localStorage.setItem("viewMode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    // storing input name
    localStorage.setItem("sortColumn", sortColumn.toString());
  }, [sortColumn]);

  useEffect(() => {
    // storing input name
    localStorage.setItem("sortDirection", sortDirection);
  }, [sortDirection]);

  useEffect(() => {
    if (!visibleColumns) return;
    // storing input name
    localStorage.setItem(
      "visibleColumns",
      JSON.stringify(visibleColumns.map((col) => col.key))
    );
  }, [visibleColumns]);

  useEffect(() => {
    if (!activeFilters) return;
    // storing input name
    localStorage.setItem("activeFilters", JSON.stringify(activeFilters));
  }, [activeFilters]);

  useEffect(() => {
    const filters = filterCols.reduce<FilterValue<T>[]>(
      (acc, curr) => [...acc, ...getColumnWithTotals(rows, curr)],
      []
    );

    const savedActiveFilters = JSON.parse(
      localStorage.getItem("activeFilters") ?? ""
    );
    if (Array.isArray(savedActiveFilters)) {
      setActiveFilters({
        type: "set",
        values: filters.filter((a) =>
          savedActiveFilters.find(
            (b) => a.field === b.field && a.value === b.value
          )
        ),
      });
    }

    setFilterData({
      filters,
    });
  }, [rows, filterCols]);

  useEffect(() => {
    const maximums = numericCols.reduce(
      (map, numCol) =>
        map.set(numCol.key, Math.max(...rows.map((r) => r[numCol.key] ?? 0))),
      new Map<keyof T, number>()
    );

    const columns: ColumnWithFieldRenderer<T>[] = [
      {
        key: "Controls",
        name: "",
        formatter: (formatterProps: { row: T }) => (
          <>
            <button onClick={() => queue(formatterProps.row)}>+</button>
            <button
              onClick={() => {
                play(formatterProps.row);
              }}
            >
              &#9654;
            </button>
          </>
        ),
        width: 80,
        resizable: false,
      },
      ...textColumns,
      ...numericCols.map((col) => {
        if (col.generateMaximumFromData) {
          col.max = maximums.get(col.key);
        }
        return {
          key: col.key,
          name: col.name !== "" ? col.name : col.key.toString(),
          sortable: true,
          resizable: false,
          width: 80,
          fieldRenderer: Numeric(col),
        };
      }),
    ]
      // If column has `fieldRenderer` (which isn't part of data-grid), translate it into `formatter` so it can be used in table-cells
      .map((col) => {
        if (
          "fieldRenderer" in col &&
          col.fieldRenderer &&
          !("formatter" in col)
        ) {
          return {
            ...col,
            key: col.key.toString(),
            formatter: (props) =>
              col.fieldRenderer!({
                album: props.row,
                addFilter,
              }),
          };
        } else {
          return { ...col, key: col.key.toString() };
        }
      });

    const savedVisibleColumns = JSON.parse(
      localStorage.getItem("visibleColumns") ?? ""
    );
    if (Array.isArray(savedVisibleColumns)) {
      setVisibleColumns(
        columns.filter((c) => savedVisibleColumns.includes(c.key))
      );
    } else {
      setVisibleColumns(
        columns.filter((c) => defaultVisible.includes(c.key as any))
      );
    }

    setColumns(columns);
  }, [rows, queue, numericCols, textColumns, play, addFilter, defaultVisible]);

  const sortedRows = useMemo(() => {
    let sortedRows = [...rows];

    const textSortKey = textColumns.find((col) => col.key === sortColumn)?.key;

    if (textSortKey) {
      sortedRows = sortedRows.sort((a, b) =>
        (a[textSortKey] ?? "").localeCompare(b[sortColumn] ?? "")
      );
    }

    const numSortKey = numericCols.find((col) => col.key === sortColumn)?.key;

    if (numSortKey) {
      sortedRows = sortedRows
        .filter((a) => a[numSortKey] !== undefined)
        .sort((a, b) => a[numSortKey]! - b[numSortKey]!);
    }

    return sortDirection === "DESC" ? sortedRows.reverse() : sortedRows;
  }, [rows, sortDirection, sortColumn, numericCols, textColumns]);

  const filteredRows = useMemo(() => {
    if (!activeFilters || activeFilters.length === 0) return sortedRows;

    const filterdRows = new Set<T>();

    for (let i = 0; i < sortedRows.length; i++) {
      const row = sortedRows[i];
      for (let j = 0; j < activeFilters.length; j++) {
        const filter = activeFilters[j];
        const rowValue = row[filter.field];
        if (Array.isArray(rowValue)) {
          if (rowValue.includes(filter.value)) filterdRows.add(row);
          continue;
        }
        if (typeof rowValue === "string") {
          if (rowValue === filter.value) filterdRows.add(row);
          continue;
        }
      }
    }

    return Array.from(filterdRows);
  }, [sortedRows, activeFilters]);

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
            setActiveFilters({ type: "set", values: filter });
          }}
          options={filterData.filters}
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
                data.field === "artist"
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

        {viewMode === "grid" ? (
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
        ) : null}

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
                const art = row[gridColumns.art];

                const col1 = gridColumns.cols[0];
                const col2 = gridColumns.cols[1];
                const col3 = gridColumns.cols[2];

                // Only show sort column if it is not already being shown
                const sortCol =
                  col1.key !== sortColumn &&
                  col2.key !== sortColumn &&
                  col3.key !== sortColumn
                    ? columns.find((col) => col.key === sortColumn)
                    : undefined;

                return typeof art === "string" ? (
                  <div key={i} style={{ width: 250 }}>
                    <div className="image-wrapper">
                      <div className="image-buttons-wrapper">
                        <div className="image-buttons">
                          <button onClick={() => queue(row)}>+</button>
                          <button
                            onClick={() => {
                              play(row);
                            }}
                          >
                            &#9654;
                          </button>
                        </div>
                      </div>
                      <LazyLoadImage
                        src={art}
                        style={{ width: "250px", height: "250px" }}
                      />
                    </div>

                    <div className="image-album-title">
                      {"fieldRenderer" in col1 ? (
                        col1.fieldRenderer({ album: row, addFilter })
                      ) : (
                        <>{row[col1.key]}</>
                      )}
                    </div>
                    <div className="image-album-artist">
                      {"fieldRenderer" in col2 ? (
                        col2.fieldRenderer({ album: row, addFilter })
                      ) : (
                        <>{row[col2.key]}</>
                      )}
                    </div>
                    <div className="image-album-extra">
                      {"fieldRenderer" in col3 ? (
                        col3.fieldRenderer({ album: row, addFilter })
                      ) : (
                        <>{row[col3.key]}</>
                      )}
                    </div>
                    {/* Show extra line of information if sorting by a column which isn't displayed (title, artist or genre) */}
                    <div className="image-album-extra">
                      {sortCol ? (
                        "fieldRenderer" in sortCol && sortCol.fieldRenderer ? (
                          sortCol.fieldRenderer({ album: row, addFilter })
                        ) : (
                          <>{row[sortColumn]}</>
                        )
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

export default Browser;
