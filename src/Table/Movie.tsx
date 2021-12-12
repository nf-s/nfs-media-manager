import React from "react";
import { CleanMovie } from "../../../movie-scraper/src/movie/interfaces";
import {
  BooleanCol,
  DefaultSort,
  DefaultVisible,
  FieldRenderer,
  FilterColKey,
  GridCols,
  NumericCol,
  StringCol,
} from "./Columns";

export const Tags: FieldRenderer<CleanMovie> = (props) => {
  return (
    <>
      {props.data.tags?.map((g, i) => (
        // eslint-disable-next-line jsx-a11y/anchor-is-valid
        <a
          onClick={() => props.addFilter("tags", g)}
          key={`${props.data.id}-${g}`}
        >
          {g}
          {i < props.data.tags!.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

export const Collections: FieldRenderer<CleanMovie> = (props) => {
  return (
    <>
      {props.data.collections?.map((g, i) => (
        // eslint-disable-next-line jsx-a11y/anchor-is-valid
        <a
          onClick={() => props.addFilter("collections", g)}
          key={`${props.data.id}-${g}`}
        >
          {g}
          {i < props.data.collections!.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

export const Directors: FieldRenderer<CleanMovie> = (props) => {
  return (
    <>
      {props.data.directors?.map((g, i) => (
        // eslint-disable-next-line jsx-a11y/anchor-is-valid
        <a
          onClick={() => props.addFilter("directors", g)}
          key={`${props.data.id}-${g}`}
        >
          {g}
          {i < props.data.directors!.length - 1 ? ", " : ""}
        </a>
      ))}
    </>
  );
};

export const booleanCols: BooleanCol<CleanMovie>[] = [
  { key: "watched", name: "Watched" },
];
export const numericCols: NumericCol<CleanMovie>[] = [
  {
    key: "ratingImdbValue",
    name: "IMDB",
    mult: 10,
    precision: 0,
    append: "%",
  },
  { key: "ratingPtpValue", name: "PTP", precision: 0, append: "%" },
  { key: "ratingMetascore", name: "MC", precision: 0, append: "%" },
  { key: "ratingTmdbValue", name: "TMDB", mult: 10, precision: 0, append: "%" },
  { key: "ratingRt", name: "RT", precision: 0, append: "%" },
  {
    key: "ratingImdbPersonal",
    name: "My Rating",
    mult: 10,
    precision: 0,
    append: "%",
  },
];
export const textColumns: StringCol<CleanMovie>[] = [
  {
    key: "title",
    name: "Title",
    sortable: true,
  },
  {
    key: "directors",
    name: "Director",
    sortable: true,
    fieldRenderer: Directors,
  },
  { key: "releaseDate", name: "Release", sortable: true },
  {
    key: "tags",
    name: "Tags",
    fieldRenderer: Tags,
  },
  {
    key: "collections",
    name: "Collections",
    fieldRenderer: Collections,
  },
];

export const defaultSort: DefaultSort<CleanMovie> = ["releaseDate", "DESC"];
export const defaultFilter: FilterColKey<CleanMovie>[] = [
  "directors",
  "tags",
  "collections",
];
export const defaultVisible: DefaultVisible<CleanMovie> = [
  "Controls",
  "title",
  "directors",
  "releaseDate",
  "tags",
];

export const gridCols: GridCols<CleanMovie> = {
  art: "poster",
  width: 150,
  height: 220,
  cols: [textColumns[0], textColumns[1], textColumns[2]],
};
