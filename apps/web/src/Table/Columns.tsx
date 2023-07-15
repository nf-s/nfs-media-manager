import {
  BooleanColKey,
  FilterColKey,
  NumericColKey,
  StringColKey,
} from "data-types";
import React, { useContext } from "react";
import { PickProperties } from "ts-essentials";
import {
  ColumnFieldRenderer,
  ColumnFieldRendererProps,
} from "./FieldRenderer.js";
import { FilterStateContext } from "./FilterState.js";

export function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return [h, m > 9 ? m : h ? "0" + m : m || "0", s > 9 ? s : "0" + s]
    .filter(Boolean)
    .join(":");
}

export const NumberFormat = <T,>(props: {
  col: NumericCol<T>;
  value: number;
}) => {
  const filterState = useContext(FilterStateContext);
  let divisor = 1;

  // If we are displaying as percent of max, we need to divide by max value
  // This can be found in the corresponding numericFilter
  if (props.col.displayAsPercentOfMax) {
    const numericFilter = filterState?.numericFilterData?.find(
      (filter) => filter.col.key === props.col.key
    );

    divisor = numericFilter?.max ?? 1;
  }

  return props.col.numberFormat ? (
    <>{props.col.numberFormat(props.value)}</>
  ) : (
    <>
      {((props.value * (props.col.mult ?? 1)) / divisor).toFixed(
        props.col.precision ?? 2
      )}
      {props.col.append}
    </>
  );
};

export const NumericField = <T,>(props: ColumnFieldRendererProps<T>) => {
  const value = props.data[props.col.key];
  const col = props.col;

  if (!isNumericCol(col)) {
    return null;
  }

  return typeof value === "number" ? (
    <NumberFormat col={col} value={value} />
  ) : typeof value === "string" ? (
    <NumberFormat col={col} value={parseFloat(value)} />
  ) : null;
};

export const BooleanField = <T,>(props: ColumnFieldRendererProps<T>) =>
  props.data[props.col.key] ? <span>X</span> : null;

type ColumnBase = {
  readonly width?: number;
  readonly name: string;
  readonly resizable?: boolean;
};

export type ColumnKey<T> = keyof T | "Controls" | "Links";

export type DefaultVisible<T> = ColumnKey<T>[];

export type NumericCol<T> = {
  readonly sortable?: boolean;
  readonly type: "numeric";
  readonly key: NumericColKey<T>;
  /** Minimum value for filter. If left empty, this will be generated from column values */
  readonly min?: number | undefined;
  /** Maximum value for filter. If left empty, this will be generated from column values */
  readonly max?: number | undefined;
  /** If true, then value will be divided by `max`, and multiplied by `100` */
  readonly displayAsPercentOfMax?: boolean;
  readonly append?: string;
  /** Number of digits after the decimal point. Must be in the range 0 - 20, inclusive. */
  readonly precision?: number;
  readonly mult?: number | undefined;
  readonly default?: number;

  /** This overrides append, precision and mult */
  readonly numberFormat?: (num: number) => string;
} & ColumnBase;

export type BooleanCol<T> = {
  readonly type: "boolean";
  readonly key: BooleanColKey<T>;
} & ColumnBase;

export type StringCol<T> = (
  | // String columns
  {
      readonly key: keyof PickProperties<T, string | undefined>;
    }
  // Not string columns (require renderCell)
  | {
      readonly key: keyof PickProperties<T, Exclude<any, string>>;
      readonly fieldRenderer: ColumnFieldRenderer<T>;
    }
) & {
  readonly type: "string";

  readonly sortable?: boolean;
} & ColumnBase;

export type FilterCol<T> = StringCol<T> & {
  readonly enableFilter: true;
  readonly enableRowFilter?: boolean;
  readonly key: FilterColKey<T>;
  readonly filterLabel?: (value: string) => string;
};

export type DataColumn<T> =
  | FilterCol<T>
  | StringCol<T>
  | NumericCol<T>
  | BooleanCol<T>;

export type DataColumnKey<T> =
  | FilterColKey<T>
  | StringColKey<T>
  | NumericColKey<T>
  | BooleanColKey<T>;

export function isNumericCol<T>(col: DataColumn<T>): col is NumericCol<T> {
  return col.type === "numeric";
}
export function getNumericCols<T>(
  cols: DataColumn<T>[] | undefined
): NumericCol<T>[] {
  return (cols ?? []).filter(isNumericCol);
}
export function isStringCol<T>(col: DataColumn<T>): col is StringCol<T> {
  return col.type === "string";
}
export function getStringCols<T>(
  cols: DataColumn<T>[] | undefined
): StringCol<T>[] {
  return (cols ?? []).filter(isStringCol);
}
export function isBooleanCol<T>(col: DataColumn<T>): col is BooleanCol<T> {
  return col.type === "boolean";
}
export function getBooleanCols<T>(
  cols: DataColumn<T>[] | undefined
): BooleanCol<T>[] {
  return (cols ?? []).filter(isBooleanCol);
}

export function isFilterCol<T>(col: DataColumn<T>): col is FilterCol<T> {
  return (
    col.type === "string" && "enableFilter" in col && col.enableFilter === true
  );
}

export function getFilterCols<T>(
  cols: DataColumn<T>[] | undefined
): FilterCol<T>[] {
  return (cols ?? []).filter(isFilterCol);
}
