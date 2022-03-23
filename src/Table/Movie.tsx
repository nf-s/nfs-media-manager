import { CleanMovie } from "../../../movie-scraper/src/movie/interfaces";
import {
  BooleanCol,
  DefaultSort,
  DefaultVisible,
  FilterCol,
  GridCols,
  NumericCol,
  StringCol,
} from "./Columns";
import { timeToDateString } from "./Date";
import { ArrayFilterRenderer } from "./Filters";

export const booleanCols: BooleanCol<CleanMovie>[] = [
  { type: "boolean", key: "watched", name: "Watched" },
];
export const numericCols: NumericCol<CleanMovie>[] = [
  {
    type: "numeric",
    key: "releaseDate",
    name: "Added",
    sortable: true,
    width: 120,
    resizable: false,
    numberFormat: timeToDateString,
  },
  {
    type: "numeric",
    key: "ratingImdbValue",
    name: "IMDB",
    mult: 10,
    precision: 0,
    append: "%",
  },
  {
    type: "numeric",
    key: "ratingPtpValue",
    name: "PTP",
    precision: 0,
    append: "%",
  },
  {
    type: "numeric",
    key: "ratingMetascore",
    name: "MC",
    precision: 0,
    append: "%",
  },
  {
    type: "numeric",
    key: "ratingTmdbValue",
    name: "TMDB",
    mult: 10,
    precision: 0,
    append: "%",
  },
  { type: "numeric", key: "ratingRt", name: "RT", precision: 0, append: "%" },
  {
    type: "numeric",
    key: "ratingImdbPersonal",
    name: "My Rating",
    mult: 10,
    precision: 0,
    append: "%",
  },
];
export const textColumns: StringCol<CleanMovie>[] = [
  { type: "string", key: "title", name: "Title", sortable: true },
  {
    type: "string",
    key: "directors",
    name: "Director",
    sortable: true,
    fieldRenderer: ArrayFilterRenderer<CleanMovie>("directors", "id"),
  },
  {
    type: "string",
    key: "tags",
    name: "Tags",
    fieldRenderer: ArrayFilterRenderer<CleanMovie>("tags", "id"),
  },
  {
    type: "string",
    key: "collections",
    name: "Collections",
    fieldRenderer: ArrayFilterRenderer<CleanMovie>("collections", "id"),
  },
];

export const defaultSort: DefaultSort<CleanMovie> = ["releaseDate", "DESC"];
export const defaultFilter: FilterCol<CleanMovie>[] = [
  { key: "directors" },
  { key: "tags" },
  { key: "collections" },
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
  cols: [textColumns[0], textColumns[1], numericCols[0]],
};
