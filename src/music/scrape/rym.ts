import { load } from "cheerio";

export default async function rymChartScrape(url: string) {
  const html = await (
    await fetch("https://rateyourmusic.com/charts/top/album/all-time/g:house/")
  ).text();

  const $ = load(html);
  const tags: string[] = $(`.box_tags li a[href^="torrents.php?taglist="]`)
    .toArray()
    .map((e) => (e.firstChild as any).data);

  const collections = $(
    `#collages #detailsCollections li a[href^="collages.php?id="]`
  )
    .toArray()
    .map((e) => {
      return {
        id: parseInt(e.attribs.href.split("id=")[1]),
        name: (e.firstChild as any).data as string,
        length: parseInt(
          ((e.parent?.lastChild as any).data as string).substr(2).split(")")[0]
        ),
        spoiler: e.attribs.class === "spoiler",
      };
    });

  const similar = $(`#similar_movies_list li a[href^="torrents.php?id="]`)
    .toArray()
    .map((e) => parseInt(e.attribs.href.split("id=")[1]));

  const rating = {
    value: parseInt(
      ($(`#user_rating`)[0].firstChild as any).data.split("%")[0]
    ),
    votes: parseInt(
      ($(`#user_total`)[0].firstChild as any).data.split(" votes")[0]
    ),
  };

  return {
    tags,
    collections,
    similar,
    rating,
  };
}
