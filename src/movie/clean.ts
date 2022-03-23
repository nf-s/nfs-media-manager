import { library } from ".";
import { CleanMovie } from "./interfaces";

export type CleanLibrary = CleanMovie[];

export async function clean(): Promise<CleanLibrary> {
  return Object.values(library.movies)
    .map((movie) => {
      const title = movie.title ?? movie.omdb?.title ?? movie.tmdb?.title;

      if (!title || movie.omdb?.series) return;

      const releaseDate = movie.omdb?.released
        ? new Date(movie.omdb?.released).getTime()
        : movie.tmdb?.release_date
        ? new Date(movie.tmdb!.release_date!).getTime()
        : undefined;
      const tags = new Set<string>();

      movie.ptpScrape?.tags.forEach((t) => tags.add(t.trim().toLowerCase()));
      movie.omdb?.genres
        ?.split(", ")
        .forEach((g) => tags.add(g.trim().toLowerCase()));
      movie.tmdb?.genres?.forEach(
        (g) => g.name && tags.add(g.name.trim().toLowerCase())
      );

      const cleanMovie: CleanMovie = {
        id: movie.id?.imdb ?? title,
        title,
        poster:
          movie.omdb?.poster ?? movie.tmdb?.poster_path
            ? `https://image.tmdb.org/t/p/w154/${movie.tmdb?.poster_path}`
            : undefined,
        directors: movie.omdb?.director
          ? movie.omdb?.director.split(",").map((s) => s.trim())
          : [],
        watched: typeof movie.imdb?.myRating?.value !== "undefined",
        releaseDate,
        ratingImdbPersonal: movie.imdb?.myRating?.value,
        ratingImdbPersonalDate: movie.imdb?.myRating?.date,
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
        collections: movie.ptpScrape?.collections.map((t) => t.name) ?? [],
      };

      // RT rating
      const rt = movie.omdb?.ratings?.find(
        (rating) => rating.source === "Rotten Tomatoes"
      )?.value;
      if (rt) cleanMovie.ratingRt = parseInt(rt.replace(/\D/g, ""), 10);

      return cleanMovie;
    })
    .filter((m) => typeof m !== "undefined") as CleanMovie[];
}
