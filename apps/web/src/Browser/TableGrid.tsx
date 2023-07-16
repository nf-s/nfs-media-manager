import React, { useContext, useEffect, useMemo, useState } from "react";
import DataGrid, { Column } from "react-data-grid";
import { ColumnState, ColumnStateContext } from "../Table/ColumnState.js";
import {
  ColumnWithFieldRenderer,
  ColumnsConfig,
  ColumnConfigContext as ColumnsConfigContext,
  isBooleanCol,
  isNumericCol,
} from "../Table/Columns.js";
import { BooleanField, NumericField } from "../Table/FieldRenderers.js";
import { NumericFilterHeader } from "../Table/FilterRenderers.js";

function TableGrid<T>(props: { rows: T[]; setSelectedRow: (row: T) => void }) {
  const { rows, setSelectedRow } = props;

  const columnsConfig = useContext<ColumnsConfig<T> | undefined>(
    ColumnsConfigContext
  );
  const columnState = useContext<ColumnState<T> | undefined>(
    ColumnStateContext
  );

  const [columns, setColumns] = useState<Column<T>[] | undefined>(undefined);
  const [visibleColumns, setVisibleColumns] = useState<Column<T>[] | undefined>(
    undefined
  );

  useEffect(() => {
    if (!columnState?.visibleColumns || !columns) return;

    setVisibleColumns(
      columns.filter((col) => columnState.visibleColumns?.includes(col.key))
    );
  }, [columnState?.visibleColumns, columns, visibleColumns]);

  // Generate DataGrid columns from columnsConfig and row data
  // It will also set visibleColumns from localStorage
  useMemo(() => {
    if (!columnsConfig) return;

    const columns: ColumnWithFieldRenderer<T>[] = [
      ...(columnsConfig.custom ?? []),
      ...columnsConfig.data.map((col) => {
        if (isNumericCol(col)) {
          const resolvedCol: ColumnWithFieldRenderer<T> = {
            key: col.key.toString(),
            name: col.name !== "" ? col.name : col.key.toString(),
            sortable: col.sortable ?? true,
            resizable: col.resizable ?? true,
            width: col.width ?? 80,
            renderCell: (props) =>
              NumericField({
                data: props.row,
                col,
              }),
            renderHeaderCell: NumericFilterHeader<T>,
          };

          return resolvedCol;
        }

        if (isBooleanCol(col)) {
          const resolvedCol: ColumnWithFieldRenderer<T> = {
            ...col,
            key: col.key.toString(),
            renderCell: (props) =>
              BooleanField({
                data: props.row,
                col,
              }),
          };
          return resolvedCol;
        }

        // StringCol / FilterCol
        const resolvedCol: ColumnWithFieldRenderer<T> = {
          ...col,
          key: col.key.toString(),
          sortable: col.sortable ?? true,
          resizable: col.resizable ?? true,
          renderCell:
            "fieldRenderer" in col
              ? (props) => {
                  return col.fieldRenderer({
                    data: props.row,
                    col,
                  });
                }
              : undefined,
        };
        return resolvedCol;
      }),
    ];

    setColumns(columns);
  }, [columnsConfig]);

  return (
    <div className={"data-grid"}>
      <DataGrid
        onCellDoubleClick={(cell) => setSelectedRow(cell.row)}
        columns={visibleColumns ?? []}
        rows={rows}
        // rowClass={(row) => (row.watched ? "watched" : "unwatched")}
        defaultColumnOptions={{
          resizable: true,
        }}
        sortColumns={
          columnState?.sortColumn && columnState.sortDirection
            ? [
                {
                  columnKey: columnState.sortColumn.toString(),
                  direction: columnState.sortDirection,
                },
              ]
            : undefined
        }
        onSortColumnsChange={(sortColumns) =>
          typeof sortColumns[0] !== "undefined"
            ? columnState?.sortDispatch([
                sortColumns[0].columnKey as any,
                sortColumns[0].direction,
              ])
            : columnsConfig?.defaultSort
            ? columnState?.sortDispatch(columnsConfig.defaultSort)
            : undefined
        }
        className="fill-grid"
        headerRowHeight={50}
        rowHeight={35}
      />
    </div>
  );
}

export default TableGrid;
