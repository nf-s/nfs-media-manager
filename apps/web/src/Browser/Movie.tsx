import axios from "axios";
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
      const library = await axios.default("/lib-movie.json");

      const movies = library.data as CleanMovie[];

      setMovieData({
        rows: movies,
      });
    };

    fetchData();
  }, []);

  return (
    <div className="root-music">
      <Browser
        tag={"movie"}
        rows={movieData.rows}
        defaultSort={Movie.defaultSort}
        defaultVisible={Movie.defaultVisible}
        dataColumns={Movie.dataColumns}
        gridColumns={Movie.gridCols}
        customColumns={[]}
      />
    </div>
  );
}
