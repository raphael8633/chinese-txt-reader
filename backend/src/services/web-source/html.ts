import { decodeHtmlEntities, getFirstAttr, resolveUrl, stripTags } from './htmlUtils.js'
import type { WebSourceSearchHit } from './types.js'

const SCRIPT_PATTERN = /<script\b[\s\S]*?<\/script>/gi
const STYLE_PATTERN = /<style\b[\s\S]*?<\/style>/gi
const ANCHOR_PATTERN = /<a\b[^>]*>[\s\S]*?<\/a>/gi

/** Selects an element by tag plus (optionally) one attribute value. */
export type ElementSelector = {
  /** One tag, or several when a site renders the same block as either (site-f div/dl). */
  tag: string | string[]
  /** `tag` matches the element by name alone — no attribute condition. */
  by?: 'id' | 'class' | 'class-exact' | 'attr' | 'tag'
  /**
   * For `class`, matched as a whole word; for `id`/`class-exact`, matched exactly; for
   * `attr`, as a substring. A RegExp is inlined un-escaped, for values that are
   * themselves patterns (site-b's `text-indent\s*:\s*2em`) — its groups must be
   * non-capturing, since the open-tag pattern's own groups are positional.
   */
  value?: string | RegExp
  /** Attribute name(s) for `by: 'attr'`; several are tried as alternatives (e.g. id-or-class). */
  attrName?: string | string[]
  /** Also accept a bare attribute value — site-e/site-d render `class=list` unquoted. */
  unquoted?: boolean
  /**
   * `balanced` (the default) counts nested open tags; `first` stops at the first close
   * tag, mirroring the non-greedy one-liner regexes several sites were written against.
   */
  match?: 'balanced' | 'first'
}

export function stripScriptsAndStyles(html: string): string {
  return html.replace(SCRIPT_PATTERN, '').replace(STYLE_PATTERN, '')
}

/**
 * Builds the open-tag matcher for a selector. Attribute values tolerate spaces around `=`
 * and either quote style, because site-a renders `class = "content"` on some pages.
 */
function openTagPattern(selector: ElementSelector): RegExp {
  const tags = tagAlternation(selector.tag)
  const by = selector.by ?? 'tag'
  if (by === 'tag') return new RegExp(`<(${tags})\\b[^>]*>`, 'i')

  const attr = by === 'attr'
    ? `(?:${(Array.isArray(selector.attrName) ? selector.attrName : [selector.attrName ?? '']).join('|')})`
    : by === 'class-exact' ? 'class' : by
  const value = selector.value instanceof RegExp
    ? selector.value.source
    : escapeRegExp(selector.value ?? '')
  // `id`/`class-exact` pin the whole attribute value; `class` matches one whole word in
  // it; `attr` matches anywhere in it. `fill` is what may surround the value.
  const body = (fill: string): string => {
    if (by === 'id' || by === 'class-exact') return value
    return by === 'class' ? `${fill}\\b${value}\\b${fill}` : `${fill}${value}${fill}`
  }
  const values = [`"${body('[^"]*')}"`, `'${body("[^']*")}'`]
  if (selector.unquoted) values.push(body('[^\\s>]*'))
  return new RegExp(`<(${tags})\\b[^>]*${attr}\\s*=\\s*(?:${values.join('|')})[^>]*>`, 'i')
}

