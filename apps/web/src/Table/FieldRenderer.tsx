import React from "react";
import { DataColumn, NumberFormat } from "./Columns.js";
import { Links } from "data-types/dist/common.js";

export type ColumnFieldRendererProps<T> = {
  col: DataColumn<T>;
  data: T;
};
export type ColumnFieldRenderer<T> = (
  props: ColumnFieldRendererProps<T>
) => JSX.Element | null;

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
