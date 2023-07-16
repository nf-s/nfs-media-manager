import { Links } from "data-types/dist/common.js";
import React, { useContext } from "react";
import {
  ColumnFieldRendererProps,
  DataColumn,
  NumericCol,
  isNumericCol,
} from "./Columns.js";
import { FilterStateContext } from "./FilterState.js";

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

export interface LinkIconConfig<T> {
  key: T;
  img: string | JSX.Element;
  alt: string;
}

export function LinksRenderer<T extends { links: Links<P> }, P extends string>(
  linkIcons: LinkIconConfig<P>[]
) {
  return (row: T) => {
    return (
      <>
        {linkIcons.map((linkIcon) =>
          row.links[linkIcon.key].href ? (
            <a
              key={linkIcon.key}
              href={row.links[linkIcon.key].href}
              title={row.links[linkIcon.key].title}
              target="blank"
              className="row-external-links"
            >
              {typeof linkIcon.img === "string" ? (
                <img src={linkIcon.img} width="16px" alt={linkIcon.alt} />
              ) : (
                linkIcon.img
              )}
            </a>
          ) : null
        )}
      </>
    );
  };
}

export function LinksColumn<T>(linkRenderer: (row: T) => JSX.Element) {
  return {
    key: "Links",
    name: "",
    renderCell: (formatterProps: { row: T }) =>
      linkRenderer(formatterProps.row),
    resizable: false,
  };
}