function tagAlternation(tag: string | string[]): string {
  return (Array.isArray(tag) ? tag : [tag]).join('|')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Inner HTML of the first match, balanced or non-greedy per the selector's `match`. */
export function extractElement(html: string, selector: ElementSelector): string | null {
  return (selector.match ?? 'balanced') === 'first'
    ? extractFirstElementInner(html, selector)
    : extractBalancedElement(html, selector)
}

/**
 * Inner HTML of the first balanced element matching `selector`. Scripts are stripped
 * before balancing so a literal `</div>` inside a script cannot truncate the block.
 */
export function extractBalancedElement(html: string, selector: ElementSelector): string | null {
  const cleaned = html.replace(SCRIPT_PATTERN, '')
  const open = openTagPattern(selector).exec(cleaned)
  if (!open) return null
  return sliceBalanced(cleaned, open.index + open[0].length, open[1].toLowerCase())
}

/**
 * Inner HTML of the first non-greedy `<tag …>…</tag>` match. Unlike
 * `extractBalancedElement` this neither balances nor strips scripts — it mirrors the
 * one-liner `<h1>` / `<title>` regexes the class providers use for book titles.
 */
export function extractFirstElementInner(html: string, selector: ElementSelector): string | null {
  const open = openTagPattern(selector)
  const tags = tagAlternation(selector.tag)
  const pattern = new RegExp(`${open.source}([\\s\\S]*?)</(?:${tags})>`, 'i')
  const match = pattern.exec(html)
  return match ? match[2] : null
}

/** Every balanced match, in document order — for "pick the text-heaviest block" strategies. */
export function extractAllBalancedElements(html: string, selector: ElementSelector): string[] {
  const cleaned = html.replace(SCRIPT_PATTERN, '')
  const pattern = new RegExp(openTagPattern(selector).source, 'gi')
  const found: string[] = []
  let open: RegExpExecArray | null
  while ((open = pattern.exec(cleaned)) !== null) {
    found.push(sliceBalanced(cleaned, open.index + open[0].length, open[1].toLowerCase()))
  }
  return found
}

function sliceBalanced(html: string, start: number, tag: string): string {
  const tokenPattern = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi')
  tokenPattern.lastIndex = start
  let depth = 1
  let token: RegExpExecArray | null
  while ((token = tokenPattern.exec(html)) !== null) {
    depth += token[0].startsWith('</') ? -1 : 1
    if (depth === 0) return html.slice(start, token.index)
  }
  return html.slice(start)
}

/**
 * Markup fragment to trimmed plain text: scripts/styles dropped, `<br>` to newline,
 * entities decoded, blank lines removed. `extraStrips` covers per-site noise markup
 * (site-e's `<!--PAGE n-->` page separators).
 */
export function cleanText(html: string, extraStrips: RegExp[] = []): string {
  let working = stripScriptsAndStyles(html)
  for (const strip of extraStrips) {
    working = working.replace(cloneGlobal(strip), '')
  }
  return decodeHtmlEntities(
    working
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

function cloneGlobal(pattern: RegExp): RegExp {
  return pattern.global ? new RegExp(pattern.source, pattern.flags) : pattern
}

/** `g` is required for the flags to scan every match; site defs must not have to remember. */
export function forceGlobal(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
}

/** Trims site furniture off a book title, falling back to a generic label. */
export function stripTitle(raw: string, strips: RegExp[]): string {
  let title = raw
  for (const strip of strips) {
    title = title.replace(cloneGlobal(strip), '')
  }
  return title.trim() || '線上書源'
}

export type SearchHitOptions = {
  baseUrl: string
  providerId: string
  hostPattern: (host: string) => boolean
  /** Accepts the hit's pathname; capture groups feed `hitUrl`. */
  pathPattern: RegExp
  /** Builds the canonical list url from `$origin` and `$1..$9`. */
  hitUrl: (origin: string, captures: string[]) => string
  /** Only look at anchors inside these blocks (site-b's `span.wd10` result titles). */
  scopeTo?: RegExp
  /** Prefer this sub-block's text over the whole anchor (site-a' novel-item-title). */
  titleSub?: RegExp
  /** Post-process the anchor text (site-e/site-d reuse their stripTitle). */
  titleTransform?: (title: string) => string
  limit?: number
}

export function extractSearchHits(html: string, options: SearchHitOptions): WebSourceSearchHit[] {
  const hits: WebSourceSearchHit[] = []
  const seen = new Set<string>()
  const scopes = options.scopeTo
    ? html.match(forceGlobal(options.scopeTo)) ?? []
    : [html]

  for (const scope of scopes) {
    for (const anchor of scope.match(ANCHOR_PATTERN) ?? []) {
      const href = getFirstAttr(anchor, 'href')
      if (!href) continue
      let parsed: URL
      try {
        parsed = new URL(resolveUrl(options.baseUrl, href))
      } catch {
        continue
      }
      if (!options.hostPattern(parsed.hostname.toLowerCase())) continue
      const match = cloneGlobal(options.pathPattern).exec(parsed.pathname)
      if (!match) continue
      const url = options.hitUrl(parsed.origin, match.slice(1).map((value) => value ?? ''))
      if (seen.has(url)) continue
      const sub = options.titleSub ? cloneGlobal(options.titleSub).exec(anchor) : null
      const raw = decodeHtmlEntities(stripTags(sub ? sub[1] : anchor)).trim()
      const title = options.titleTransform ? options.titleTransform(raw) : raw
      // A cover anchor wraps only an <img>; an empty title must not claim the dedupe slot.
      if (!title) continue
      seen.add(url)
      hits.push({ providerId: options.providerId, title, url })
    }
  }
  return hits.slice(0, options.limit ?? 10)
}

export type ParagraphMode = 'p-elements' | 'br-lines' | 'p-open-split' | 'p-close-lines'

/**
 * Splits a content block into paragraphs.
 * - `p-elements`: `<p>…</p>` pairs (site-c, site-e, site-d)
 * - `br-lines`: one paragraph per text line, `<br>`-separated (site-a, site-f)
 * - `p-open-split`: split on self-closing `<p>` markers (site-b)
 * - `p-close-lines`: `br-lines`, with `</p>` also ending a line
 *
 * `segmentFilters` drop whole raw segments before text extraction, for noise that is only
 * recognisable as markup (site-b's book-title anchor line).
 */
export function splitParagraphs(
  html: string,
  mode: ParagraphMode,
  extraStrips: RegExp[] = [],
  segmentFilters: RegExp[] = [],
): string[] {
  const keep = (segment: string): boolean => !segmentFilters.some((filter) => filter.test(segment))
  if (mode === 'p-elements') {
    return Array.from(html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi), (match) => match[1])
      .filter(keep)
      .map((segment) => cleanText(segment, extraStrips))
      .filter(Boolean)
  }
  if (mode === 'p-open-split') {
    return html.split(/<p\b[^>]*>/i)
      .filter(keep)
      .map((segment) => cleanText(segment, extraStrips))
      .filter(Boolean)
  }
  if (mode === 'p-close-lines') {
    return cleanText(html.replace(/<\/p>/gi, '\n'), extraStrips).split('\n').filter(Boolean)
  }
  return cleanText(html, extraStrips).split('\n').filter(Boolean)
}

export { decodeHtmlEntities, getFirstAttr, resolveUrl, stripTags }
