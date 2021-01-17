import { Movie as OMDBMovie } from "imdb-api";
import { MovieResponse as TMDBMovie } from "moviedb-promise/dist/request-types";
import { default as PTPMovie } from "passthepopcorn/lib/objects/movie";
import { PtpMovieScrape } from "./scrape/ptp";

export interface Movie {
  id?: { imdb?: string; tmdb?: string; ptp?: number };
  title?: string;
  originalTitle?: string;
  /** Raw dump from NFO file */
  raw?: any;
  tmdb?: TMDBMovie | null;
  omdb?: OMDBMovie | null;
  imdb?: { myRating: { value: number; date: string } };
  ptp?: PTPMovie | null;
  ptpScrape?: PtpMovieScrape | null;
}

export interface Library {
  nfoFiles: string[];
  /** NFO files which failed to parse */
  failedNfos: string[];
  movies: { [file: string]: Movie };
}
