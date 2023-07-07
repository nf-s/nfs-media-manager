// import { Handle, Range, SliderProps, SliderTooltip } from "rc-slider";
import "rc-slider/assets/index.css";
import React, { useContext } from "react";
import { RenderHeaderCellProps } from "react-data-grid";
import { ColumnFieldRendererProps } from "../Browser/FieldRenderer.js";
import { isJsonArray, isJsonString } from "../Common/util.js";
import { NumberFormat, NumericCol } from "./Columns.jsx";
import { FilterStateContext, addFilter } from "./FilterState.js";

type NumericFilterProps<T> = {
  col: NumericCol<T>;
  min: number | undefined;
  max: number | undefined;
};

// const handle: <T>(col: NumericCol<T>) => SliderProps["handleRender"] =
//   (col) => (props) => {
//     const { value, dragging, index, ...restProps } = props;
//     return (
//       <SliderTooltip
//         prefixCls="rc-slider-tooltip"
//         overlay={<NumberFormat col={col} value={value} />}
//         visible={dragging}
//         placement="bottom"
//         key={index}
//       >
//         <Handle
//           value={value}
//           {...restProps}
//           ariaValueTextFormatter={undefined}
//         />
//       </SliderTooltip>
//     );
//   };

export function NumericFilter<T>(
  props: NumericFilterProps<T> & RenderHeaderCellProps<T>
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
      ></div>
    </div>
  );
}

/*<Range
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
        props.min /** include undefined if minimum value is selected 
    );
  }}
  marks={marks}
  handle={handle(props.col)}
/>*/

export const ArrayFilterRenderer: <T>(
  props: ColumnFieldRendererProps<T>
) => JSX.Element | null = (props) => {
  const data = props.data[props.col.key];
  const filterState = useContext(FilterStateContext);

  if (!isJsonArray(data) || !filterState) return null;

  return (
    <>
      {data.map((g, i) =>
        isJsonString(g) ? (
          <a
            onClick={() =>
              addFilter(filterState, {
                field: props.col.key.toString(),
                value: g,
              })
            }
            key={`${props.col.key.toString()}-${g}`}
          >
            {g}
            {i < data.length - 1 ? ", " : ""}
          </a>
        ) : null
      )}
    </>
  );
};
