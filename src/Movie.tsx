import axios from "axios";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid, { Column, Filters, SortDirection } from "react-data-grid";
import "react-data-grid/dist/react-data-grid.css";
import { CleanMovie } from "../../movie-scraper/src/movie/clean";
import { NumericFilter } from "./NumericFilter";

const columns: Column<CleanMovie>[] = [
  { key: "title", name: "Title", sortable: true },
  { key: "releaseDate", name: "Release" },
  {
    key: "ratingImdbValue",
    name: "IMDB",
    sortable: true,
    filterRenderer: NumericFilter,
  },
  { key: "ratingPtpValue", name: "PTP", sortable: true },
  { key: "ratingMetascore", name: "MC", sortable: true },
  { key: "ratingTmdbValue", name: "TMDB", sortable: true },
  { key: "ratingRt", name: "RT", sortable: true },
  { key: "ratingImdbPersonal", name: "My Rating", sortable: true },
];

function Movie() {
  const [rowData, setData] = useState<{ rows: CleanMovie[] }>({ rows: [] });
  const [[sortColumn, sortDirection], setSort] = useState<
    [string, SortDirection]
  >(["title", "DESC"]);

  const [filters, setFilters] = useState<Filters>({
    ratingImdbValue: "",
  });
  const [enableFilterRow, setEnableFilterRow] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      const result = await axios("/lib.json");

      setData({ rows: result.data });
    };

    fetchData();
  }, []);

  const sortedRows = useMemo(() => {
    if (sortDirection === "NONE") return rowData.rows;

    let sortedRows = [...rowData.rows];

    switch (sortColumn) {
      case "title":
      case "releaseDate":
        sortedRows = sortedRows.sort((a, b) =>
          (a[sortColumn] ?? "").localeCompare(b[sortColumn] ?? "")
        );
        break;
      case "ratingImdbValue":
      case "ratingPtpValue":
      case "ratingMetascore":
      case "ratingTmdbValue":
      case "ratingRt":
      case "ratingImdbPersonal":
        sortedRows = sortedRows.sort((a, b) =>
          typeof a[sortColumn] === "undefined"
            ? -1
            : a[sortColumn]! - (b[sortColumn] ?? -Infinity)
        );
        break;
      default:
    }

    return sortDirection === "DESC" ? sortedRows.reverse() : sortedRows;
  }, [rowData.rows, sortDirection, sortColumn]);

  const filteredRows = useMemo(() => {
    return sortedRows.filter((r) => {
      return filters.ratingImdbValue
        ? filters.ratingImdbValue.filterValues(
            r,
            filters.ratingImdbValue,
            "ratingImdbValue"
          )
        : true;
    });
  }, [sortedRows, filters]);

  function clearFilters() {
    setFilters({
      ratingImdbValue: "",
    });
  }

  function toggleFilters() {
    setEnableFilterRow(!enableFilterRow);
  }

  const handleSort = useCallback(
    (columnKey: string, direction: SortDirection) => {
      setSort([columnKey, direction]);
    },
    []
  );

  return (
    <>
      <div className="header-filters-toolbar">
        <button type="button" onClick={toggleFilters}>
          Toggle Filters
        </button>
        <button type="button" onClick={clearFilters}>
          Clear Filters
        </button>
      </div>
      <DataGrid
        columns={columns}
        rows={filteredRows}
        rowClass={(row) => (row.watched ? "watched" : "unwatched")}
        defaultColumnOptions={{
          sortable: true,
          resizable: true,
        }}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        enableFilterRow={enableFilterRow}
        filters={filters}
        onFiltersChange={setFilters}
        className="fill-grid"
      />
    </>
  );
}

export default Movie;
