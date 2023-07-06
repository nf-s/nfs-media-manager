import React from "react";
import { DataColumn, NumberFormat } from "../Table/Columns.js";

export function FieldRenderer<T>(props: {
  col: DataColumn<T> | undefined;
  row: T;
}) {
  if (!props.col) return <></>;
  if (props.col.type === "string") {
    // if ("cellRenderer" in props.col) {
    //   return props.col.cellRenderer({
    //     data: props.row,
    //     addFilter: props.addFilter,
    //   });
    // }
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
