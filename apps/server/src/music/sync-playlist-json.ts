import { SyncPlaylist, CleanAlbum } from "data-types";

export const playlistToSync: SyncPlaylist<CleanAlbum>[] = [
  // Top 30 albums added - Years 2012-2023
  ...new Array(2023 - 2012 + 1)
    .fill(1)
    .map((_, i) => i + 2012)
    .map((year) => {
      const yearPlaylist: SyncPlaylist<CleanAlbum> = {
        name: `${year} Most Played`,
        filters: [
          {
            field: "dateAdded",
            min: new Date(`${year}`).getTime(),
            max: new Date(`${year + 1}`).getTime() - 1,
            includeUndefined: false,
          },
        ],
        sort: ["scrobbles", "DESC"],
        limit: 30,
        // Only do exhaustive update comparison for 2023
        lazyUpdate: year !== 2023,
      };
      return yearPlaylist;
    }),

  // RYM Top 20 albums - Years 1993-2023
  ...new Array(2023 - 1993 + 1)
    .fill(1)
    .map((_, i) => i + 1993)
    .map((year) => {
      const yearPlaylist: SyncPlaylist<CleanAlbum> = {
        name: `${year} Top Albums - by RYM rating`,
        filters: [
          {
            field: "dateReleased",
            min: new Date(`${year}`).getTime(),
            max: new Date(`${year + 1}`).getTime() - 1,
            includeUndefined: false,
          },
        ],
        sort: ["ratingRymValue", "DESC"],
        limit: 20,
        // Only do exhaustive update comparison for 2023
        lazyUpdate: year !== 2023,
      };
      return yearPlaylist;
    }),

  // Discogs Top 20 albums - Years 1993-2023
  ...new Array(2023 - 1993 + 1)
    .fill(1)
    .map((_, i) => i + 1993)
    .map((year) => {
      const yearPlaylist: SyncPlaylist<CleanAlbum> = {
        name: `${year} Top Albums - by Discogs rating`,
        filters: [
          {
            field: "dateReleased",
            min: new Date(`${year}`).getTime(),
            max: new Date(`${year + 1}`).getTime() - 1,
            includeUndefined: false,
          },
        ],
        sort: ["ratingDiscogsValue", "DESC"],
        limit: 20,
        // Only do exhaustive update comparison for 2023
        lazyUpdate: year !== 2023,
      };
      return yearPlaylist;
    }),
  ...new Array(2023 - 1993 + 1)
    .fill(1)
    .map((_, i) => i + 1993)
    .map((year) => {
      const yearPlaylist: SyncPlaylist<CleanAlbum> = {
        name: `${year} Top Albums - less than 10 scrobbles - by RYM rating`,
        filters: [
          {
            field: "dateReleased",
            min: new Date(`${year}`).getTime(),
            max: new Date(`${year + 1}`).getTime() - 1,
            includeUndefined: false,
          },
          { field: "scrobbles", max: 10, min: 0, includeUndefined: true },
        ],
        sort: ["ratingRymValue", "DESC"],
        limit: 20,
        // Only do exhaustive update comparison for 2023
        lazyUpdate: year !== 2023,
      };
      return yearPlaylist;
    }),

  {
    name: "Ambient (sorted by energy)",
    sort: ["energy", "ASC"],
    filters: [
      {
        field: "genres",
        value: "ambient",
      },
      {
        field: "genres",
        value: "drill and bass",
        exclude: true,
      },
      {
        field: "genres",
        value: "intelligent dance music",
        exclude: true,
      },
      {
        field: "genres",
        value: "uk bass",
        exclude: true,
      },
      {
        field: "genres",
        value: "microhouse",
        exclude: true,
      },
      {
        field: "genres",
        value: "house",
        exclude: true,
      },
      {
        field: "genres",
        value: "techno",
        exclude: true,
      },
      {
        field: "genres",
        value: "trance",
        exclude: true,
      },
      {
        field: "genres",
        value: "tech house",
        exclude: true,
      },
      {
        field: "genres",
        value: "deconstructed club",
        exclude: true,
      },
      {
        field: "genres",
        value: "rock",
        exclude: true,
      },
      {
        field: "genres",
        value: "glitch",
        exclude: true,
      },
      {
        field: "genres",
        value: "glitch pop",
        exclude: true,
      },
      {
        field: "genres",
        value: "ebm",
        exclude: true,
      },
      {
        field: "genres",
        value: "idm",
        exclude: true,
      },
      {
        field: "genres",
        value: "breaks",
        exclude: true,
      },
      {
        field: "genres",
        value: "jungle",
        exclude: true,
      },
      {
        field: "genres",
        value: "footwork",
        exclude: true,
      },
      {
        field: "genres",
        value: "dreampunk",
        exclude: true,
      },
      {
        field: "genres",
        value: "juke",
        exclude: true,
      },
      {
        field: "genres",
        value: "uk garage",
        exclude: true,
      },
      {
        field: "genres",
        value: "bass music",
        exclude: true,
      },
      {
        field: "genres",
        value: "trap",
        exclude: true,
      },
      {
        field: "genres",
        value: "hip hop",
        exclude: true,
      },
      {
        field: "genres",
        value: "future funk",
        exclude: true,
      },
      {
        field: "genres",
        value: "vaporwave",
        exclude: true,
      },
      {
        field: "genres",
        value: "vaportrap",
        exclude: true,
      },
      {
        field: "genres",
        value: "electropop",
        exclude: true,
      },
      {
        field: "genres",
        value: "italian disco",
        exclude: true,
      },
      {
        field: "genres",
        value: "swedish electropop",
        exclude: true,
      },
      {
        field: "genres",
        value: "swedish synthpop",
        exclude: true,
      },
      {
        field: "genres",
        value: "synthpop",
        exclude: true,
      },
      {
        field: "genres",
        value: "dance-pop",
        exclude: true,
      },
      {
        field: "genres",
        value: "italo disco",
        exclude: true,
      },
      {
        field: "genres",
        value: "dub techno",
        exclude: true,
      },
      {
        field: "genres",
        value: "dub",
        exclude: true,
      },
      {
        field: "genres",
        value: "experimental dub",
        exclude: true,
      },
      {
        field: "genres",
        value: "reggae",
        exclude: true,
      },
      {
        field: "genres",
        value: "jazztronica",
        exclude: true,
      },
      {
        field: "genres",
        value: "nu jazz",
        exclude: true,
      },
      {
        field: "genres",
        value: "future jazz",
        exclude: true,
      },
      {
        field: "genres",
        value: "trip-hop",
        exclude: true,
      },
      {
        field: "genres",
        value: "trip hop",
        exclude: true,
      },
      {
        field: "genres",
        value: "alternative dance",
        exclude: true,
      },
      {
        field: "genres",
        value: "electro",
        exclude: true,
      },
      {
        field: "genres",
        value: "chillwave",
        exclude: true,
      },
      {
        field: "genres",
        value: "float house",
        exclude: true,
      },
      {
        field: "genres",
        value: "deep house",
        exclude: true,
      },
      {
        field: "genres",
        value: "experimental r&b",
        exclude: true,
      },
      {
        field: "genres",
        value: "funk / soul",
        exclude: true,
      },
    ],
    limit: 100,
    // forceRecreate: true,
  },
  {
    name: "Ambient albums",
    filters: [{ field: "genres", value: "ambient" }],
    sort: ["dateAdded", "DESC"],
    limit: 100,
    // forceRecreate: true,
  },
  {
    name: "Funk / soul albums",
    filters: [{ field: "genres", value: "funk / soul" }],
    sort: ["dateAdded", "DESC"],
    limit: 100,
    // forceRecreate: true,
  },
  {
    name: "Alt rock albums (sorted by RYM)",
    filters: [{ field: "genres", value: "alternative rock" }],
    sort: ["ratingRymValue", "DESC"],
    limit: 100,
    // forceRecreate: true,
  },
  {
    name: "Jazz albums (sorted by scrobbles)",
    sort: ["scrobbles", "ASC"],
    filters: [
      {
        value: "cool jazz",
        field: "genres",
      },
      {
        value: "hard bop",
        field: "genres",
      },
      {
        value: "avant-garde jazz",
        field: "genres",
      },
      {
        value: "spiritual jazz",
        field: "genres",
      },
      {
        value: "modal",
        field: "genres",
      },
      {
        value: "bebop",
        field: "genres",
      },
      {
        value: "afro-jazz",
        field: "genres",
      },
      {
        value: "progressive jazz",
        field: "genres",
      },
    ],
    limit: 100,
    // forceRecreate: true,
  },
  {
    name: "House (high energy/danceability)",
    filters: [
      { field: "danceability", max: 1, min: 0.4, includeUndefined: false },
      { field: "energy", max: 1, min: 0.4, includeUndefined: false },
      {
        value: "deep house",
        field: "genres",
      },
      {
        value: "electro house",
        field: "genres",
      },
      {
        value: "house",
        field: "genres",
      },
      {
        value: "microhouse",
        field: "genres",
      },
      {
        value: "float house",
        field: "genres",
      },
      {
        value: "tech house",
        field: "genres",
      },
      {
        value: "outsider house",
        field: "genres",
      },
      {
        value: "ambient house",
        field: "genres",
      },
      {
        value: "filter house",
        field: "genres",
      },
      {
        value: "minimal tech house",
        field: "genres",
      },
      {
        value: "lo-fi house",
        field: "genres",
      },
      {
        value: "progressive house",
        field: "genres",
      },
      {
        value: "acid house",
        field: "genres",
      },
      {
        value: "uk house",
        field: "genres",
      },
      {
        value: "garage house",
        field: "genres",
      },
      {
        value: "deep disco house",
        field: "genres",
      },
      {
        value: "canadian house",
        field: "genres",
      },
      {
        value: "detroit house",
        field: "genres",
      },
      {
        value: "experimental house",
        field: "genres",
      },
      {
        value: "swedish house",
        field: "genres",
      },
      {
        value: "disco house",
        field: "genres",
      },
      {
        value: "french house",
        field: "genres",
      },
      {
        value: "euro house",
        field: "genres",
      },
      {
        value: "japanese house",
        field: "genres",
      },
      {
        value: "deep soul house",
        field: "genres",
      },
      {
        value: "german house",
        field: "genres",
      },
      {
        value: "tropical house",
        field: "genres",
      },
      {
        value: "funky house",
        field: "genres",
      },
      {
        value: "organic house",
        field: "genres",
      },
      {
        value: "tech-house",
        field: "genres",
      },
      {
        value: "deep groove house",
        field: "genres",
      },
      {
        value: "afro-house",
        field: "genres",
      },
      {
        value: "australian house",
        field: "genres",
      },
      {
        value: "deep euro house",
        field: "genres",
      },
      {
        value: "progressive electro house",
        field: "genres",
      },
      {
        value: "classical",
        field: "genres",
        exclude: true,
      },
    ],
    limit: 100,
    // forceRecreate: true,
  },
  {
    name: "Power pop/punk/emo (sorted by RYM)",
    filters: [
      { value: "power pop", field: "genres" },
      { value: "pop punk", field: "genres" },
      { value: "bubblegrunge", field: "genres" },
      { value: "emo", field: "genres" },
      { value: "modern power pop", field: "genres" },
      { value: "alternative emo", field: "genres" },
      { value: "synth punk", field: "genres" },
    ],
    sort: ["ratingRymValue", "DESC"],
    limit: 100,
    // forceRecreate: true,
  },

  {
    name: "Folk (sorted by RYM)",
    filters: [
      { value: "electronic", field: "genres", exclude: true },
      { value: "alternative rock", field: "genres", exclude: true },
      { value: "idm", field: "genres", exclude: true },
      { value: "hip hop", field: "genres", exclude: true },
      { value: "alternative dance", field: "genres", exclude: true },
      { value: "funk / soul", field: "genres", exclude: true },
      { value: "freak folk", field: "genres" },
      { value: "electropop", field: "genres", exclude: true },
      { value: "synthpop", field: "genres", exclude: true },
      { value: "soul", field: "genres", exclude: true },
      { value: "folk, world, & country", field: "genres" },
      { value: "psychedelic rock", field: "genres", exclude: true },
      { value: "folk", field: "genres" },
      { value: "post-rock", field: "genres", exclude: true },
      { value: "funk", field: "genres", exclude: true },
      { value: "indie folk", field: "genres" },
      { value: "rnb", field: "genres", exclude: true },
      { value: "hip-hop", field: "genres", exclude: true },
      { value: "folk rock", field: "genres" },
      { value: "rap", field: "genres", exclude: true },
      { value: "industrial", field: "genres", exclude: true },
      { value: "glam rock", field: "genres", exclude: true },
      { value: "post-metal", field: "genres", exclude: true },
      { value: "art punk", field: "genres", exclude: true },
      { value: "black metal", field: "genres", exclude: true },
      { value: "chamber folk", field: "genres" },
      { value: "contemporary folk", field: "genres" },
      { value: "pop soul", field: "genres", exclude: true },
      { value: "avant-folk", field: "genres" },
      { value: "psychedelic folk", field: "genres" },
      { value: "glam", field: "genres", exclude: true },
      { value: "metal", field: "genres", exclude: true },
      { value: "heavy metal", field: "genres", exclude: true },
      { value: "neofolk", field: "genres" },
      { value: "folk pop", field: "genres" },
      { value: "sludge metal", field: "genres", exclude: true },
      { value: "experimental folk", field: "genres" },
      { value: "modern folk rock", field: "genres" },
      { value: "hypnagogic pop", field: "genres", exclude: true },
      { value: "new wave pop", field: "genres", exclude: true },
    ],
    sort: ["ratingRymValue", "DESC"],
  },
  {
    name: "Baroque/chamber pop (sorted by RYM)",
    filters: [
      { value: "chamber pop", field: "genres" },
      { value: "baroque pop", field: "genres" },
    ],
    sort: ["ratingRymValue", "DESC"],
  },
  {
    name: "Dance pop (sorted by RYM)",
    filters: [
      { value: "dance pop", field: "genres" },
      { value: "electropop", field: "genres" },
      { value: "dance-pop", field: "genres" },
      { value: "nu-disco", field: "genres" },
      { value: "eurodance", field: "genres" },
      { value: "europop", field: "genres" },
      { value: "electro-disco", field: "genres" },
    ],
    sort: ["ratingRymValue", "DESC"],
    limit: 100,
  },
];
