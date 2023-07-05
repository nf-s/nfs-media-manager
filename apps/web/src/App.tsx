import React, { useEffect, useState } from "react";
import Movie from "./Browser/Movie.jsx";

// import Movie from "./Movie";
import Music from "./Browser/Music.jsx";
import { SpotifyProvider } from "./Browser/SpotifyContext.js";

function parseMode(
  mode: string | null
): "movie" | "music" | "playlist" | undefined {
  switch (mode) {
    case "movie":
      return "movie";
    case "music":
      return "music";
    case "playlist":
      return "playlist";
  }
  return;
}

function App() {
  const [mode, setMode] = useState<{ mode: "movie" | "music" | "playlist" }>({
    mode: parseMode(localStorage.getItem("mode")) ?? "music",
  });
  const [darkMode, setDarkMode] = useState<boolean>(false);

  useEffect(() => {
    localStorage.setItem("mode", mode.mode);
  }, [mode]);

  return (
    <div id="root" className={darkMode ? "dark" : ""}>
      <div className={"toolbar"}>
        <button type="button" onClick={() => setMode({ mode: "movie" })}>
          Movies
        </button>
        <button type="button" onClick={() => setMode({ mode: "music" })}>
          Music
        </button>
        <button type="button" onClick={() => setMode({ mode: "playlist" })}>
          Playlist
        </button>
        <button type="button" onClick={() => setDarkMode(!darkMode)}>
          {darkMode ? "Light" : "Dark"}
        </button>
      </div>

      {mode.mode === "movie" ? <Movie></Movie> : null}
      {mode.mode === "music" ? (
        <SpotifyProvider>
          <Music darkMode={darkMode} mode={"albums"}></Music>
        </SpotifyProvider>
      ) : null}
      {mode.mode === "playlist" ? (
        <SpotifyProvider>
          <Music darkMode={darkMode} mode={"playlist"}></Music>
        </SpotifyProvider>
      ) : null}
    </div>
  );
}

export default App;
