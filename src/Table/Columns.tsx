import "rc-slider/assets/index.css";
import React from "react";
import { SortDirection } from "react-data-grid";
import { PickProperties } from "ts-essentials";

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
  addFilter: (field: keyof T, value: string) => void;
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
    ) : null;
  };
};

export const BooleanField = <T,>(col: BooleanCol<T>) => {
  if (col.key === undefined) return () => <></>;

  return (props: { data: T }) => (props.data[col.key] ? <span>X</span> : null);
};

export type DefaultSort<T> = [keyof T, SortDirection];

export type GridCols<T> = {
  width: number;
  height: number;
  art?: keyof PickProperties<T, string | undefined>;
  /** maximum of 3 columns */ cols: [
    StringCol<T> | NumericCol<T>,
    StringCol<T> | NumericCol<T>,
    StringCol<T> | NumericCol<T>
  ];
};

export type DefaultVisible<T> = (keyof T | "Controls")[];

export type NumericColKey<T> = keyof PickProperties<T, number | undefined>;
export type NumericCol<T> = {
  type: "numeric";
  key: NumericColKey<T>;
  name: string;
  max?: number | undefined;
  generateMaximumFromData?: boolean;
  append?: string;
  /** Number of digits after the decimal point. Must be in the range 0 - 20, inclusive. */
  precision?: number;
  mult?: number | undefined;

  /** This overrides append, precision and mult */
  numberFormat?: (num: number) => string;
} & { width?: number; sortable?: boolean; resizable?: boolean };

export type BooleanColKey<T> = keyof PickProperties<
  T,
  boolean | number | string | undefined
>;
export type BooleanCol<T> = {
  type: "boolean";
  key: BooleanColKey<T>;
  name: string;
};

export type StringColKey<T> = keyof PickProperties<T, string | undefined>;
export type StringCol<T> = (
  | // String columns
  {
      key: keyof PickProperties<T, string | undefined>;
    }
  // Not string columns (require fieldRenderer)
  | {
      key: keyof PickProperties<T, Exclude<any, string>>;
      fieldRenderer: FieldRenderer<T>;
    }
) & {
  type: "string";
  width?: number;
  name: string;
  sortable?: boolean;
  resizable?: boolean;
};

export type Col<T> = StringCol<T> | NumericCol<T> | BooleanCol<T>;

export type FilterCol<T> = {
  key: FilterColKey<T>;
  label?: (value: string) => string;
};

export type FilterColKey<T> = keyof PickProperties<
  T,
  string[] | string | undefined
>;

export type FilterColArrayKey<T> = keyof PickProperties<T, string[]>;

export function getFilterColKey<T>(col: FilterCol<T>) {
  return typeof col === "object" && "key" in col ? col.key : col;
}
