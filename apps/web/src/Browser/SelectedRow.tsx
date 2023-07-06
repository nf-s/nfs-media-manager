import React, { useContext } from "react";
import { ColumnConfigContext, ColumnsConfig } from "../Table/ColumnState.js";
import { FieldRenderer } from "./FieldRenderer.js";

export function SelectedRow<T>(props: {
  selectedRow: T | undefined;
  setSelectedRow: (row: T | undefined) => void;
}) {
  const { selectedRow, setSelectedRow } = props;

  const columnsConfig = useContext<ColumnsConfig<T> | undefined>(
    ColumnConfigContext
  );

  if (!columnsConfig || !selectedRow) return null;

  return (
    <div className={"overlay"} onClick={() => setSelectedRow(undefined)}>
      <div className={"info"} onClick={(evt) => evt.stopPropagation()}>
        <div>
          <h1>
            <FieldRenderer
              col={(columnsConfig.data ?? []).find(
                (col) => col.key === columnsConfig.grid.cols[0]
              )}
              row={selectedRow}
            />
          </h1>
          <h2>
            <FieldRenderer
              col={(columnsConfig.data ?? []).find(
                (col) => col.key === columnsConfig.grid.cols[1]
              )}
              row={selectedRow}
            />
          </h2>
          <p>
            <FieldRenderer
              col={(columnsConfig.data ?? []).find(
                (col) => col.key === columnsConfig.grid.cols[2]
              )}
              row={selectedRow}
            />
          </p>
          {columnsConfig.grid.art ? (
            <img src={selectedRow[columnsConfig.grid.art] as any} />
          ) : null}
        </div>
        <div className={"scroll"}>
          {(columnsConfig.data ?? [])
            // Filter out grid cols
            .filter(
              (col) =>
                !columnsConfig.grid.cols.find((gridCol) => gridCol === col.key)
            )
            .map((col, i) => (
              <React.Fragment key={i}>
                <h3>{col.name}</h3>
                <span>
                  <FieldRenderer col={col} row={selectedRow} />
                </span>
              </React.Fragment>
            ))}
        </div>
      </div>
    </div>
  );
}
