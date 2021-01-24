import React, { useState } from "react";
import "react-data-grid/dist/react-data-grid.css";
import Movie from "./Movie";
import Music from "./Music";

function App() {
  const [mode, setMode] = useState<{ mode: "movie" | "music" }>({
    mode: "movie",
  });

  return (
    <>
      <button type="button" onClick={() => setMode({ mode: "movie" })}>
        Movies
      </button>
      <button type="button" onClick={() => setMode({ mode: "music" })}>
        Music
      </button>

      {mode.mode === "movie" ? <Movie></Movie> : <Music></Music>}
    </>
  );
}

export default App;
