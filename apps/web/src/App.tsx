import React, { useEffect, useState } from "react";
import Movie from "./Browser/Movie.jsx";

// import Movie from "./Movie";
import Select from "react-select";
import Music from "./Browser/Music.jsx";
import { SpotifyProvider } from "./Browser/SpotifyContext.js";

import "rc-slider/assets/index.css";
import "react-data-grid/lib/styles.css";
import "react-tooltip/dist/react-tooltip.css";

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

type Mode = "movie" | "music" | "playlist";
interface Library {
  value: Mode;
  label: string;
}

function App() {
  const [darkMode, setDarkMode] = useState<boolean>(false);

  const [libraries, setLibraries] = useState<Library[]>([
    { value: "movie", label: "Movies" },
    { value: "music", label: "Music" },
    { value: "playlist", label: "Playlist" },
  ]);

  const [selectedLibrary, setSelectedLibrary] = useState<Library>();

  useEffect(() => {
    if (!selectedLibrary) {
      const savedMode = parseMode(localStorage.getItem("mode"));
      const savedLibrary = libraries.find(
        (library) => library.value === savedMode
      );
      if (savedLibrary) setSelectedLibrary(savedLibrary);
      else setSelectedLibrary(libraries[0]);
    }
  }, [libraries, selectedLibrary]);

  useEffect(() => {
    selectedLibrary?.value &&
      localStorage.setItem("mode", selectedLibrary?.value);
  }, [selectedLibrary?.value]);

  return (
    <SpotifyProvider>
      <div id="app-root" className={darkMode ? "dark" : ""}>
        <div className={"app-header"}>
          <Select
            hideSelectedOptions={false}
            isClearable={false}
            placeholder="Library"
            className={"filter-select"}
            value={selectedLibrary}
            onChange={(lib) => {
              if (lib) setSelectedLibrary(lib);
            }}
            options={libraries}
            theme={(theme) => ({
              ...theme,
              colors: {
                ...theme.colors,
                primary25: "#00ffab24",
                primary50: "#00ffab50",
                primary75: "#00ffab",
                primary: "#00c583",
              },
            })}
          />
          {/* <button type="button" onClick={() => setDarkMode(!darkMode)}>
          {darkMode ? "Light" : "Dark"}
        </button> */}
        </div>

        {selectedLibrary?.value === "movie" ? <Movie></Movie> : null}
        {selectedLibrary?.value === "music" ? (
          <Music darkMode={darkMode} mode={"albums"}></Music>
        ) : null}
        {selectedLibrary?.value === "playlist" ? (
          <Music darkMode={darkMode} mode={"playlist"}></Music>
        ) : null}
      </div>
    </SpotifyProvider>
  );
}

export default App;
