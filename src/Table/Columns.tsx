import { Handle, Range, SliderProps, SliderTooltip } from "rc-slider";
import "rc-slider/assets/index.css";
import React, { useState } from "react";
import { HeaderRendererProps, SortDirection } from "react-data-grid";
import { PickProperties } from "ts-essentials";
import { FilterValue } from "./Filters";

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

export const NumberFomat = <T,>(props: {
  col: NumericCol<T>;
  value: number;
}) => (
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
      <NumberFomat col={col} value={value} />
    ) : null;
  };
};

export const BooleanField = <T,>(col: BooleanCol<T>) => {
  if (col.key === undefined) return () => <></>;

  return (props: { data: T }) => (props.data[col.key] ? <span>X</span> : null);
};

const handle: <T>(col: NumericCol<T>) => SliderProps["handle"] =
  (col) => (props) => {
    const { value, dragging, index, ...restProps } = props;
    return (
      <SliderTooltip
        prefixCls="rc-slider-tooltip"
        overlay={<NumberFomat col={col} value={value} />}
        visible={dragging}
        placement="bottom"
        key={index}
      >
        <Handle
          value={value}
          {...restProps}
          ariaValueTextFormatter={undefined}
        />
      </SliderTooltip>
    );
  };

export const NumericFilter = <T,>(
  col: NumericCol<T>,
  min: number,
  max: number,
  addFilter: (field: NumericColKey<T>, min: number, max: number) => void
): React.ComponentType<HeaderRendererProps<T>> => {
  if (col.key === undefined) return () => <></>;

  const marks: Record<number, React.ReactNode> = {};
  marks[min] = <NumberFomat col={col} value={min} />;
  marks[max] = <NumberFomat col={col} value={max} />;
  return (props) => (
    <>
      <div className={"numerical-filter-title"}>{col.name}</div>
      <div className={"numerical-filter-range"}>
        <Range
          step={max - min < 10 ? (max - min) / 200 : 1}
          min={min}
          max={max}
          defaultValue={[min, max]}
          onAfterChange={(value) => addFilter(col.key, value[0], value[1])}
          marks={marks}
          handle={handle(col)}
        />
      </div>
    </>
  );
};

export const BooleanFilter = <T,>(
  col: BooleanCol<T>,
  addFilter: (field: BooleanColKey<T>, value: boolean | undefined) => void
): React.ComponentType<HeaderRendererProps<T>> => {
  if (col.key === undefined) return () => <></>;

  return (props) => (
    <BooleanControls
      {...props}
      onChange={(value) => addFilter(col.key, value)}
    />
  );
};

function BooleanControls<T>(
  props: HeaderRendererProps<T> & {
    onChange: (value: boolean | undefined) => void;
  }
) {
  const [value, setValue] = useState<boolean | undefined>(undefined);
  return (
    <>
      <input
        type="radio"
        id="false"
        name="false"
        value="false"
        onChange={() => {
          props.onChange(false);
          setValue(false);
        }}
        checked={value === false}
      />
      <label htmlFor="false">False</label>
      <input
        type="radio"
        id="true"
        name="true"
        value="true"
        onChange={() => {
          props.onChange(true);
          setValue(true);
        }}
        checked={value === true}
      />
      <label htmlFor="true">True</label>
      <input
        type="radio"
        id="all"
        name="all"
        value="all"
        onChange={() => {
          props.onChange(undefined);
          setValue(undefined);
        }}
        checked={value === undefined}
      />
      <label htmlFor="all">All</label>
    </>
  );
}

export type DefaultSort<T> = [keyof T, SortDirection];

export type GridCols<T> = {
  width: number;
  height: number;
  art?: keyof PickProperties<T, string | undefined>;
  /** maximum of 3 columns */ cols: (StringCol<T> | NumericCol<T>)[];
};

export type DefaultVisible<T> = (keyof T | "Controls")[];

export type NumericColKey<T> = keyof PickProperties<T, number | undefined>;
export type NumericCol<T> = {
  key: NumericColKey<T>;
  name: string;
  max?: number | undefined;
  generateMaximumFromData?: boolean;
  append?: string;
  /** Number of digits after the decimal point. Must be in the range 0 - 20, inclusive. */
  precision?: number;
  mult?: number | undefined;
};

export type BooleanColKey<T> = keyof PickProperties<
  T,
  boolean | number | string | undefined
>;
export type BooleanCol<T> = {
  key: BooleanColKey<T>;
  name: string;
};

export type FilterColKey<T> = keyof PickProperties<
  T,
  string[] | string | undefined
>;

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
  colName: FilterColKey<K>,
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
