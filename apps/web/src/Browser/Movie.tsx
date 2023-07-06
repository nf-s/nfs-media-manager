import { CleanMovie } from "data-types";
import React, { useEffect, useState } from "react";
import * as Movie from "../Models/Movie.jsx";
import Browser from "./Browser.jsx";

export default function M(/* props: { darkMode: boolean } */) {
  const [movieData, setMovieData] = useState<{
    rows: CleanMovie[];
  }>({ rows: [] });

  useEffect(() => {
    if (movieData.rows.length > 0) return;
    const fetchData = async () => {
      const movies = (await (
        await fetch("/lib-movie.json")
      ).json()) as CleanMovie[];

      setMovieData({
        rows: movies,
      });
    };

    fetchData();
  }, [movieData]);

  return (
    <div className="root-movie">
      <Browser
        tag={"movie"}
        rows={movieData.rows}
        columnsConfig={Movie.columnsConfig}
      />
    </div>
  );
}
