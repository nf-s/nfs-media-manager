import { library } from ".";

export interface CleanMovie {
  title: string;
  watched: boolean;
  ratingImdbPersonal?: number;
  ratingImdbPersonalDate?: string;
  releaseDate?: string;
  ratingImdbValue?: number;
  ratingImdbVotes?: number;
  ratingPtpValue?: number;
  ratingPtpVotes?: number;
  ratingTmdbValue?: number;
  ratingTmdbVotes?: number;
  ratingMetascore?: number;
  ratingRt?: number;
}

export type CleanLibrary = CleanMovie[];

export async function clean(): Promise<CleanLibrary> {
  return Object.values(library.movies)
    .filter((m) => m.title)
    .map((movie) => {
      const cleanMovie: CleanMovie = {
        title: movie.title!,
        watched: typeof movie.imdb?.myRating.value !== "undefined",
        releaseDate: movie.tmdb?.release_date,
        ratingImdbPersonal: movie.imdb?.myRating.value,
        ratingImdbPersonalDate: movie.imdb?.myRating.date,
        ratingTmdbValue: movie.tmdb?.vote_average,
        ratingTmdbVotes: movie.tmdb?.vote_count,
        ratingPtpValue: movie.ptpScrape?.rating.value,
        ratingPtpVotes: movie.ptpScrape?.rating.votes,
        ratingImdbValue: movie.omdb?.rating,
        ratingImdbVotes: movie.omdb?.votes
          ? parseInt(movie.omdb.votes.replace(/\D/g, ""), 10)
          : undefined,
        ratingMetascore: movie.omdb?.metascore
          ? parseInt(movie.omdb?.metascore.replace(/\D/g, ""), 10)
          : undefined,
      };

      // RT rating
      const rt = movie.omdb?.ratings?.find(
        (rating) => rating.source === "Rotten Tomatoes"
      )?.value;
      if (rt) cleanMovie.ratingRt = parseInt(rt.replace(/\D/g, ""), 10);

      return cleanMovie;
    });
}
