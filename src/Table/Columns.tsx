import React from "react";
import { SortDirection } from "react-data-grid";
import { PickProperties } from "ts-essentials";

export type FilterValue<T> = {
  label: string;
  value: string;
  field: keyof T;
};

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

export const Numeric = <T,>(col: NumericCol<T>) => {
  if (col.key === undefined) return () => <></>;

  return (props: { data: T }) =>
    typeof props.data[col.key] === "undefined" ? null : (
      <>
        {((props.data[col.key]! * (col.mult ?? 1)) / (col.max ?? 1)).toFixed(
          col.precision ?? 2
        )}
        {col.append}
      </>
    );
};

export type DefaultSort<T> = [keyof T, SortDirection];

export type DefaultVisible<T> = (keyof T | "Controls")[];

export type NumericCol<T> = {
  key: keyof PickProperties<T, number | undefined>;
  name: string;
  max?: number | undefined;
  generateMaximumFromData?: boolean;
  append?: string;
  /** Number of digits after the decimal point. Must be in the range 0 - 20, inclusive. */
  precision?: number;
  mult?: number | undefined;
};

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
) & { width?: number; name: string; sortable?: boolean; resizable?: boolean };

export function getColumnWithTotals<K>(
  rows: K[],
  colName: keyof K,
  sort: "key" | "value" = "key"
): FilterValue<K>[] {
  const total = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const value = rows[i][colName];
    const values =
      typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (let j = 0; j < values.length; j++) {
      total.set(values[j], (total.get(values[j]) ?? 0) + 1);
    }
  }

  let totalArray = Array.from(total).sort((a, b) =>
    (a[0] ?? "").localeCompare(b[0] ?? "")
  );

  if (sort === "value") {
    totalArray = totalArray.sort((a, b) => a[1] - b[1]);
  }

  return totalArray.map((r) => ({
    label: `${r[0]} (${r[1]})`,
    value: r[0],
    field: colName,
  }));
}
