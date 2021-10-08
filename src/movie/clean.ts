import { library } from ".";
import { CleanMovie } from "./interfaces";

export type CleanLibrary = CleanMovie[];

export async function clean(): Promise<CleanLibrary> {
  return Object.values(library.movies)
    .filter((m) => m.title)
    .map((movie) => {
      const tags = new Set<string>();

      movie.ptpScrape?.tags.forEach((t) => tags.add(t.trim().toLowerCase()));
      movie.omdb?.genres
        ?.split(", ")
        .forEach((g) => tags.add(g.trim().toLowerCase()));
      movie.tmdb?.genres?.forEach(
        (g) => g.name && tags.add(g.name.trim().toLowerCase())
      );

      const cleanMovie: CleanMovie = {
        id: movie.id?.imdb ?? movie.title!,
        title: movie.title!,
        poster: movie.omdb?.poster,
        directors: movie.omdb?.director ? [movie.omdb?.director] : [],
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
        tags: Array.from(tags),
        collections: movie.ptpScrape?.collections.map((t) => t.name),
      };

      // RT rating
      const rt = movie.omdb?.ratings?.find(
        (rating) => rating.source === "Rotten Tomatoes"
      )?.value;
      if (rt) cleanMovie.ratingRt = parseInt(rt.replace(/\D/g, ""), 10);

      return cleanMovie;
    });
}
