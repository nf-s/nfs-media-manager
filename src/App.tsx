import React, { useEffect, useState } from "react";
import "react-data-grid/dist/react-data-grid.css";
import Movie from "./Movie";
import Music from "./Music";
import { SpotifyAuth } from "./Spotify";

function App() {
  const [spotifyAuthToken, setSpotifyAuthToken] = useState<string>();

  useEffect(() => {
    const spotifyAuth = new SpotifyAuth(setSpotifyAuthToken);
    spotifyAuth.init();
  }, []);

  const [mode, setMode] = useState<{ mode: "movie" | "music" }>({
    mode: "music",
  });

  return (
    <>
      <button type="button" onClick={() => setMode({ mode: "movie" })}>
        Movies
      </button>
      <button type="button" onClick={() => setMode({ mode: "music" })}>
        Music
      </button>

      {mode.mode === "movie" ? <Movie></Movie> : null}
      {mode.mode === "music" && spotifyAuthToken ? (
        <Music spotifyToken={spotifyAuthToken}></Music>
      ) : null}
      {mode.mode === "music" && !spotifyAuthToken ? (
        <h2>Fetching Spotify token</h2>
      ) : null}
    </>
  );
}

export default App;
