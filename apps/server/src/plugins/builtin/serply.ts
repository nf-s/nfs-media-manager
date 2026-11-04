import {
  PluginResultSchema,
  ProviderItemNotFoundError,
  ProviderRequestError,
  recordPluginDiagnostic,
  type JsonValue,
  type MediaPluginScrapeContext,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { sanitizeJobDiagnostic } from '@/lib/job-diagnostics'
import { z } from 'zod'
import {
  AlbumCountSchema,
  AlbumHttpUrlSchema,
  AlbumNumberSchema,
  AlbumRymUrlSchema,
  albumNameMatches,
  albumNames,
  albumReference,
  albumSecret,
  requestAlbumJson,
  requireAlbum,
} from './album-provider-helpers'

const ResponseSchema = z.object({ results: z.array(z.unknown()).max(100) })
const ResultSchema = z.object({
  title: z.string(),
  description: z.string().default(''),
  link: AlbumHttpUrlSchema,
  metadata: z
    .object({
      rating: z.unknown().optional(),
      reviews: z.unknown().optional(),
      published_time: z.unknown().optional(),
    })
    .nullish(),
})
const RatingSchema = AlbumNumberSchema.pipe(z.number().min(0).max(5))
const CountSchema = z
  .union([z.number(), z.string().regex(/^(?:\d+|\d{1,3}(?:,\d{3})+)$/)])
  .transform((value) =>
    typeof value === 'string' ? value.replaceAll(',', '') : value,
  )
  .pipe(AlbumCountSchema)
const releaseKinds: Record<string, string> = {
  album: 'album',
  ep: 'ep',
  mixtape: 'mixtape',
  comp: 'compilation',
  single: 'single',
  djmix: 'dj mix',
}

function rymPage(value: string, reviewKind: string | null = null) {
  const parsed = AlbumHttpUrlSchema.safeParse(value)
  if (!parsed.success) return null
  const url = new URL(parsed.data)
  const base = new URL(url)
  base.pathname = base.pathname.replace(
    /\/(?:reviews|lists)(?:\/\d+)?\/?$/,
    '/',
  )
  if (!AlbumRymUrlSchema.safeParse(base.href).success) return null
  const parts = base.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const review = parts[0] === 'music-review'
  if (
    !review &&
    !['album', 'ep', 'mixtape', 'comp', 'single', 'djmix'].includes(
      parts[1] ?? '',
    )
  )
    return null
  const artist = parts[2]
  const title = parts[3]?.replace(/\.p$/, '')
  if (!artist || !title) return null
  base.search = ''
  base.hash = ''
  const release = new URL(base)
  if (review && reviewKind)
    release.pathname = `/release/${reviewKind}/${parts[2]}/${parts[3]}/`
  release.search = ''
  release.hash = ''
  release.protocol = 'https:'
  release.hostname = 'rateyourmusic.com'
  // Compare release identity without .p, but retain the observed URL and
  // primary-issue rating scope rather than assuming identical aggregates.
  release.pathname = `${release.pathname.replace(/\/$/, '').replace(/\.p$/, '')}/`
  return {
    artist,
    title,
    releaseUrl: release.href,
    referenceUrl: base.href,
    review,
    child: base.pathname !== url.pathname,
    primaryIssue: /\.p$/.test(parts[3] ?? ''),
    single: review ? reviewKind === 'single' : parts[1] === 'single',
    kind: review ? (reviewKind ?? '') : (parts[1] ?? ''),
  }
}

function identityMatches(actual: string, expected: string) {
  const fold = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(
        /(?<![\p{L}\p{N},._])(?:\d{1,3}(?:,\d{3})+|\d{1,3}(?:_\d{3})+)(?![\p{L}\p{N},._])/gu,
        (number) => number.replace(/[,_]/g, ''),
      )
      .replace(/([\p{L}\p{N}])['\u2019\u02bc](?=[\p{L}\p{N}])/gu, '$1')
      .replaceAll('&', ' and ')
  return albumNameMatches(fold(actual), fold(expected))
}

function displayIdentityMatches(actual: string, expected: string) {
  const expand = (value: string) =>
    value.replace(/(^|\s)w\/(?=\s*\p{L})/giu, '$1with ')
  return identityMatches(expand(actual), expand(expected))
}

function baseTitle(value: string) {
  // Only recognized trailing edition labels, never arbitrary parentheticals.
  const label =
    /^(?:(?:\d{1,3}(?:st|nd|rd|th)\s+)?anniversary(?:\s+(?:edition|deluxe\s+edition))?|\d{1,3}\s+year\s+anniversary(?:\s+remastered)?|\d{1,3}(?:st|nd|rd|th)\s+anniversary\s+(?:analogue\s+remaster\s+edition|edition\s+\/\s+remastered\s+\d{4})|deluxe\s+version|(?:super\s+)?deluxe(?:\s+edition)?|expanded(?:\s+edition)?|(?:special|collector'?s)\s+edition|(?:\d{4}\s+)?(?:digitally\s+)?remaster(?:ed)?(?:\s+(?:edition|version|\d{4}))?)$/i
  let title = value.trim()
  for (;;) {
    const suffix =
      title.match(/\s*(?:\(([^()]*)\)|\[([^\][]*)\])$/) ??
      title.match(/\s[-–—]\s([^-–—]*)$/)
    const text = suffix?.[1] ?? suffix?.[2] ?? suffix?.[3]
    if (!suffix || !text || !label.test(text.trim())) return title
    const cleaned = title.slice(0, suffix.index).trim()
    if (!cleaned) return title
    title = cleaned
  }
}

function truncatedIdentityMatches(actual: string, expected: string) {
  if (!/(?:\.\.\.|…)\s*$/.test(actual)) return false
  const prefix = actual.replace(/(?:\.\.\.|…)\s*$/, '').trim()
  return (
    prefix.length >= 4 &&
    identityMatches(prefix, expected.slice(0, prefix.length))
  )
}

function titleIdentities(value: string) {
  const header = value.match(
    /^(?:Reviews of |Lists with )?(.+) \((Album|EP|Mixtape|Compilation|Single|DJ Mix)[,);]/i,
  )
  if (header?.[1]) {
    const parts = header[1].split(/ by /i)
    return parts.slice(1).map((_part, index) => ({
      title: parts.slice(0, index + 1).join(' by '),
      artist: parts.slice(index + 1).join(' by '),
      kind: header[2]?.toLowerCase() ?? null,
    }))
  }
  const review = value.match(/^Review for (.+) - (.+) by /i)
  return review?.[1] && review[2]
    ? [{ title: review[1], artist: review[2], kind: null }]
    : []
}

function descriptionIdentity(value: string) {
  const prefix = value.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}) [—–-] /i,
  )
  const date = prefix
    ? z.coerce.date().safeParse(`${prefix[1]} ${prefix[2]}, ${prefix[3]} UTC`)
    : null
  const validPrefix =
    prefix &&
    date?.success &&
    date.data.getUTCDate() === Number(prefix[2]) &&
    date.data.getUTCFullYear() === Number(prefix[3])
  const identity = validPrefix ? value.slice(prefix[0].length) : value
  const match = identity.match(
    /^(.+), an? (?:classical music )?(Album|EP|Mixtape|Compilation|Single|DJ Mix)(?: of songs)? by (.+?)(?:\.\s+(?:Released|Genres:)|\.$)/i,
  )
  return match?.[1] && match[2] && match[3]
    ? { title: match[1], artist: match[3], kind: match[2].toLowerCase() }
    : null
}

function indexedReleaseDate(result: z.infer<typeof ResultSchema>) {
  const date =
    result.description.match(
      /\bReleased[,\s]+(\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/i,
    )?.[1] ?? result.metadata?.published_time
  if (
    typeof date !== 'string' ||
    !/^(?:\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},\s+\d{4})$/.test(date)
  )
    return null
  const parsed = z.coerce.date().safeParse(`${date} UTC`)
  if (
    !parsed.success ||
    parsed.data.getUTCDate() !== Number(date.match(/\b\d{1,2}\b/)?.[0])
  )
    return null
  return parsed.data.toISOString().slice(0, 10)
}

function bilingualName(value: string) {
  const pair = value.match(/^([^()[\]]+)\s+\[([^()[\]]+)\]$/)
  const native = pair?.[1]?.trim()
  const latin = pair?.[2]?.trim()
  if (!native || !latin) return null
  if (
    baseTitle(`Fixture (${latin})`) === 'Fixture' ||
    /^(?:live|karaoke|instrumental|remix|acoustic|demo)(?:\s+version)?$/i.test(
      latin,
    )
  )
    return null
  const nativeLetters = native.match(/\p{L}/gu) ?? []
  const latinLetters = latin.match(/\p{L}/gu) ?? []
  if (
    !nativeLetters.length ||
    !latinLetters.length ||
    nativeLetters.some((letter) => /\p{Script=Latin}/u.test(letter)) ||
    latinLetters.some((letter) => !/\p{Script=Latin}/u.test(letter))
  )
    return null
  return { native, latin }
}

function bilingualIdentity(
  result: z.infer<typeof ResultSchema>,
  page: NonNullable<ReturnType<typeof rymPage>>,
  names: { title: string; artist: string },
) {
  if (page.review || page.child) return null
  const description = descriptionIdentity(result.description)
  if (!description || description.kind !== releaseKinds[page.kind]) return null
  const headers = titleIdentities(result.title)
  const untyped = result.title.match(
    /^(.+) by (.+?) - (?:Rate Your Music|RYM)$/i,
  )
  if (untyped?.[1] && untyped[2])
    headers.push({
      title: untyped[1],
      artist: untyped[2],
      kind: description.kind,
    })
  const reversed = result.title.match(/^By (.+?) - (.+) - Rate Your Music$/i)
  if (reversed?.[1] && reversed[2])
    headers.push({
      title: reversed[2],
      artist: reversed[1],
      kind: description.kind,
    })
  for (const header of headers) {
    if (header.kind !== description.kind) continue
    const title =
      bilingualName(header.title) ?? bilingualName(description.title)
    const artist =
      bilingualName(header.artist) ?? bilingualName(description.artist)
    if (!title && !artist) continue
    const matches = (
      first: string,
      second: string,
      input: string,
      slug: string,
      pair: ReturnType<typeof bilingualName>,
      allowTranslatedTitle = false,
    ) => {
      if (!pair)
        return (
          displayIdentityMatches(first, input) &&
          displayIdentityMatches(second, input) &&
          identityMatches(slug, first)
        )
      const observed = (value: string) =>
        identityMatches(value, pair.native) ||
        (identityMatches(bilingualName(value)?.native ?? '', pair.native) &&
          identityMatches(bilingualName(value)?.latin ?? '', pair.latin))
      return (
        (observed(first) ||
          (allowTranslatedTitle &&
            bilingualName(second) !== null &&
            displayIdentityMatches(first, pair.latin))) &&
        observed(second) &&
        identityMatches(slug, pair.native) &&
        (displayIdentityMatches(input, pair.latin) ||
          displayIdentityMatches(input, pair.native))
      )
    }
    if (
      matches(
        header.title,
        description.title,
        names.title,
        page.title,
        title,
        true,
      ) &&
      matches(
        header.artist,
        description.artist,
        names.artist,
        page.artist,
        artist,
      )
    )
      return {
        title: title?.native ?? header.title,
        artist: artist?.native ?? header.artist,
        bilingual: { title, artist },
      }
  }
  return null
}

function corroboratedIdentity(
  result: z.infer<typeof ResultSchema>,
  page: NonNullable<ReturnType<typeof rymPage>>,
  names: { title: string; artist: string },
  expectedDate: string | null,
  artistCredits: string[],
) {
  const sourceDate = indexedReleaseDate(result)
  if (page.review || !expectedDate || sourceDate !== expectedDate) return null
  const bilingual =
    artistCredits.length === 1 ? bilingualIdentity(result, page, names) : null
  if (bilingual) return { ...bilingual, sourceDate, rule: 'explicit-bilingual' }
  const description = descriptionIdentity(result.description)
  const identities = [
    ...titleIdentities(result.title),
    ...(description ? [description] : []),
  ]
  const untyped = result.title.match(/^(.+) by (.+?) - Rate Your Music$/i)
  const kind = result.description.match(/\bType,\s*(Album)\s*;/i)?.[1]
  if (untyped?.[1] && untyped[2] && kind)
    identities.push({
      title: untyped[1],
      artist: untyped[2],
      kind: kind.toLowerCase(),
    })
  for (const identity of identities) {
    if (identity.kind !== releaseKinds[page.kind]) continue
    const exactTitlePath = identityMatches(page.title, identity.title)
    const exactArtistPath = identityMatches(page.artist, identity.artist)
    if (
      artistCredits.length > 1 &&
      exactTitlePath &&
      displayIdentityMatches(identity.title, names.title) &&
      displayIdentityMatches(identity.artist, artistCredits.join(' & ')) &&
      (exactArtistPath || identityMatches(page.artist, artistCredits.join(' ')))
    )
      return {
        title: identity.title,
        artist: identity.artist,
        sourceDate,
        rule: 'combined-credits',
      }
    if (artistCredits.length > 1) continue
    const soundtrackTitle = names.title.match(
      /^(.+)\s+\((?:Original Soundtrack|Original Series Soundtrack|Original Motion Picture Soundtrack|Adult Swim Original Series Soundtrack)\)$/i,
    )?.[1]
    const soundtrackEvidence =
      /\(Album,\s*(?:Soundtrack|Film Score)\)/i.test(result.title) ||
      /\bGenres:\s*(?:Soundtrack|Film Score)(?:[,.]|$)/i.test(
        result.description,
      ) ||
      /\bRanked,\s*#[\d,]+\s+for soundtracks\b/i.test(result.description)
    if (
      page.kind === 'album' &&
      soundtrackTitle &&
      soundtrackEvidence &&
      exactArtistPath &&
      displayIdentityMatches(identity.artist, names.artist) &&
      displayIdentityMatches(identity.title, soundtrackTitle) &&
      (exactTitlePath || identityMatches(page.title, names.title))
    )
      return {
        title: identity.title,
        artist: identity.artist,
        sourceDate,
        rule: 'soundtrack-role',
      }
    if (!exactTitlePath || !exactArtistPath) continue
    const primary = identity.artist.match(
      /^(.+?)\s+(?:feat\.|featuring)\s+\S.+$/i,
    )?.[1]
    if (
      primary &&
      displayIdentityMatches(primary, names.artist) &&
      displayIdentityMatches(identity.title, names.title)
    )
      return {
        title: identity.title,
        artist: identity.artist,
        sourceDate,
        rule: 'featured-credit',
      }
    const mixTitle = names.title.match(/^(.+)\s+\(DJ Mix\)$/i)?.[1]
    const composedMixTitle = displayIdentityMatches(
      names.title,
      `${identity.title}: ${identity.artist}`,
    )
    if (
      page.kind === 'djmix' &&
      displayIdentityMatches(identity.artist, names.artist) &&
      (composedMixTitle ||
        (mixTitle &&
          (displayIdentityMatches(mixTitle, identity.title) ||
            displayIdentityMatches(
              mixTitle,
              `${identity.title} ${identity.artist}`,
            ))))
    )
      return {
        title: identity.title,
        artist: identity.artist,
        sourceDate,
        rule: 'djmix-title-composition',
      }
  }
  return null
}

function rating(result: z.infer<typeof ResultSchema>, review: boolean) {
  const aggregate = result.description.match(
    /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:\/\s*5[.\d]*\s*)?from\s+([\d,]+)\s+ratings?\b/i,
  )
  if (aggregate) {
    const value = RatingSchema.safeParse(aggregate[1])
    const votes = CountSchema.safeParse(aggregate[2])
    if (value.success && votes.success)
      return { value: value.data, votes: votes.data, source: 'description' }
  }
  // Review snippets can include the reviewer's own structured star rating.
  if (review) return null
  const value = RatingSchema.safeParse(result.metadata?.rating)
  const votes = CountSchema.safeParse(result.metadata?.reviews)
  return value.success
    ? {
        value: value.data,
        votes: votes.success ? votes.data : null,
        source: 'metadata',
      }
    : null
}

function genres(result: z.infer<typeof ResultSchema>) {
  const explicit = result.description.match(
    /\bGenres:\s*([^\n.…]+)(\.{1,3}|…|$)/i,
  )
  if (explicit?.[1]) {
    const names = explicit[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    if (
      ['...', '…'].includes(explicit[2] ?? '') &&
      !explicit[1].trim().endsWith(',')
    )
      names.pop()
    if (names.length) return { names, source: 'description' }
  }
  // Flattened header text can join two genre tiers without a delimiter.
  // Its first comma-delimited genre is complete even if a later boundary is lost.
  const firstGenre = result.description
    .match(/\bGenres\s+([^,\n]{1,80}),/i)?.[1]
    ?.trim()
  if (
    firstGenre &&
    !/\b(?:Descriptors|Language|Ranked|Reviews)\b|[.…]/i.test(firstGenre)
  )
    return { names: [firstGenre], source: 'header' }
  // The title's explicitly labelled genre also remains usable.
  const title = result.title.match(
    /\((?:Album|EP|Mixtape|Compilation|Single|DJ Mix),\s*([^;)]+)\)/i,
  )
  return {
    names: title?.[1] ? [title[1].trim()] : [],
    source: 'title',
  }
}

function candidates(
  payload: unknown,
  requestedNames: { title: string; artist: string },
  reference: ReturnType<typeof rymPage>,
  expectedYear: number | undefined,
  manualReference: boolean,
  expectedDate: string | null,
  artistCredits: string[],
  singleEvidence: { artist: string; title: string }[],
  diagnostic: { candidates: JsonValue[]; reasons: Record<string, number> },
) {
  const matches = []
  const results = ResponseSchema.parse(payload).results
  for (const entry of results) {
    const result = ResultSchema.safeParse(entry)
    if (!result.success) continue
    try {
      const page = rymPage(result.data.link)
      const description = descriptionIdentity(result.data.description)
      if (
        page?.single &&
        !page.child &&
        description?.kind === 'single' &&
        identityMatches(page.artist, description.artist) &&
        identityMatches(page.title, description.title) &&
        !singleEvidence.some(
          (known) =>
            identityMatches(known.artist, page.artist) &&
            identityMatches(known.title, page.title),
        )
      )
        singleEvidence.push({ artist: page.artist, title: page.title })
    } catch {
      /* Malformed URL remains an invalid-url candidate below. */
    }
  }
  for (const [index, entry] of results.entries()) {
    const record = (reason: string) => {
      diagnostic.reasons[reason] = (diagnostic.reasons[reason] ?? 0) + 1
      if (diagnostic.candidates.length >= 20) return
      const fields = z
        .object({
          title: z.unknown().optional(),
          description: z.unknown().optional(),
          link: z.unknown().optional(),
          metadata: z.unknown().optional(),
        })
        .safeParse(entry)
      diagnostic.candidates.push({
        index,
        reason,
        response: fields.success
          ? {
              title: diagnosticField(fields.data.title),
              description: diagnosticField(fields.data.description),
              link: diagnosticField(fields.data.link),
              metadata: diagnosticMetadata(fields.data.metadata),
            }
          : null,
      })
    }
    const parsed = ResultSchema.safeParse(entry)
    if (!parsed.success) {
      record(
        parsed.error.issues.some((issue) => issue.path[0] === 'link')
          ? 'invalid-url'
          : 'invalid-result',
      )
      continue
    }
    const result = parsed.data
    let page: ReturnType<typeof rymPage>
    try {
      page = rymPage(result.link)
    } catch {
      record('invalid-url')
      continue
    }
    if (!page) {
      record('invalid-url')
      continue
    }
    if (page.review) {
      if (/^.+, an? (?:Song|Music video) by /i.test(result.description)) {
        record('unsupported-review-kind')
        continue
      }
      const description = descriptionIdentity(result.description)
      const headers = titleIdentities(result.title)
      const headerKind = headers.find((title) => title.kind)?.kind
      if (headerKind && description && headerKind !== description.kind) {
        record('review-kind-conflict')
        continue
      }
      const declaredKind =
        description &&
        identityMatches(page.artist, description.artist) &&
        identityMatches(page.title, description.title) &&
        headers.some(
          (title) =>
            identityMatches(title.title, description.title) &&
            identityMatches(title.artist, description.artist),
        )
          ? Object.entries(releaseKinds).find(
              ([, kind]) => kind === description.kind,
            )?.[0]
          : undefined
      const referencedKind =
        reference &&
        !reference.review &&
        identityMatches(page.artist, reference.artist) &&
        identityMatches(page.title, reference.title)
          ? reference.kind
          : undefined
      if (
        referencedKind &&
        ((description && description.kind !== releaseKinds[referencedKind]) ||
          (headerKind && headerKind !== releaseKinds[referencedKind]))
      ) {
        record('review-kind-conflict')
        continue
      }
      if (
        (description?.kind === 'single' || headerKind === 'single') &&
        !reference?.single
      ) {
        record('single-without-owned-reference')
        continue
      }
      const resolved = rymPage(
        result.link,
        referencedKind ?? declaredKind ?? null,
      )
      if (!resolved) continue
      page = resolved
      if (
        !resolved.kind &&
        !reference?.single &&
        singleEvidence.some(
          (single) =>
            identityMatches(single.artist, resolved.artist) &&
            identityMatches(single.title, resolved.title),
        )
      ) {
        record('related-single-without-owned-reference')
        continue
      }
    }
    const exactReviewReference =
      reference?.review &&
      page.review &&
      page.referenceUrl === reference.referenceUrl
    if (
      reference &&
      page.releaseUrl !== reference.releaseUrl &&
      !exactReviewReference
    ) {
      record('reference-identity-mismatch')
      continue
    }
    if (page.single && !reference?.single) {
      record('single-without-owned-reference')
      continue
    }
    const corroborated = corroboratedIdentity(
      result,
      page,
      requestedNames,
      expectedDate,
      artistCredits,
    )
    const names = corroborated ?? requestedNames
    const bilingual =
      corroborated && 'bilingual' in corroborated
        ? corroborated.bilingual
        : null
    const displayMatches = (actual: string, expected: string) =>
      displayIdentityMatches(actual, expected) ||
      (bilingual !== null &&
        displayIdentityMatches(
          bilingualName(actual)?.native ?? actual,
          expected,
        ))
    const cleanTitle = baseTitle(names.title)
    const titles = titleIdentities(result.title)
    const titleMatches = titles.some(
      (title) =>
        displayMatches(title.title, cleanTitle) &&
        displayMatches(title.artist, names.artist),
    )
    const pathMatches =
      corroborated !== null ||
      (identityMatches(page.artist, names.artist) &&
        identityMatches(page.title, cleanTitle))
    // Abbreviated slugs need the actual display spelling as evidence. Never
    // expand a bare "w" in a path or discard additional title/artist words.
    const displayPathMatches = titles.some(
      (title) =>
        displayIdentityMatches(title.title, cleanTitle) &&
        displayIdentityMatches(title.artist, names.artist) &&
        identityMatches(page.title, title.title) &&
        identityMatches(page.artist, title.artist),
    )
    const truncatedTitleMatches =
      pathMatches &&
      titles.some(
        (title) =>
          (identityMatches(title.title, cleanTitle) ||
            truncatedIdentityMatches(title.title, cleanTitle)) &&
          (identityMatches(title.artist, names.artist) ||
            truncatedIdentityMatches(title.artist, names.artist)),
      )
    const titleConflict =
      titles.length > 0 && !titleMatches && !truncatedTitleMatches
    if (titleConflict && !manualReference) {
      record('title-identity-mismatch')
      continue
    }
    const disambiguatedPath =
      !page.review &&
      titleMatches &&
      (identityMatches(page.artist, names.artist) ||
        identityMatches(page.artist.replace(/[-_]\d+$/, ''), names.artist)) &&
      (identityMatches(page.title, cleanTitle) ||
        identityMatches(page.title.replace(/[-_]\d+$/, ''), cleanTitle))
    if (
      !reference &&
      !pathMatches &&
      !displayPathMatches &&
      !disambiguatedPath
    ) {
      record('identity-mismatch')
      continue
    }
    if (
      /\((?:Album|EP|Mixtape|Compilation|Single|DJ Mix);/i.test(result.title)
    ) {
      record('edition-title')
      continue
    }
    if (
      /[-_]\d+$/.test(page.title) &&
      !identityMatches(page.title, cleanTitle) &&
      !disambiguatedPath &&
      !manualReference
    ) {
      record('edition-path')
      continue
    }
    const description = descriptionIdentity(result.description)
    const descriptionConflict = Boolean(
      description &&
      (!displayMatches(description.title, cleanTitle) ||
        !displayMatches(description.artist, names.artist)),
    )
    if (descriptionConflict && !manualReference) {
      record('description-identity-mismatch')
      continue
    }
    const year = result.description.match(
      /\bReleased\s+(?:in\s+)?(?:\d{1,2}\s+)?(?:[A-Za-z]+\s+)?(\d{4})\b/i,
    )?.[1]
    const editionYear =
      cleanTitle !== names.title &&
      (pathMatches || displayPathMatches || disambiguatedPath) &&
      titleMatches &&
      year &&
      expectedYear !== undefined &&
      Number(year) < expectedYear
    if (
      expectedYear !== undefined &&
      year &&
      Number(year) !== expectedYear &&
      !editionYear &&
      !manualReference
    ) {
      record('year-mismatch')
      continue
    }
    const score = rating(result, page.review || page.child)
    const tags = genres(result)
    const sourcePublishedTime =
      typeof result.metadata?.published_time === 'string'
        ? result.metadata.published_time
        : null
    const sourceYearText =
      year ??
      (manualReference
        ? sourcePublishedTime?.match(/\b(?:18|19|20)\d{2}\b/)?.[0]
        : undefined)
    const sourceYear = sourceYearText ? Number(sourceYearText) : null
    const yearConflict =
      sourceYear !== null &&
      expectedYear !== undefined &&
      sourceYear !== expectedYear
    record(!score && !tags.names.length ? 'identity-only' : 'accepted')
    matches.push({
      result,
      page,
      rating: score,
      genres: tags,
      sourceYear,
      sourcePublishedTime,
      yearConflict,
      corroboratedIdentity: corroborated
        ? {
            rule: corroborated.rule,
            inputTitle: requestedNames.title,
            inputArtist: requestedNames.artist,
            inputArtists: artistCredits,
            sourceTitle: corroborated.title,
            sourceArtist: corroborated.artist,
            sourceDate: corroborated.sourceDate,
            bilingual,
          }
        : null,
      identityConflict:
        titleConflict ||
        descriptionConflict ||
        (!pathMatches && !displayPathMatches && !disambiguatedPath),
      identityEvidence: manualReference
        ? 'manual-reference'
        : corroborated
          ? corroborated.rule
          : pathMatches
            ? 'exact-path'
            : displayPathMatches
              ? 'corroborated-display-title'
              : disambiguatedPath
                ? 'corroborated-disambiguation'
                : 'owned-reference',
      yearEvidence: manualReference
        ? yearConflict
          ? 'manual-reference-year-conflict'
          : 'manual-reference'
        : editionYear
          ? 'edition-to-original'
          : 'consistent-or-unknown',
    })
  }
  return matches.sort(
    (a, b) =>
      Number(a.page.review || a.page.child) -
      Number(b.page.review || b.page.child),
  )
}

function diagnosticField(value: unknown): JsonValue {
  if (typeof value === 'string')
    return value.length > 4096 ? '[omitted oversized field]' : value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

type SerplyAlbumTag = {
  name: string
  rawName: string
  kind: 'genre' | 'descriptor'
  source: 'rym'
  sourceUrl: string
}

const SavedSearchesSchema = z.object({
  searches: z.array(z.object({ response: ResponseSchema })).max(6),
})

// Unpunctuated headers lose the boundary between two genre lists. Only
// recognize a compound label if independently known or explicitly indexed.
const compoundGenres = new Set([
  'Art Pop',
  'Berlin School',
  'Deconstructed Club',
  'Dream Pop',
  'Glitch Pop',
  'Indie Folk',
  'Minimal Techno',
  'Psychedelic Rock',
])

function tagField(text: string, requireTerminator = false) {
  const field = text.match(
    /^([\s\S]*?)(\.{2,}|…|[.;\n]|\b(?:Descriptors|Languages?|Ranked|Track listing|RYM Rating|Rating|Reviews?|Credits|Artist|Released|Genres|Type|Issues|Lists|Catalog|ADVERTISEMENT)\b|$)/,
  )
  const names = (field?.[1] ?? '').split(/[,·]/).map((name) => name.trim())
  if (
    /^(?:\.{2,}|…)$/.test(field?.[2] ?? '') ||
    (requireTerminator && !field?.[2])
  )
    names.pop()
  const rest = text.slice(field?.[0].length)
  const descriptors =
    field?.[2] === 'Descriptors'
      ? rest.replace(/^[.:]?\s*/, '')
      : field?.[2] === '.'
        ? rest.match(/^\s+Descriptors[.:]?\s+([\s\S]*)/)?.[1]
        : null
  return { names, descriptors }
}

function tagEvidence(
  payload: unknown,
  selectedSourceUrl: string,
  genreVocabulary: ReadonlySet<string>,
) {
  const tags: (SerplyAlbumTag & { field: string })[] = []
  const parsed = SavedSearchesSchema.safeParse(payload)
  if (!parsed.success) return tags
  let scope: ReturnType<typeof rymPage>
  try {
    scope = rymPage(selectedSourceUrl)
  } catch {
    return tags
  }
  if (!scope) return tags
  const selected = parsed.data.searches
    .flatMap(({ response }) => response.results)
    .map((entry) => ResultSchema.safeParse(entry))
    .find((entry) => entry.success && entry.data.link === selectedSourceUrl)
  const names = (selected?.success
    ? titleIdentities(selected.data.title)[0]
    : null) ?? { artist: scope.artist, title: scope.title }
  const singles: { artist: string; title: string }[] = []
  const rows = parsed.data.searches
    .flatMap(({ response }) =>
      candidates(
        response,
        names,
        scope,
        undefined,
        true,
        null,
        [names.artist],
        singles,
        { candidates: [], reasons: {} },
      ),
    )
    .filter(
      ({ page, result, identityConflict }) =>
        page.primaryIssue === scope.primaryIssue &&
        (scope.review
          ? page.referenceUrl === scope.referenceUrl
          : page.releaseUrl === scope.releaseUrl) &&
        (!identityConflict ||
          (selected?.success &&
            result.link === selectedSourceUrl &&
            selected.data.title === result.title &&
            (selected.data.description === result.description ||
              !descriptionIdentity(result.description)))),
    )
  const seen = new Set<string>()
  const explicit = new Set<string>()
  const add = (
    name: string,
    kind: SerplyAlbumTag['kind'],
    sourceUrl: string,
    field: string,
  ) => {
    if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} &/'’()-]{0,63}$/u.test(name)) return
    const key = kind + ':' + name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    tags.push({ name, rawName: name, kind, source: 'rym', sourceUrl, field })
  }
  const headers = rows.map(({ result, page }) => {
    // A reviewer's prose isn't an album field. On child pages require the
    // indexed release synopsis or the aggregate header right before Genres.
    const text = result.description.slice(0, 4096).replaceAll('&amp;', '&')
    const header =
      /(?:^|[.\u2026]\s+|\b(?:ratings|overall|Ranked #[\d,]+ for \d{4})\s+)Genres([.:]\s*|\s+)/.exec(
        text,
      )
    const abbreviated = text.match(
      /^(Album|EP|Compilation|Single|Mixtape|DJ Mix) by ([^.]+)\. Released\b/i,
    )
    const clipped = text.match(
      /^.+, an? (Album|EP|Compilation|Single|Mixtape|DJ Mix) by (.+?) … Released\b/i,
    )
    const short = abbreviated ?? clipped
    const synopsis =
      descriptionIdentity(text) !== null ||
      Boolean(
        short?.[2] &&
        short[1]?.toLowerCase() === releaseKinds[page.kind] &&
        identityMatches(
          page.artist,
          bilingualName(short[2])?.native ?? short[2],
        ),
      )
    const prefix = header
      ? text.slice(0, header.index + header[0].indexOf('Genres')).trim()
      : ''
    const artistHeader = prefix.match(/^(.{1,120}) ratings$/)
    const aggregate =
      /\b(?:[\d,]+ ratings(?:[.]| Ranked #[\d,]+ for \d{4},? #[\d,]+ overall)?|Ranked #[\d,]+ for \d{4})$/i.test(
        prefix,
      ) ||
      Boolean(
        artistHeader?.[1] && identityMatches(artistHeader[1], page.artist),
      )
    const dotted =
      header?.[1]?.startsWith('.') &&
      /\.\s+Descriptors\b/.test(text.slice(header.index))
    const anchored =
      header &&
      (header[0].includes('…')
        ? synopsis
        : (!page.review && !page.child) ||
          synopsis ||
          aggregate ||
          (dotted && header.index === 0))
    const body = anchored ? text.slice(header.index + header[0].length) : ''
    const colon = header?.[1]?.startsWith(':') || dotted
    const section = tagField(body, true)
    const genreNames = section.names
    const descriptorNames = section.descriptors
      ? tagField(section.descriptors, true).names
      : []
    const title = result.title.match(
      /\((?:Album|EP|Mixtape|Compilation|Single|DJ Mix),\s*([^;)]+)\)/i,
    )
    const titleGenres = title?.[1]
      ? tagField(title[1].replaceAll('&amp;', '&')).names
      : []
    for (const genre of titleGenres) explicit.add(genre)
    return {
      sourceUrl: result.link,
      genreNames,
      descriptorNames,
      colon,
      titleGenres,
    }
  })
  for (const row of headers) {
    if (!row.colon) continue
    for (const name of row.genreNames) {
      if (!name) continue
      // Some explicit snippets run straight into unlabelled lowercase
      // descriptors. Stop at that boundary rather than guessing either field.
      if (
        !explicit.has(name) &&
        !name
          .split(' ')
          .every((part) =>
            /^(?:[\p{Lu}\p{N}][\p{L}\p{M}\p{N}'’&/-]*|&|of|and|the|de)$/u.test(
              part,
            ),
          )
      )
        break
      if ([...explicit].some((other) => other.startsWith(name + ' '))) continue
      explicit.add(name)
      add(name, 'genre', row.sourceUrl, 'description')
    }
  }
  const recognized = (name: string) =>
    explicit.has(name) || compoundGenres.has(name) || genreVocabulary.has(name)
  for (const row of headers) {
    if (!row.colon) {
      for (const name of row.genreNames) {
        if (
          /^[\p{Lu}\p{N}][\p{L}\p{M}\p{N}&'’/-]{0,63}$/u.test(name) ||
          recognized(name)
        )
          add(name, 'genre', row.sourceUrl, 'header')
        else {
          const splits = [...name.matchAll(/ /g)]
            .map(({ index }) => [name.slice(0, index), name.slice(index + 1)])
            .filter(
              ([left, right]) =>
                left && right && recognized(left) && recognized(right),
            )
          if (splits.length === 1)
            for (const part of splits[0] ?? [])
              add(part, 'genre', row.sourceUrl, 'header')
        }
      }
    }
    for (const name of row.descriptorNames) {
      if (
        !name ||
        /^(?:male|female)$/.test(name) ||
        !/^[\p{Ll}\p{M}]+(?:[- ][\p{Ll}\p{M}]+){0,2}$/u.test(name)
      )
        break
      add(name, 'descriptor', row.sourceUrl, 'header')
    }
  }
  for (const row of headers)
    for (const name of row.titleGenres)
      add(name, 'genre', row.sourceUrl, 'title')
  return tags
}

/** Extract observed tags for an already validated release or exact review. */
export function extractSerplyAlbumTags(
  payload: unknown,
  selectedSourceUrl: string,
  genreVocabulary: ReadonlySet<string> = new Set(),
): SerplyAlbumTag[] {
  return tagEvidence(payload, selectedSourceUrl, genreVocabulary).map(
    ({ name, rawName, kind, source, sourceUrl }) => ({
      name,
      rawName,
      kind,
      source,
      sourceUrl,
    }),
  )
}

function selectMatches(
  matches: ReturnType<typeof candidates>,
  singleEvidence: { artist: string; title: string }[],
) {
  const ordered = matches
    .filter(
      (match) =>
        !(
          match.page.review &&
          !match.page.kind &&
          singleEvidence.some(
            (single) =>
              identityMatches(single.artist, match.page.artist) &&
              identityMatches(single.title, match.page.title),
          )
        ),
    )
    .sort(
      (a, b) =>
        Number(a.page.review || a.page.child) -
          Number(b.page.review || b.page.child) ||
        Number(a.page.primaryIssue) - Number(b.page.primaryIssue),
    )
  const selected =
    ordered.find((match) => match.rating) ??
    ordered.find((match) => match.genres.names.length) ??
    ordered[0]
  // A primary-credit shortcut cannot choose between different featured releases.
  if (
    selected?.corroboratedIdentity &&
    ordered.some(
      (match) =>
        match.corroboratedIdentity &&
        match.page.releaseUrl !== selected.page.releaseUrl,
    )
  )
    return { selected: undefined, rated: undefined, tagged: undefined }
  const release = ordered.filter(
    (match) => match.page.releaseUrl === selected?.page.releaseUrl,
  )
  const rated = release.find((match) => match.rating)
  const tagged =
    release.find(
      (match) =>
        match.genres.source === 'description' && match.genres.names.length,
    ) ?? release.find((match) => match.genres.names.length)
  return { selected, rated, tagged }
}

function diagnosticMetadata(value: unknown): JsonValue {
  const parsed = z
    .object({
      rating: z.unknown().optional(),
      reviews: z.unknown().optional(),
    })
    .safeParse(value)
  return parsed.success
    ? {
        rating: diagnosticField(parsed.data.rating),
        reviews: diagnosticField(parsed.data.reviews),
      }
    : null
}

function recordSearchDiagnostic(
  context: MediaPluginScrapeContext,
  evidence: unknown,
  stage = 'serply.search',
) {
  const diagnostic = sanitizeJobDiagnostic(
    { stage, evidence },
    Object.values(context.secrets),
  )
  if (diagnostic) recordPluginDiagnostic(context, diagnostic)
}

export const serplyPlugin: MediaProviderPlugin = {
  manifest: {
    id: 'serply',
    displayName: 'Serply (Rate Your Music)',
    description:
      'RYM album ratings and genres from indexed Google search results',
    mediaTypes: ['album'],
    identifierTypes: ['rym-url'],
    supportsNameLookup: true,
    rateLimit: {
      maxConcurrent: 2,
      concurrentRequests: true,
      minTimeMs: 250,
      requestTimeoutMs: 120000,
      configurableRequestBudget: true,
    },
    secrets: [
      {
        key: 'apiKey',
        label: 'API Key',
        required: true,
        envVars: ['SERPLY_API_KEY'],
        helpText:
          'Searches Google through Serply. Up to six searches per album; indexed ratings may lag RYM.',
      },
    ],
  },
  async scrapeMediaItem(context) {
    requireAlbum(context, 'Serply')
    const owned = albumReference(context, 'serply', 'rym-url')
    const existing =
      owned ??
      context.existingReferences.find(
        (item) => item.referenceType === 'rym-url',
      )
    // Owned references include explicit corrections and remain authoritative.
    // Historical Google references are hints, not constraints on new evidence.
    const reference = owned
      ? rymPage(AlbumRymUrlSchema.parse(owned.externalId))
      : null
    if (owned && !reference)
      throw new Error('Invalid Serply release reference.')
    const manualReference =
      reference !== null && owned?.metadata?.['manualOverride'] === true
    let hint = reference
    if (!owned && existing) {
      try {
        hint = rymPage(existing.externalId)
      } catch {
        hint = null
      }
    }
    const names =
      context.media?.title && context.media.artists.some((name) => name.trim())
        ? albumNames(context)
        : hint
          ? { title: hint.title, artist: hint.artist }
          : albumNames(context)
    const releaseDate = context.media?.releaseDate
      ? z.coerce.date().safeParse(context.media.releaseDate)
      : null
    const expectedYear = releaseDate?.success
      ? releaseDate.data.getUTCFullYear()
      : undefined
    const searches = []
    const acceptedSearches = []
    const matches: ReturnType<typeof candidates> = []
    const singleEvidence: { artist: string; title: string }[] = []
    const cleanTitle = baseTitle(names.title)
    // Search vocabulary only: matching still requires explicit role evidence.
    const queryTitle = cleanTitle.replace(
      /\s+\((?:Original Soundtrack|Original Series Soundtrack|Original Motion Picture Soundtrack|Adult Swim Original Series Soundtrack|DJ Mix)\)$/i,
      '',
    )
    const quote = (value: string) => `"${value.replaceAll('"', ' ')}"`
    const queries = [
      `site:rateyourmusic.com ${names.artist} ${names.title}`,
      `site:rateyourmusic.com/release/ ${names.artist} ${cleanTitle}`,
      `site:rateyourmusic.com/release/ ${quote(names.artist)} ${quote(cleanTitle)}`,
      `${names.artist} ${cleanTitle} Rate Your Music rating genres`,
    ]
    const maxSearches = queryTitle !== cleanTitle ? 6 : 5
    if (queryTitle !== cleanTitle)
      queries.push(
        `${names.artist} ${queryTitle} Rate Your Music rating genres`,
      )
    const searched = new Set<string>()
    for (let attempt = 0; attempt < maxSearches; attempt++) {
      const query = queries.find((value) => !searched.has(value))
      if (!query) break
      searched.add(query)
      const payload = await search(context, query)
      searches.push({ query, response: payload })
      const diagnostic = { candidates: [], reasons: {} }
      try {
        const accepted = candidates(
          payload,
          names,
          reference,
          expectedYear,
          manualReference,
          releaseDate?.success
            ? releaseDate.data.toISOString().slice(0, 10)
            : null,
          context.media?.artists
            .map((artist) => artist.trim())
            .filter(Boolean) ?? [names.artist],
          singleEvidence,
          diagnostic,
        )
        matches.push(...accepted)
        acceptedSearches.push({
          response: { results: accepted.map(({ result }) => result) },
        })
      } finally {
        recordSearchDiagnostic(context, {
          query,
          expectedYear: expectedYear ?? null,
          resultCount: Array.isArray(payload['results'])
            ? payload['results'].length
            : null,
          reason: ResponseSchema.safeParse(payload).success
            ? 'evaluated'
            : 'invalid-response',
          reasons: diagnostic.reasons,
          candidates: diagnostic.candidates,
        })
      }
      const { selected, rated, tagged } = selectMatches(matches, singleEvidence)
      if (
        rated &&
        !rated.page.primaryIssue &&
        (!rated.page.review || Boolean(rated.page.kind)) &&
        tagged?.genres.source === 'description'
      )
        break
      const queryPage = reference ?? selected?.page ?? hint
      const releaseUrl = queryPage?.primaryIssue
        ? queryPage.referenceUrl
        : queryPage?.releaseUrl
      if (releaseUrl && !searched.has(`site:${releaseUrl}`))
        queries.unshift(`site:${releaseUrl}`)
    }
    const { selected, rated } = selectMatches(matches, singleEvidence)
    if (!selected) {
      recordSearchDiagnostic(
        context,
        { reason: 'no-match', searchCount: searches.length },
        'serply.selection',
      )
      throw new ProviderItemNotFoundError(
        'Serply found no matching RYM release.',
      )
    }
    const score = rated?.rating
    const manualEvidence = manualReference
      ? {
          referenceUrl: owned?.externalId ?? null,
          libraryTitle: names.title,
          libraryArtist: names.artist,
          libraryReleaseDate: context.media?.releaseDate ?? null,
          sourceTitle: selected.result.title,
          sourceTitleSlug: selected.page.title,
          sourceArtistSlug: selected.page.artist,
          sourceYear: selected.sourceYear,
          sourcePublishedTime: selected.sourcePublishedTime,
          identityConflict: selected.identityConflict,
          yearConflict: selected.yearConflict,
        }
      : null
    const ratingScope = rated
      ? rated.page.primaryIssue
        ? 'primary-issue'
        : 'release'
      : null
    const tags = tagEvidence(
      { searches: acceptedSearches },
      selected.result.link,
      new Set(),
    )
    const genre = tags.find((tag) => tag.kind === 'genre')
    const matchStatus = score
      ? 'rated'
      : genre
        ? 'genres-only'
        : 'identity-only'
    recordSearchDiagnostic(
      context,
      {
        reason: matchStatus,
        releaseUrl: selected.page.releaseUrl,
        releaseKind: selected.page.kind || null,
        identityEvidence: selected.identityEvidence,
        yearEvidence: selected.yearEvidence,
        ratingScope,
        manualReference: manualEvidence,
        corroboratedIdentity: selected.corroboratedIdentity,
      },
      'serply.selection',
    )
    if (!score)
      await context.log(
        'info',
        genre
          ? 'Serply matched a RYM release with genres but no indexed aggregate rating.'
          : 'Serply matched a RYM release identity only; no indexed aggregate rating or genres.',
      )
    return PluginResultSchema.parse({
      payload: { searches },
      normalized: {
        mediaPatch: {
          metadata: {
            browse: score
              ? { ratingRymValue: score.value, ratingRymVotes: score.votes }
              : {},
            'plugin.serply.provenance': {
              source: 'rym',
              retrievalProvider: 'serply',
              sourceUrl: selected.result.link,
              releaseUrl: selected.page.releaseUrl,
              releaseKind: selected.page.kind || null,
              matchStatus,
              identityEvidence: selected.identityEvidence,
              yearEvidence: selected.yearEvidence,
              ratingSourceUrl: rated?.result.link ?? null,
              ratingScope,
              manualReference: manualEvidence,
              corroboratedIdentity: selected.corroboratedIdentity,
              ratingField: score?.source ?? null,
              genresSourceUrl: genre?.sourceUrl ?? null,
              genresField: genre?.field ?? null,
              tagSources: tags.map(({ name, kind, sourceUrl }) => ({
                name,
                kind,
                sourceUrl,
              })),
              retrievedAt: new Date().toISOString(),
              indexedAt: null,
            },
          },
        },
        references: [
          {
            referenceType: 'rym-url',
            externalId: selected.page.referenceUrl,
            isPrimary: true,
          },
        ],
        links: [
          {
            provider: 'serply',
            label: 'Rate Your Music',
            url: selected.result.link,
          },
        ],
        tags: tags.map(({ name, rawName, kind, source }) => ({
          name,
          rawName,
          kind,
          source,
        })),
      },
    })
  },
}

async function search(context: MediaPluginScrapeContext, query: string) {
  const url = new URL('https://api.serply.io/v1/search/')
  for (const [key, value] of Object.entries({
    q: query,
    gl: 'us',
    num: '10',
    filter: '0',
  }))
    url.searchParams.set(key, value)
  let status: number | null = null
  const recordResponse = (evidence: unknown) => {
    recordSearchDiagnostic(context, evidence, 'serply.response')
  }
  const payload = await requestAlbumJson(
    {
      ...context,
      request: async (input, init, options) => {
        let response: Response
        try {
          response = await context.request(input, init, options)
        } catch (error) {
          recordResponse({
            query,
            status: null,
            responseUnavailable: 'request-failed',
          })
          throw error
        }
        status = response.status
        if (response.ok) {
          try {
            // Capture before envelope validation or service-error handling,
            // without consuming the body used by the shared request helper.
            const body: unknown = await response.clone().json()
            recordResponse({ query, status, response: body })
          } catch {
            recordResponse({
              query,
              status,
              responseUnavailable: 'invalid-or-unreadable-json',
            })
          }
        }
        return response
      },
    },
    'Serply',
    url,
    {
      headers: {
        'X-Api-Key': albumSecret(context, 'apiKey', 'Serply'),
        'X-User-Agent': 'desktop',
      },
    },
    (body) => {
      // The helper already bounds HTTP error reads to 16 KiB. A null result
      // cannot distinguish a JSON null from an oversized/unreadable body.
      if (status !== null && (status < 200 || status >= 300))
        recordResponse(
          body === null
            ? {
                query,
                status,
                responseUnavailable:
                  'null-invalid-unreadable-or-over-16384-bytes',
              }
            : { query, status, response: body },
        )
      return null
    },
  )
  if ('error' in payload || 'detail' in payload)
    throw new ProviderRequestError(
      'Serply returned a service error.',
      'request-failed',
    )
  return payload
}
