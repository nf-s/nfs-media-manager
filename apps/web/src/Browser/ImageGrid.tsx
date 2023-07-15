import { MasonryInfiniteGrid } from "@egjs/react-infinitegrid";
import React, { useContext, useEffect, useRef, useState } from "react";
import "react-data-grid/lib/styles.css";
import { LazyLoadImage } from "react-lazy-load-image-component";
import { useTraceUpdate } from "../Common/util.js";
import { ColumnConfigContext, ColumnsConfig } from "../Table/ColumnState.jsx";
import { FieldRenderer } from "../Table/FieldRenderer.js";

const GRID_GROUP_SIZE = 100;

export function ImageGrid<T>(props: {
  rows: T[];
  sortColumn: keyof T;
  setSelectedRow: (row: T) => void;
}) {
  const { rows, sortColumn, setSelectedRow } = props;

  const columnsConfig = useContext(ColumnConfigContext);

  useTraceUpdate(props, "Image grid");

  const igRef = useRef<MasonryInfiniteGrid>();

  const [items, setItems] = useState(() =>
    getItems(0, GRID_GROUP_SIZE, rows.length - 1)
  );

  const [numRows, setNumRows] = useState(() => rows.length);

  // Reset grid items when row length changes (e.g. when filters are applied)
  useEffect(() => {
    if (numRows !== rows.length) {
      setNumRows(rows.length);
      setItems(getItems(0, GRID_GROUP_SIZE, rows.length - 1));
    }
  }, [numRows, rows]);

  if (!columnsConfig?.grid.art || rows.length === 0) return null;

  return (
    <div className={"image-grid"}>
      <MasonryInfiniteGrid
        ref={igRef as any}
        className="container"
        container={true}
        gap={5}
        onRequestAppend={(e) => {
          const nextGroupKey = (+e.groupKey! || 0) + 1;

          // Only add more items if there are more rows to add
          if (nextGroupKey * GRID_GROUP_SIZE < rows.length - 1) {
            setItems([
              ...items,
              ...getItems(nextGroupKey, GRID_GROUP_SIZE, rows.length - 1),
            ]);
          }
        }}
        align="start"
        threshold={1500}
        isConstantSize
        isEqualSize
        useResizeObserver
      >
        {items.map((item) => (
          <ImageGridItem
            data-grid-groupkey={item.groupKey}
            key={item.key}
            row={rows[item.key]}
            sortColumn={sortColumn}
            setSelectedRow={setSelectedRow}
          />
        ))}
      </MasonryInfiniteGrid>
    </div>
  );
}

function getItems(nextGroupKey: number, count: number, maxIndex: number) {
  const nextItems = [];
  const nextKey = nextGroupKey * count;

  for (let i = 0; i < count; ++i) {
    if (nextKey + i > maxIndex) break;
    nextItems.push({ groupKey: nextGroupKey, key: nextKey + i });
  }

  return nextItems;
}

function ImageGridItem<T>(props: {
  key: string | number;
  row: T | undefined;
  sortColumn: keyof T;
  setSelectedRow: (row: T) => void;
}) {
  const { row, sortColumn, setSelectedRow } = props;
  const columnsConfig = useContext<ColumnsConfig<T> | undefined>(
    ColumnConfigContext
  );

  if (!columnsConfig) return null;

  const col1 = (columnsConfig.data ?? []).find(
    (col) => col.key === columnsConfig.grid.cols[0]
  );
  const col2 = (columnsConfig.data ?? []).find(
    (col) => col.key === columnsConfig.grid.cols[1]
  );
  const col3 = (columnsConfig.data ?? []).find(
    (col) => col.key === columnsConfig.grid.cols[2]
  );

  // Only show sort column if it is not already being shown
  const sortCol =
    col1?.key !== sortColumn &&
    col2?.key !== sortColumn &&
    col3?.key !== sortColumn
      ? (columnsConfig.data ?? []).find((col) => col.key === sortColumn)
      : undefined;

  const padding = 5;

  const art = row?.[columnsConfig.grid.art!];

  if (!row || typeof art !== "string") {
    return null;
  }

  return (
    <div
      className="item"
      style={{
        width: columnsConfig.grid.width,
        padding: `${padding}px`,
      }}
    >
      <div className="image-wrapper" onClick={() => setSelectedRow(row)}>
        <div className="image-buttons-wrapper">
          {columnsConfig.grid.ButtonFC ? (
            <columnsConfig.grid.ButtonFC row={row} />
          ) : null}
          {columnsConfig.grid.links ? (
            <div className="image-links">{columnsConfig.grid.links(row)}</div>
          ) : null}
        </div>
        <LazyLoadImage
          src={art}
          style={{
            objectFit: "cover",
            width: `${columnsConfig.grid.width}px`,
            height: `${columnsConfig.grid.height}px`,
          }}
        />
      </div>

      <div className="image-album-title">
        <FieldRenderer col={col1} row={row} />
      </div>
      <div className="image-album-artist">
        <FieldRenderer col={col2} row={row} />
      </div>
      <div className="image-album-extra">
        <FieldRenderer col={col3} row={row} />
      </div>
      {/* Show extra line of information if sorting by a column which isn't displayed (title, artist or genre) */}
      <div className="image-album-extra">
        {sortCol ? (
          <>
            <span className="image-album-extra-title">{sortCol.name}: </span>
            <FieldRenderer col={sortCol} row={row} />
          </>
        ) : null}
      </div>
    </div>
  );
}
