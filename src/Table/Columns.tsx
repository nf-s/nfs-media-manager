import "rc-slider/assets/index.css";
import React from "react";
import { PickProperties } from "ts-essentials";
import {
  BooleanColKey,
  FilterColKey,
  NumericColKey,
  StringColKey,
} from "nfs-media-scraper/dist/types/fields";
import { AddFilter } from "./FilterState";

export function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return [h, m > 9 ? m : h ? "0" + m : m || "0", s > 9 ? s : "0" + s]
    .filter(Boolean)
    .join(":");
}

export type FieldRenderer<T> = (props: {
  data: T;
  addFilter: AddFilter<T>;
}) => JSX.Element | null;

export const NumberFormat = <T,>(props: {
  col: NumericCol<T>;
  value: number;
}) =>
  props.col.numberFormat ? (
    <>{props.col.numberFormat(props.value)}</>
  ) : (
    <>
      {((props.value * (props.col.mult ?? 1)) / (props.col.max ?? 1)).toFixed(
        props.col.precision ?? 2
      )}
      {props.col.append}
    </>
  );

export const NumericField = <T,>(col: NumericCol<T>) => {
  if (col.key === undefined) return () => <></>;

  return (props: { data: T }) => {
    const value = props.data[col.key];

    return typeof value === "number" ? (
      <NumberFormat col={col} value={value} />
    ) : typeof value === "string" ? (
      <NumberFormat col={col} value={parseFloat(value)} />
    ) : null;
  };
};

export const BooleanField = <T,>(col: BooleanCol<T>) => {
  if (col.key === undefined) return () => <></>;

  return (props: { data: T }) => (props.data[col.key] ? <span>X</span> : null);
};

type ColumnBase = {
  readonly width?: number;
  readonly name: string;
  readonly resizable?: boolean;
};

export type GridCols<T> = {
  readonly width: number;
  readonly height: number;
  readonly art?: keyof PickProperties<T, string | undefined>;
  /** maximum of 3 columns */ readonly cols: [
    DataColumnKey<T>,
    DataColumnKey<T>,
    DataColumnKey<T>
  ];
};

export type DefaultVisible<T> = (keyof T | "Controls")[];

export type NumericCol<T> = {
  readonly sortable?: boolean;
  readonly type: "numeric";
  readonly key: NumericColKey<T>;
  readonly max?: number | undefined;
  readonly generateMaximumFromData?: boolean;
  readonly append?: string;
  /** Number of digits after the decimal point. Must be in the range 0 - 20, inclusive. */
  readonly precision?: number;
  readonly mult?: number | undefined;

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
  // Not string columns (require fieldRenderer)
  | {
      readonly key: keyof PickProperties<T, Exclude<any, string>>;
      readonly fieldRenderer: FieldRenderer<T>;
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

type DataColumnKey<T> =
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
