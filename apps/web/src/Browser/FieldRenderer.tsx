import React from "react";
import { DataColumn, NumberFormat } from "../Table/Columns.js";

export type ColumnFieldRendererProps<T> = {
  col: DataColumn<T>;
  data: T;
};
export type ColumnFieldRenderer<T> = (
  props: ColumnFieldRendererProps<T>
) => JSX.Element | null;

export function FieldRenderer<T>(props: {
  col: DataColumn<T> | undefined;
  row: T;
}) {
  if (!props.col) return <></>;
  if (props.col.type === "string") {
    if ("fieldRenderer" in props.col) {
      return props.col.fieldRenderer({
        col: props.col,
        data: props.row,
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
