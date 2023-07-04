import React, { useEffect, useState } from "react";
import { CleanMovie } from "data-types";
import Browser from "./Browser.jsx";
import * as Movie from "../Models/Movie.jsx";

export default function M(/* props: { darkMode: boolean } */) {
  const [movieData, setMovieData] = useState<{
    rows: CleanMovie[];
  }>({ rows: [] });

  useEffect(() => {
    const fetchData = async () => {
      const movies = (await (
        await fetch("/lib-movie.json")
      ).json()) as CleanMovie[];

      setMovieData({
        rows: movies,
      });
    };

    fetchData();
  }, []);

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
