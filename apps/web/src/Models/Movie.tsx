import { faImdb } from "@fortawesome/free-brands-svg-icons";
import { faFilm, faSquareMinus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { CleanMovie, timeToDateString } from "data-types";
import React from "react";
import { LinksColumn, LinksRenderer } from "../Table/FieldRenderer.js";
import { ArrayFilterRenderer } from "../Table/ColumnFilters.jsx";
import { ColumnsConfig } from "../Table/ColumnState.js";

const MovieLinkRenderer = LinksRenderer([
  {
    key: "imdb",
    img: (
      <span>
        <FontAwesomeIcon
          icon={faImdb}
          style={{ color: "#000", background: "#f5c518" }}
          size="1x"
        />
      </span>
    ),
    alt: "IMDB link",
  },
  {
    key: "tmdb",
    img: <FontAwesomeIcon icon={faSquareMinus} style={{ color: "#01b4e4" }} />,
    alt: "TMDB link",
  },
  { key: "ptp", img: <FontAwesomeIcon icon={faFilm} />, alt: "PTP link" },
]);

export const columnsConfig: ColumnsConfig<CleanMovie> = {
  id: "id",
  data: [
    {
      type: "string",
      key: "title",
      name: "Title",
      sortable: true,
      enableFilter: true,
    },
    {
      type: "string",
      key: "source",
      name: "Source",
      sortable: true,
      enableFilter: true,
      enableRowFilter: true,
      filterLabel: (value) =>
        ({
          file: "File",
          bluray: "Bluray",
          "imdb-rating": "IMDB Rating",
          "imdb-watchlist": "IMDB Watchlist",
          "ptp-bookmark": "PTP Bookmark",
        }[value] ?? value),
    },
    {
      type: "string",
      key: "description",
      name: "Description",
      sortable: false,
    },
    { type: "string", key: "awards", name: "Awards", sortable: false },
    {
      type: "string",
      key: "directors",
      name: "Director",
      sortable: true,
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
    },
    {
      type: "string",
      key: "actors",
      name: "Actors",
      sortable: true,
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
    },
    {
      type: "string",
      key: "writers",
      name: "Writers",
      sortable: true,
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
    },
    {
      type: "string",
      key: "countries",
      name: "Countries",
      sortable: true,
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
    },
    {
      type: "string",
      key: "languages",
      name: "Languages",
      sortable: true,
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
    },
    {
      type: "string",
      key: "productionCompanies",
      name: "Production Companies",
      sortable: true,
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
    },
    {
      type: "string",
      key: "tags",
      name: "Tags",
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
    },
    {
      type: "string",
      key: "collections",
      name: "Collections",
      fieldRenderer: ArrayFilterRenderer,
      enableFilter: true,
    },
    { type: "string", key: "watched", name: "Watched", enableFilter: true },
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
  ],
  custom: [LinksColumn(MovieLinkRenderer)],
  grid: {
    art: "poster",
    width: 150,
    height: 220,
    cols: ["title", "directors", "releaseDate"],
    links: MovieLinkRenderer,
  },
  defaultVisible: [
    "Controls",
    "Links",
    "title",
    "directors",
    "releaseDate",
    "tags",
  ],
  defaultSort: ["releaseDate", "DESC"],
};
