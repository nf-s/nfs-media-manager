import debugPkg from "debug";
import { run as runMusic } from "./music/index.js";
import { run as runMovie } from "./movie/index.js";

const debug = debugPkg.debug("scraper:init");

debug("HELLO!");

const args = process.argv.slice(2);

if (args[0] === "music") {
  await runMusic();
} else if (args[0] === "movie") {
  await runMovie();
} else {
  debug("No valid arg");
}

process.exit();
