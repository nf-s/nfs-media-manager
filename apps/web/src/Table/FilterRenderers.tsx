import Slider from "rc-slider";

import React, { useContext } from "react";
import { RenderHeaderCellProps } from "react-data-grid";
import { isJsonArray, isJsonString } from "../Common/util.js";
import { NumberFormat } from "./FieldRenderers.js";
import { FilterStateContext, addFilter } from "./FilterState.js";
import { ColumnFieldRendererProps } from "./Columns.js";

// TODO fix this
const RcSlider = Slider as unknown as typeof Slider.default;

export function NumericFilterHeader<T>(props: RenderHeaderCellProps<T>) {
  return (
    <div
      onClick={() => {
        props.onSort(false);
      }}
    >
      <a data-tooltip-id="my-tooltip" data-column-key={props.column.key}>
        {props.column.name}
      </a>
    </div>
  );
}

export function NumericFilterTooltip(props: { colKey: string | undefined }) {
  const filterState = useContext(FilterStateContext);

  const filter = filterState?.numericFilterData?.find(
    (f) => f.col.key === props.colKey
  );

  if (!filter) return null;

  if (!filter || filter.min === Infinity || filter.max === -Infinity)
    return null;

  const marks: Record<number, React.ReactNode> = {};
  marks[filter.min] = <NumberFormat col={filter.col} value={filter.min} />;
  marks[filter.max] = <NumberFormat col={filter.col} value={filter.max} />;

  // Find active filter (if it exists)
  const activeFilter = filterState?.activeNumericFilters.find(
    (filter) => filter.field === filter.field
  );

  return (
    <RcSlider
      range
      min={filter.min}
      max={filter.max}
      // Use active filter if it exists, otherwise use default
      defaultValue={[
        activeFilter?.min ?? filter.min,
        activeFilter?.max ?? filter.max,
      ]}
      onChange={(value) => {
        if (!Array.isArray(value)) return;

        filterState?.activeNumericFiltersDispatch({
          type: "add",
          value: {
            min: value[0],
            max: value[1],
            field: filter.col.key as string,
            includeUndefined: value[0] === filter.min, //include undefined if minimum value is selected
          },
        });
      }}
      marks={marks}
    />
  );
}

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
