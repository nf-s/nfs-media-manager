export interface CleanMovie {
  id: string;
  title: string;
  poster?: string;
  directors: string[];
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
  tags?: string[];
  collections?: string[];
}
