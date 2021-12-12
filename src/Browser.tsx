import { GridLayout } from "@egjs/react-infinitegrid";
import React, { useEffect, useMemo, useState } from "react";
import DataGrid, { Column, SortDirection } from "react-data-grid";
import { LazyLoadImage } from "react-lazy-load-image-component";
import Select from "react-select";
import { PickProperties } from "ts-essentials";
import {
  BooleanCol,
  BooleanField,
  BooleanFilter,
  FieldRenderer,
  FilterColKey,
  GridCols,
  NumericCol,
  NumericColKey,
  NumericField,
  NumericFilter,
  StringCol,
} from "./Table/Columns";
import {
  useBooleanFilter,
  useNumericFilter,
  useTextFilter,
} from "./Table/Filters";
import { useTraceUpdate } from "./util";

type ColumnWithFieldRenderer<T> = Column<T> & {
  fieldRenderer?: FieldRenderer<T>;
};

function Browser<T>(props: {
  tag: string;
  rows: T[];
  filterCols: FilterColKey<T>[];
  defaultSort: [keyof T, SortDirection];
  defaultVisible: (keyof T | "Controls")[];
  idCol: keyof PickProperties<T, string>;
  numericCols?: NumericCol<T>[];
  textColumns?: StringCol<T>[];
  booleanColumns?: BooleanCol<T>[];
  gridColumns: GridCols<T>;
  play?: (item: T) => void;
  queue?: (item: T) => void;
}) {
  useTraceUpdate(props);

  const {
    tag,
    rows,
    play,
    queue,
    filterCols,
    defaultSort,
    idCol,
    numericCols,
    textColumns,
    booleanColumns,
    gridColumns,
    defaultVisible,
  } = props;

  // const searchIndex = useMemo(() => {
  //   if (typeof idCol !== "string") return;
  //   const index = new Document({
  //     document: {
  //       id: idCol,
  //       index: filterCols.map((col) => ({
  //         field: col,
  //         tokenize: "full",
  //         resolution: 9,
  //       })) as Array<IndexOptions<T> & { field: string }>,
  //     },
  //   });

  //   for (let i = 0; i < rows.length; i++) {
  //     index.add(rows[i]);
  //   }

  //   return index;
  // }, [filterCols, idCol, rows]);

  const [columns, setColumns] = useState<ColumnWithFieldRenderer<T>[]>([]);

  const [viewMode, setViewMode] = useState<"grid" | "table">(
    (localStorage.getItem(`${tag}-viewMode`) as any) ?? "grid"
  );

  const [[sortColumn, sortDirection], setSort] = useState<
    [keyof T, SortDirection]
  >(
    localStorage.getItem(`${tag}-sortColumn`) &&
      localStorage.getItem(`${tag}-sortDirection`)
      ? ([
          localStorage.getItem(`${tag}-sortColumn`),
          localStorage.getItem(`${tag}-sortDirection`),
        ] as any)
      : defaultSort
  );

  // Default value is set in fetchData
  const [visibleColumns, setVisibleColumns] = useState<Column<T>[]>();

  const {
    activeFilters,
    addFilter,
    setFilters,
    slicedOptions,
    filterInputValue,
    setFilterInputValue,
  } = useTextFilter<T>(filterCols, rows, tag);

  const { activeNumericFilters, addNumericFilter } = useNumericFilter<T>(
    numericCols ?? []
  );

  const { activeBooleanFilters, addBooleanFilter } = useBooleanFilter<T>(
    booleanColumns ?? []
  );

  useEffect(() => {
    localStorage.setItem(`${tag}-viewMode`, viewMode);
  }, [viewMode, tag]);

  useEffect(() => {
    localStorage.setItem(`${tag}-sortColumn`, sortColumn.toString());
  }, [sortColumn, tag]);

  useEffect(() => {
    localStorage.setItem(`${tag}-sortDirection`, sortDirection);
  }, [sortDirection, tag]);

  useEffect(() => {
    if (!visibleColumns) return;
    localStorage.setItem(
      `${tag}-visibleColumns`,
      JSON.stringify(visibleColumns.map((col) => col.key))
    );
  }, [visibleColumns, tag]);

  useEffect(() => {
    console.log("setColumns");
    const maximums = (numericCols ?? []).reduce(
      (map, numCol) =>
        map.set(numCol.key, Math.max(...rows.map((r) => r[numCol.key] ?? 0))),
      new Map<NumericColKey<T>, number>()
    );

    const minimums = (numericCols ?? []).reduce(
      (map, numCol) =>
        map.set(numCol.key, Math.min(...rows.map((r) => r[numCol.key] ?? 0))),
      new Map<NumericColKey<T>, number>()
    );

    const columns: ColumnWithFieldRenderer<T>[] = [
      ...(textColumns ?? []),
      ...(booleanColumns ?? []).map((col) => {
        return {
          ...col,
          fieldRenderer: BooleanField(col),
          headerRenderer: BooleanFilter(col, addBooleanFilter),
        };
      }),
      ...(numericCols ?? []).map((col) => {
        const min = minimums.get(col.key);
        const max = maximums.get(col.key);
        if (col.generateMaximumFromData) {
          col.max = max;
        }
        return {
          key: col.key,
          name: col.name !== "" ? col.name : col.key.toString(),
          sortable: true,
          // resizable: false,
          width: 80,
          fieldRenderer: NumericField(col),
          headerRenderer:
            typeof min !== "undefined" &&
            min !== Infinity &&
            typeof max !== "undefined" &&
            max !== -Infinity
              ? NumericFilter(col, min, max, addNumericFilter)
              : undefined,
        };
      }),
    ]
      .filter((col) => col)
      // If column has `fieldRenderer` (which isn't part of data-grid), translate it into `formatter` so it can be used in table-cells
      .map((col) => {
        if (
          "fieldRenderer" in col! &&
          col.fieldRenderer &&
          !("formatter" in col)
        ) {
          return {
            ...col,
            key: col.key.toString(),
            formatter: (props) =>
              col.fieldRenderer!({
                data: props.row,
                addFilter,
              }),
          };
        } else {
          return { ...col, key: col!.key.toString() };
        }
      });

    const controlCol =
      queue || play
        ? {
            key: "Controls",
            name: "",
            formatter: (formatterProps: { row: T }) => (
              <>
                {queue ? (
                  <button onClick={() => queue(formatterProps.row)}>+</button>
                ) : null}
                {play ? (
                  <button onClick={() => play(formatterProps.row)}>
                    &#9654;
                  </button>
                ) : null}
              </>
            ),
            width: 80,
            resizable: false,
          }
        : undefined;

    if (controlCol) {
      columns.unshift(controlCol);
    }

    const savedVisibleColumns = localStorage.getItem(`${tag}-visibleColumns`)
      ? JSON.parse(localStorage.getItem(`${tag}-visibleColumns`)!)
      : undefined;
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
  }, [
    rows,
    queue,
    numericCols,
    textColumns,
    play,
    addFilter,
    defaultVisible,
    tag,
    addNumericFilter,
    booleanColumns,
    addBooleanFilter,
  ]);

  const sortedRows = useMemo(() => {
    let sortedRows = [...rows];

    const textSortKey = (textColumns ?? []).find(
      (col) => col.key === sortColumn
    )?.key;

    if (textSortKey) {
      sortedRows = sortedRows.sort((a, b) => {
        let text = a[textSortKey];
        text = Array.isArray(text) ? text[0] : text;
        return (text ?? "").localeCompare(b[sortColumn] ?? "");
      });
    }

    const numSortKey = (numericCols ?? []).find(
      (col) => col.key === sortColumn
    )?.key;

    if (numSortKey) {
      sortedRows = sortedRows
        .filter((a) => a[numSortKey] !== undefined)
        .sort((a, b) => a[numSortKey]! - b[numSortKey]!);
    }

    return sortDirection === "DESC" ? sortedRows.reverse() : sortedRows;
  }, [rows, sortDirection, sortColumn, numericCols, textColumns]);

  const filteredRows = useMemo(() => {
    if (
      (!activeFilters || activeFilters.length === 0) &&
      activeNumericFilters.length === 0 &&
      activeBooleanFilters.length === 0
    )
      return sortedRows;

    const filterdRows = new Set<T>();

    // Apply text filters (additive - union)
    for (let i = 0; i < sortedRows.length; i++) {
      let include = true;
      const row = sortedRows[i];
      if (activeFilters && activeFilters.length !== 0) {
        include = false;
        for (let j = 0; j < activeFilters.length; j++) {
          const filter = activeFilters[j];
          const rowValue = row[filter.field];
          if (
            (Array.isArray(rowValue) && rowValue.includes(filter.value)) ||
            (typeof rowValue === "string" && rowValue === filter.value)
          ) {
            include = true;
          }
        }
      }

      // Numeric and boolean filters are subtractive (intersecting)
      // Apply numeric filters
      for (let j = 0; j < activeNumericFilters.length; j++) {
        const filter = activeNumericFilters[j];
        const rowValue = row[filter.field];
        if (
          typeof rowValue === "number" &&
          include &&
          rowValue <= filter.max &&
          rowValue >= filter.min
        ) {
          continue;
        }

        include = false;
      }

      // Apply boolean filters
      for (let j = 0; j < activeBooleanFilters.length; j++) {
        const filter = activeBooleanFilters[j];

        if (
          typeof filter.value === "undefined" ||
          !!row[filter.field] === filter.value
        )
          continue;

        include = false;
      }

      if (include) {
        filterdRows.add(row);
      }
    }

    return Array.from(filterdRows);
  }, [sortedRows, activeFilters, activeNumericFilters, activeBooleanFilters]);

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
                    ? columns.find((col) => col.key === sortColumn)
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
                      {queue || play ? (
                        <div className="image-buttons-wrapper">
                          <div className="image-buttons">
                            {queue ? (
                              <button onClick={() => queue(row)}>+</button>
                            ) : null}
                            {play ? (
                              <button
                                onClick={() => {
                                  play(row);
                                }}
                              >
                                &#9654;
                              </button>
                            ) : null}
                          </div>
                        </div>
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
                      {"fieldRenderer" in col1 ? (
                        col1.fieldRenderer({ data: row, addFilter })
                      ) : (
                        <>{row[col1.key]}</>
                      )}
                    </div>
                    <div className="image-album-artist">
                      {"fieldRenderer" in col2 ? (
                        col2.fieldRenderer({ data: row, addFilter })
                      ) : (
                        <>{row[col2.key]}</>
                      )}
                    </div>
                    <div className="image-album-extra">
                      {"fieldRenderer" in col3 ? (
                        col3.fieldRenderer({ data: row, addFilter })
                      ) : (
                        <>{row[col3.key]}</>
                      )}
                    </div>
                    {/* Show extra line of information if sorting by a column which isn't displayed (title, artist or genre) */}
                    <div className="image-album-extra">
                      {sortCol ? (
                        "fieldRenderer" in sortCol && sortCol.fieldRenderer ? (
                          sortCol.fieldRenderer({ data: row, addFilter })
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
