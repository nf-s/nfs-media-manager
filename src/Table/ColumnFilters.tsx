import { Handle, Range, SliderProps, SliderTooltip } from "rc-slider";
import "rc-slider/assets/index.css";
import React from "react";
import { HeaderRendererProps } from "react-data-grid";
import {
  FilterColArrayKey,
  NumericColKey,
  StringColKey,
} from "nfs-media-scraper/src/types/fields";
import { isJsonArray, isJsonString } from "../Common/util";
import { FieldRenderer, NumberFormat, NumericCol } from "./Columns";

type NumericFilterProps<T> = {
  col: NumericCol<T>;
  min: number | undefined;
  max: number | undefined;
  addFilter: (
    field: NumericColKey<T>,
    min: number,
    max: number,
    includeUndefined: boolean
  ) => void;
};

const handle: <T>(col: NumericCol<T>) => SliderProps["handle"] =
  (col) => (props) => {
    const { value, dragging, index, ...restProps } = props;
    return (
      <SliderTooltip
        prefixCls="rc-slider-tooltip"
        overlay={<NumberFormat col={col} value={value} />}
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

export function NumericFilter<T>(
  props: NumericFilterProps<T> & HeaderRendererProps<T>
) {
  if (
    typeof props.col.key === "undefined" ||
    typeof props.min === "undefined" ||
    props.min === Infinity ||
    typeof props.max === "undefined" ||
    props.max === -Infinity
  )
    return null;

  const marks: Record<number, React.ReactNode> = {};
  marks[props.min] = <NumberFormat col={props.col} value={props.min} />;
  marks[props.max] = <NumberFormat col={props.col} value={props.max} />;
  return (
    <div
      onClick={() => {
        props.onSort(false);
      }}
    >
      <div className={"numerical-filter-title"}>{props.col.name}</div>
      <div
        className={"numerical-filter-range"}
        onClick={(e) => e.stopPropagation()}
      >
        <Range
          step={props.max - props.min < 10 ? (props.max - props.min) / 500 : 1}
          min={props.min}
          max={props.max}
          defaultValue={[props.min, props.max]}
          onAfterChange={(value) => {
            props.addFilter(
              props.col.key,
              value[0],
              value[1],
              value[0] ===
                props.min /** include undefined if minimum value is selected */
            );
          }}
          marks={marks}
          handle={handle(props.col)}
        />
      </div>
    </div>
  );
}

export const ArrayFilterRenderer: <T>(
  col: FilterColArrayKey<T>,
  idCol: StringColKey<T>
) => FieldRenderer<T> = (col, idCol) => (props) => {
  const data = props.data[col];
  if (!isJsonArray(data)) return null;

  return (
    <>
      {data.map((g, i) =>
        isJsonString(g) ? (
          // eslint-disable-next-line jsx-a11y/anchor-is-valid
          <a
            onClick={() => props.addFilter(col, g)}
            key={`${props.data?.[idCol]}-${g}`}
          >
            {g}
            {i < data.length - 1 ? ", " : ""}
          </a>
        ) : null
      )}
    </>
  );
};
