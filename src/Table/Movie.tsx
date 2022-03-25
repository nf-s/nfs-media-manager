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
    name: "Released",
    sortable: true,
    width: 120,
    resizable: false,
    numberFormat: timeToDateString,
  },
  {
    type: "numeric",
    key: "ratingImdbPersonal",
    name: "My Rating",
    mult: 10,
    precision: 0,
    append: "%",
  },
  {
    type: "numeric",
    key: "ratingImdbValue",
    name: "IMDB Rating",
    mult: 10,
    precision: 0,
    append: "%",
  },
  {
    type: "numeric",
    key: "ratingImdbVotes",
    name: "IMDB Votes",
    append: "",
    precision: 0,
  },
  {
    type: "numeric",
    key: "ratingPtpValue",
    name: "PTP Rating",
    precision: 0,
    append: "%",
  },
  {
    type: "numeric",
    key: "ratingPtpVotes",
    name: "PTP Votes",
    append: "",
    precision: 0,
  },
  {
    type: "numeric",
    key: "popularityPtp",
    name: "PTP Popularity",
    generateMaximumFromData: true,
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    type: "numeric",
    key: "ratingMetascore",
    name: "MC Rating",
    precision: 0,
    append: "%",
  },
  {
    type: "numeric",
    key: "ratingTmdbValue",
    name: "TMDB Rating",
    mult: 10,
    precision: 0,
    append: "%",
  },
  {
    type: "numeric",
    key: "ratingTmdbVotes",
    name: "TMDB Votes",
    append: "",
    precision: 0,
  },
  {
    type: "numeric",
    key: "popularityTmdb",
    name: "TMDB Popularity",
    generateMaximumFromData: true,
    append: "%",
    mult: 100,
    precision: 1,
  },
  {
    type: "numeric",
    key: "ratingRt",
    name: "RT Rating",
    precision: 0,
    append: "%",
  },
  {
    type: "numeric",
    key: "runTime",
    name: "Run time",
    append: "m",
  },
  {
    type: "numeric",
    key: "budget",
    name: "Budget",
  },
  {
    type: "numeric",
    key: "boxOffice",
    name: "Box Office",
  },
];
export const textColumns: StringCol<CleanMovie>[] = [
  { type: "string", key: "title", name: "Title", sortable: true },
  { type: "string", key: "source", name: "Source", sortable: true },
  { type: "string", key: "description", name: "Description", sortable: false },
  { type: "string", key: "awards", name: "Awards", sortable: false },
  {
    type: "string",
    key: "directors",
    name: "Director",
    sortable: true,
    fieldRenderer: ArrayFilterRenderer<CleanMovie>("directors", "id"),
  },
  {
    type: "string",
    key: "actors",
    name: "Actors",
    sortable: true,
    fieldRenderer: ArrayFilterRenderer<CleanMovie>("actors", "id"),
  },
  {
    type: "string",
    key: "writers",
    name: "Writers",
    sortable: true,
    fieldRenderer: ArrayFilterRenderer<CleanMovie>("writers", "id"),
  },
  {
    type: "string",
    key: "countries",
    name: "Countries",
    sortable: true,
    fieldRenderer: ArrayFilterRenderer<CleanMovie>("countries", "id"),
  },
  {
    type: "string",
    key: "languages",
    name: "Languages",
    sortable: true,
    fieldRenderer: ArrayFilterRenderer<CleanMovie>("languages", "id"),
  },
  {
    type: "string",
    key: "productionCompanies",
    name: "Production Companies",
    sortable: true,
    fieldRenderer: ArrayFilterRenderer<CleanMovie>("productionCompanies", "id"),
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
  { key: "title" },
  {
    key: "source",
    label: (value) =>
      ({
        file: "File",
        "imdb-rating": "IMDB Rating",
        "imdb-watchlist": "IMDB Watchlist",
        "ptp-bookmark": "PTP Bookmark",
      }[value] ?? value),
  },
  { key: "directors" },
  { key: "writers" },
  { key: "actors" },
  { key: "countries" },
  { key: "languages" },
  { key: "productionCompanies" },
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
  cols: [textColumns[0], textColumns[4], numericCols[0]],
};
