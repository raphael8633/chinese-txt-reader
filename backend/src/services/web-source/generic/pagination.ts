import { PAGE_PARAMS, shapeKey } from './urls.js'

/** Only these extensions can spell a directory page; anything else is an asset. */
const INDEX_NUMBERED = /^(.*\/)index[_-]?(\d+)\.(?:html?|php|shtml|shtm|aspx?|jsp)$/i
const INDEX_PLAIN = /^(.*\/)index\.(?:html?|php|shtml|shtm|aspx?|jsp)$/i
const SUFFIX_NUMBERED = /^(.*)[_-](\d+)(\.(?:html?|php|shtml|shtm|aspx?|jsp))$/i
const PAGE_SEGMENT = /^(.*)\/page\/(\d+)\/?$/i
const P_SEGMENT = /^(.*)\/p(\d+)\/?$/i

export type PageSignature = {
  /** The URL with its page component removed — equal for every page of one directory. */
  key: string
  /** null when the URL carries no page component at all; page 1 is usually spelled that way. */
  page: number | null
}

/**
 * Splits a URL into "which directory" and "which page of it". Two URLs belong to
 * the same paginated directory exactly when their keys match, so the caller never
 * has to know which of the many page spellings a site uses.
 */
export function directoryPageSignature(url: URL): PageSignature {
  // Most links carry no query at all, and this runs once per anchor on pages with
  // tens of thousands of them; parsing an empty query string is pure waste.
  const params = url.search ? new URLSearchParams(url.search) : null
  let page: number | null = null
  if (params) {
    for (const key of PAGE_PARAMS) {
      const raw = params.get(key)
      if (raw === null || !/^\d+$/.test(raw)) continue
      page = Number.parseInt(raw, 10)
      params.delete(key)
      break
    }
  }

  const stripped = stripPagePath(url.pathname)
  return {
    key: `${trimTrailingSlash(stripped.path)}${params ? canonicalSearch(params) : ''}`,
    page: page ?? stripped.page,
  }
}

/** First matching spelling wins: `index_2.html` is an index page, not a generic `_2` suffix. */
function stripPagePath(path: string): { path: string; page: number | null } {
  const indexNumbered = path.match(INDEX_NUMBERED)
  if (indexNumbered) return { path: indexNumbered[1], page: Number.parseInt(indexNumbered[2], 10) }

  // `index.html` and the bare directory are the same page 1.
  const indexPlain = path.match(INDEX_PLAIN)
  if (indexPlain) return { path: indexPlain[1], page: 1 }

  const suffixNumbered = path.match(SUFFIX_NUMBERED)
  if (suffixNumbered) {
    return { path: `${suffixNumbered[1]}${suffixNumbered[3]}`, page: Number.parseInt(suffixNumbered[2], 10) }
  }

  const pageSegment = path.match(PAGE_SEGMENT)
  if (pageSegment) return { path: pageSegment[1], page: Number.parseInt(pageSegment[2], 10) }

  const pSegment = path.match(P_SEGMENT)
  if (pSegment) return { path: pSegment[1], page: Number.parseInt(pSegment[2], 10) }

  return { path, page: null }
}

export type DirectoryPageLink = {
  page: number
  /** Absolute and hash-free — ready to hand back to the fetcher. */
  url: string
}

export type DirectoryPageLinkOptions = {
  /** URL shape of the winning chapter cluster; links of that shape are chapters, not pages. */
  chapterShapeKey: string
  /** Chapter URLs already collected — a link that is a chapter cannot also be a page link. */
  chapterUrls: ReadonlySet<string>
}

/** A same-site link the list extraction already resolved — anchor href or `<option value>` — so nothing is reparsed here. */
export type ResolvedLink = {
  url: URL
  normalized: string
}

/**
 * Directory pagination links among `links`, ascending by page number.
 *
 * Every spelling is recognised by the same signature test, so a `rel="next"` /
 * 下一頁 anchor needs no separate branch: it is found because its href resolves to
 * page N of this same directory. Rescanning each fetched page therefore also walks
 * a site that renders only 下一頁 and no numbered links.
 */
export function findDirectoryPageLinks(
  links: readonly ResolvedLink[],
  listUrl: URL,
  options: DirectoryPageLinkOptions,
): DirectoryPageLink[] {
  const listSignature = directoryPageSignature(listUrl)
  // The user pasted page 3 itself; pages 1..2 are not reachable from this URL and
  // walking forward from it would silently return a partial book.
  if (listSignature.page !== null && listSignature.page > 1) return []

  const found = new Map<number, string>()
  for (const link of links) {
    // Signature first: it rejects every ordinary chapter link with a few regexes,
    // where shapeKey would tokenize each path segment of all of them.
    const signature = directoryPageSignature(link.url)
    if (signature.page === null || signature.page < 2) continue
    if (signature.key !== listSignature.key) continue
    if (options.chapterUrls.has(link.normalized)) continue
    // A site whose chapter URLs share the page spelling (`/read/12_3.html`) would
    // otherwise have every chapter fetched as if it were another directory page.
    if (shapeKey(link.url) === options.chapterShapeKey) continue
    if (!found.has(signature.page)) found.set(signature.page, link.normalized)
  }

  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, url]) => ({ page, url }))
}

function canonicalSearch(params: URLSearchParams): string {
  const entries = [...params.entries()]
    .sort((a, b) => (a[0] === b[0] ? compareStrings(a[1], b[1]) : compareStrings(a[0], b[0])))
  if (entries.length === 0) return ''
  return `?${entries.map(([key, value]) => `${key}=${value}`).join('&')}`
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}
