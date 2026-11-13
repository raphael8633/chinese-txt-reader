/**
 * Second-level registry labels: `example.com.tw` and `example.co.uk` are one
 * site, so an eTLD+1 of the last two labels would treat `com.tw` as the site.
 * A full public-suffix list is overkill here — mirrors and CDN subdomains of
 * the same novel site are all this needs to keep together.
 */
const SECOND_LEVEL_LABELS = new Set([
  'com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'or', 'ne', 'gr', 'idv', 'mil', 'info', 'biz', 'nom',
])

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const [secondLevel, topLevel] = [labels[labels.length - 2], labels[labels.length - 1]]
  if (topLevel.length <= 3 && SECOND_LEVEL_LABELS.has(secondLevel)) {
    return labels.slice(-3).join('.')
  }
  return labels.slice(-2).join('.')
}

export function isSameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b)
}

const IGNORED_SCHEMES = /^(javascript|mailto|tel|data|about|ftp|magnet):/i

export function resolveHref(href: string, baseUrl: string): URL | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || IGNORED_SCHEMES.test(trimmed)) return null
  try {
    const resolved = new URL(trimmed, baseUrl)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null
    return resolved
  } catch {
    return null
  }
}

/** A `<base href>` retargets every relative link on the page, including the next-page link. */
export function resolveBaseUrl(baseHref: string | null, pageUrl: string): string {
  if (!baseHref) return pageUrl
  try {
    return new URL(baseHref, pageUrl).toString()
  } catch {
    return pageUrl
  }
}

/** Dedupe key: the hash is a same-page anchor, the query often carries the chapter id. */
export function normalizeUrl(url: URL): string {
  const full = url.toString()
  // The hash is always the suffix, so trimming it beats reparsing the URL.
  return url.hash ? full.slice(0, full.length - url.hash.length) : full
}

/**
 * Collapses a URL to the *shape* its siblings share, so chapter links cluster
 * together regardless of their ids: `/n/sk2e5` and `/n/c8hhtd` both become `/n/<s>`.
 */
export function shapeKey(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean).map(shapeSegment)
  const path = `/${segments.join('/')}${url.pathname.endsWith('/') && segments.length > 0 ? '/' : ''}`
  if (!url.search) return path
  const queryKeys = [...new Set(Array.from(url.searchParams.keys()))].sort()
  return queryKeys.length > 0 ? `${path}?${queryKeys.join('&')}` : path
}

function shapeSegment(segment: string): string {
  const dot = segment.lastIndexOf('.')
  const hasExtension = dot > 0 && /^\.[a-z0-9]{1,5}$/i.test(segment.slice(dot))
  const base = hasExtension ? segment.slice(0, dot) : segment
  const extension = hasExtension ? segment.slice(dot).toLowerCase() : ''
  return `${shapeBase(base)}${extension}`
}

function shapeBase(base: string): string {
  if (base.length === 0) return base
  if (/^\d+$/.test(base)) return '<n>'
  // `p948` / `2020a` read as a numbered sibling, not an opaque id.
  if (!/^[a-z]+\d+$/i.test(base) && !/^\d+[a-z]+$/i.test(base)
    && /^[a-z0-9]{4,}$/i.test(base) && /\d/.test(base) && /[a-z]/i.test(base)) {
    return '<s>'
  }
  if (/^[a-z][a-z-]{9,}$/i.test(base)) return '<s>'
  return base.replace(/\d+/g, '<n>').toLowerCase()
}

/**
 * The most specific id-looking segment of a directory URL — the value a chapter
 * URL of the *same book* must still carry.
 */
export function bookIdSegment(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (/\.[a-z0-9]{1,5}$/i.test(segment)) continue
    if (segment.length < 3) continue
    if (/^\d{3,}$/.test(segment)) return segment
    if (/^[a-z0-9-]{4,}$/i.test(segment) && (/\d/.test(segment) || segment.length >= 8)) return segment
  }
  return null
}

/** Query keys that carry a page number, for both in-chapter parts and directory pages. */
export const PAGE_PARAMS = ['page', 'p', 'pn', 'pageno', 'pagenum']

/**
 * True when `candidate` is a later part of the *same* chapter as `original`.
 * The stem always comes from the original URL, so part 2 → part 3 cannot drift
 * into `_2_2.html`.
 */
export function isContinuationPart(original: URL, candidate: URL): boolean {
  if (original.origin !== candidate.origin) return false

  const originalPath = trimTrailingSlash(original.pathname)
  const candidatePath = trimTrailingSlash(candidate.pathname)

  if (originalPath === candidatePath) {
    const candidatePage = readPageParam(candidate)
    return candidatePage !== null && candidatePage >= 2 && candidatePage > (readPageParam(original) ?? 1)
  }

  const originalParts = splitExtension(originalPath)
  const candidateParts = splitExtension(candidatePath)
  if (originalParts.extension !== candidateParts.extension) return false

  const suffixMatch = candidateParts.base.match(/^(.*?)[_\-/](\d+)$/)
  if (!suffixMatch) return false
  return suffixMatch[1] === originalParts.base && Number.parseInt(suffixMatch[2], 10) >= 2
}

function readPageParam(url: URL): number | null {
  for (const key of PAGE_PARAMS) {
    const raw = url.searchParams.get(key)
    if (raw && /^\d+$/.test(raw)) return Number.parseInt(raw, 10)
  }
  return null
}

function splitExtension(path: string): { base: string; extension: string } {
  const match = path.match(/^(.*?)(\.[a-z0-9]{1,5})$/i)
  return match ? { base: match[1], extension: match[2].toLowerCase() } : { base: path, extension: '' }
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}
