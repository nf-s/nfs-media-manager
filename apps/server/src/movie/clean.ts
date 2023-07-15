import { library } from "./index.js";
import { CleanMovie } from "data-types";

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

      let runTime = movie.tmdb?.runtime;

      if (!runTime && movie.omdb?.runtime) {
        const omdbRuntime = movie.omdb.runtime.split(" min")?.[0];
        if (omdbRuntime) {
          runTime = parseFloat(omdbRuntime);
        }
      }

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
        description: movie.omdb?.plot ?? movie.tmdb?.overview,
        source:
          movie.owned?.type === "bluray"
            ? "bluray"
            : movie.raw
            ? "file"
            : movie.imdb?.myRating
            ? "imdb-rating"
            : movie.imdb?.myWatchlist
            ? "imdb-watchlist"
            : "ptp-bookmark",
        poster:
          movie.omdb?.poster ?? movie.tmdb?.poster_path
            ? `https://image.tmdb.org/t/p/w154/${movie.tmdb?.poster_path}`
            : undefined,
        directors: movie.omdb?.director
          ? movie.omdb?.director.split(",").map((s) => s.trim())
          : [],
        actors: movie.omdb?.actors
          ? movie.omdb?.actors.split(",").map((s) => s.trim())
          : [],
        writers: movie.omdb?.writer
          ? movie.omdb?.writer.split(",").map((s) => s.trim())
          : [],
        countries: movie.omdb?.country
          ? movie.omdb?.country.split(",").map((s) => s.trim())
          : [],
        languages: movie.omdb?.languages
          ? movie.omdb?.languages.split(",").map((s) => s.trim())
          : [],
        productionCompanies:
          movie.omdb?.production?.split(",")?.map((s) => s.trim()) ??
          (movie.tmdb?.production_companies
            ?.map((p) => p.name)
            ?.filter((n) => n) as undefined | string[]) ??
          [],
        awards: movie.omdb?.awards,
        budget: movie.tmdb?.budget,
        boxOffice: movie.omdb?.boxoffice
          ? parseFloat(
              movie.omdb?.boxoffice
                .replace(",", "")
                .replace(" ", "")
                .replace("$", "")
            )
          : movie.tmdb?.revenue,
        runTime,
        watched:
          typeof movie.imdb?.myRating?.value !== "undefined" ? "Yes" : "No",
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
        popularityTmdb: movie.tmdb?.popularity,
        popularityPtp: movie.ptp?.totalSnatched,
        tags: Array.from(tags),
        collections: movie.ptpScrape?.collections.map((t) => t.name) ?? [],
        links: {
          imdb: {
            href: movie.id?.imdb
              ? `https://www.imdb.com/title/${movie.id?.imdb}/`
              : undefined,
            title: `${movie.omdb?.name}`,
          },
          tmdb: {
            href: movie.tmdb?.id
              ? `https://www.themoviedb.org/movie/${movie.tmdb?.id}`
              : undefined,
            title: `${movie.tmdb?.title}`,
          },
          ptp: {
            href: movie.ptp?.id
              ? `https://passthepopcorn.me/torrents.php?id=${movie.ptp?.id}`
              : undefined,
            title: `${movie.ptp?.title}`,
          },
        },
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
