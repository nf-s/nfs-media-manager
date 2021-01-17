import { Movie as OMDBMovie } from "imdb-api";
import { MovieResponse as TMDBMovie } from "moviedb-promise/dist/request-types";



export interface Movie {

  title?: string;
  originalTitle?: string;
  /** Raw dump from NFO file */
  raw?: any;
  tmdb?: TMDBMovie | null;
  omdb?: OMDBMovie | null;
  imdb?: { myRating: { value: number; date: string } };


}

export interface Library {
  nfoFiles: string[];
  /** NFO files which failed to parse */
  failedNfos: string[];
  movies: { [file: string]: Movie };
}
