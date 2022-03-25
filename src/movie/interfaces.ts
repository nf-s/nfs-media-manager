export interface CleanMovie {
  id: string;
  title: string;
  source: "file" | "imdb-rating" | "imdb-watchlist" | "ptp-bookmark";
  description?: string;
  poster?: string;
  directors: string[];
  writers: string[];
  actors: string[];
  countries: string[];
  languages: string[];
  awards?: string;
  watched: boolean;
  ratingImdbPersonal?: number;
  ratingImdbPersonalDate?: string;
  releaseDate?: number;
  ratingImdbValue?: number;
  ratingImdbVotes?: number;
  ratingPtpValue?: number;
  ratingPtpVotes?: number;
  ratingTmdbValue?: number;
  ratingTmdbVotes?: number;
  ratingMetascore?: number;
  ratingRt?: number;
  popularityPtp?: number;
  popularityTmdb?: number;
  boxOffice?: number;
  /** Runtime in minutes */
  runTime?: number;
  budget?: number;
  tags: string[];
  collections: string[];
  productionCompanies: string[];
}
