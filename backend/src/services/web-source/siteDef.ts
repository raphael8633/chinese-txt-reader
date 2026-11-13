import type { ElementSelector, ParagraphMode } from './html.js'
import type { ParsedWebSource, WebSourceChapter } from './types.js'

export type SiteEncoding = 'utf8' | 'gb18030'

/** Selects the book title: the `<h1>`/`<title>` shortcuts, or any element selector. */
export type TitleSelector = 'h1' | 'title' | ElementSelector

/** A title selector, optionally with strips that apply to this selector alone. */
export type TitleSelectorDef =
  | TitleSelector
  | {
    select: TitleSelector
    /** Applied before `TitleDef.strips` — site-a' `<title>` opens with a `【…】` tag. */
    preStrip: RegExp[]
  }

export type TitleDef = {
  selectors: TitleSelectorDef[]
  /** Applied in order to the first *matched* selector's text (an empty match still wins). */
  strips: RegExp[]
}

/** Tried in order; `last` takes the final match rather than the first (site-e's `</div>`). */
export type EndMarkerDef = RegExp | { pattern: RegExp, pick: 'first' | 'last' }

export type ContentDef =
  | {
    kind: 'container'
    candidates: ElementSelector[]
    /**
     * `first` takes the first candidate that matches; `first-nonempty` the first whose
     * text is non-empty (e.g. article → content div → `<body>`); `largest-text`
     * the text-heaviest.
     */
    pick: 'first' | 'first-nonempty' | 'largest-text'
  }
  | {
    kind: 'markers'
    /** Content starts after this marker (scripts/styles already stripped). */
    start: RegExp
    /** `last` takes the last start marker occurring before the end marker. */
    startPick: 'first' | 'last'
    /** Tried in order; the first that matches sets the content end. */
    end: EndMarkerDef[]
    /** When no end marker matches, end at the document instead of failing (site-e). */
    endFallback?: 'document-end'
    /** When no start/end pair matches, treat the whole document as the block (site-d). */
    fallback?: 'document'
  }

export type ListFragmentDef = {
  method: 'POST'
  /** Template over `$origin` and the listPath captures `$1`..`$9`. */
  url: string
  body: string
  /** Template values too; `$listUrl` is the canonical list url. */
  headers: Record<string, string>
}

export type SearchDef = {
  method?: 'GET' | 'POST'
  /** Template over `$q` (the encoded query) and `$origin`. */
  url: string
  body?: string
  queryEncoding: 'utf8' | 'gbk'
  /** Convert the keyword to simplified Chinese before encoding (for sites that only index 简体). */
  toSimplified?: boolean
  /** Defaults to the site encoding. */
  responseEncoding?: SiteEncoding
  hitPath: RegExp
  /** Template over `$origin` and the hitPath captures. */
  hitUrl: string
  hitTitleSub?: RegExp
  /** Reuses the site's title strips on each hit title (site-e/site-d list `…小說`). */
  titleTransform?: 'title-strips'
  /** Only anchors inside these blocks count as results. */
  scopeTo?: RegExp
  /**
   * An exact-title match 302s straight to a book page; when the final url's pathname
   * matches, the page itself is the single hit (its captures feed `hitUrl`).
   */
  redirectIsHit?: RegExp
  /** Overrides `hitUrl` for a `redirectIsHit` hit; `$url` is the final url verbatim. */
  redirectHitUrl?: string
  limit?: number
}

/** In-chapter pagination: one chapter split across `…_2`, `…_3` pages (site-d). */
export type PaginationDef = {
  navContainer: ElementSelector
  /** Followed only when the link's text contains this (e.g. `下一章`). */
  linkText: string
  /** Capture 1 is the chapter stem; a next link only counts when its stem is the same. */
  stemPattern: RegExp
  maxParts: number
}

export type ChapterUrlNormalizeDef = {
  stripQuery?: boolean
  replace?: [RegExp, string]
}

export type HookContext = {
  chapters: WebSourceChapter[]
  warnings: string[]
  debugMessages: string[]
  fetchText: (url: string, options?: { encoding?: SiteEncoding }) => Promise<string>
}

export type SiteHooks = {
  /**
   * Last resort for a pass no SiteDef field can describe: runs after the directory
   * anchors are parsed and returns the chapter list to publish, pushing any user-facing
   * notes onto `ctx.warnings` / `ctx.debugMessages`. `sites/site-d.ts` uses it to
   * verify and refill gaps the source directory omits.
   */
  onChaptersParsed?: (ctx: HookContext) => Promise<ParsedWebSource['chapters']>
}

export type SiteDef = {
  id: string
  displayName: string
  displayHost: string
  listUrlExample: string
  hosts: string[]
  encoding: SiteEncoding
  /** Chapter-list path; capture groups identify the book. */
  listPath: RegExp
  chapterPath: RegExp
  /** Extra paths `canHandle` accepts (e.g. a book landing page that maps to the directory). */
  acceptPaths?: RegExp[]
  /**
   * `canHandle` accepts every path on `hosts`. Only for sites whose directory pages have
   * no distinguishable url shape, since it makes the provider claim the whole
   * host ahead of the generic one.
   */
  acceptAnyPath?: boolean
  /** Rewrites the requested pathname into the canonical list url before fetching. */
  inputRewrite?: { from: RegExp, to: string }
  listFragment?: ListFragmentDef
  /** Tried in order; the first that matches scopes the anchor scan. Omit to scan it all. */
  listContainer?: ElementSelector[]
  /** When no `listContainer` matches, scan the whole document (site-e, site-d). */
  listContainerFallback?: 'document'
  /**
   * `decode-trim` (the default) decodes entities in the anchor text once more and trims;
   * `strip-tags` publishes `stripTags` output as-is, which the sites ported from a bare
   * `stripTags(anchor)` need to stay byte-identical on doubly-escaped entities.
   */
  anchorTitle?: 'decode-trim' | 'strip-tags'
  /** Drop chapter links whose leading path captures differ from the list url's. */
  sameBookGuard?: boolean
  /** Reject non-chapter urls in `fetchChapterText` instead of trying to parse them. */
  strictChapterFetch?: boolean
  chapterUrlNormalize?: ChapterUrlNormalizeDef
  /** Defaults to `chapterUrlNormalize`; separate because keys are persisted. */
  chapterKeyNormalize?: ChapterUrlNormalizeDef
  title: TitleDef
  content: ContentDef
  paragraphs: ParagraphMode
  /** Markup stripped inside every paragraph before text extraction. */
  contentStrips?: RegExp[]
  /** Raw paragraph segments matching any of these are dropped before text extraction. */
  segmentFilters?: RegExp[]
  /** Paragraphs matching any of these are dropped (promo/domain-notice lines). */
  lineFilters?: RegExp[]
  /** When the paragraph split finds nothing, publish the block's plain text (site-d). */
  paragraphFallback?: 'block-text'
  pagination?: PaginationDef
  search?: SearchDef
  hooks?: SiteHooks
  /** Chapter-list response cap; chapter and search pages always use 2 MB. */
  listMaxBytes?: number
}

const FORBIDDEN_HEADERS = new Set(['cookie', 'authorization', 'host'])

/**
 * SiteDefs are module singletons, so a stateful (`g`/`y`) regex would leak `lastIndex`
 * between calls and make `.test()` alternate. Only the marker patterns, which the engine
 * clones per call, are allowed to carry them.
 */
export function validateSiteDef(site: SiteDef): SiteDef {
  const stateless: [string, RegExp | undefined][] = [
    ['listPath', site.listPath],
    ['chapterPath', site.chapterPath],
    ['inputRewrite.from', site.inputRewrite?.from],
    ['chapterUrlNormalize.replace', site.chapterUrlNormalize?.replace?.[0]],
    ['chapterKeyNormalize.replace', site.chapterKeyNormalize?.replace?.[0]],
    ['search.hitPath', site.search?.hitPath],
    ['search.redirectIsHit', site.search?.redirectIsHit],
    ['pagination.stemPattern', site.pagination?.stemPattern],
    ...(site.acceptPaths ?? []).map((pattern, index): [string, RegExp] => [`acceptPaths[${index}]`, pattern]),
    ...(site.segmentFilters ?? []).map((pattern, index): [string, RegExp] => [`segmentFilters[${index}]`, pattern]),
    ...(site.lineFilters ?? []).map((pattern, index): [string, RegExp] => [`lineFilters[${index}]`, pattern]),
  ]
  for (const [field, pattern] of stateless) {
    if (pattern && (pattern.global || pattern.sticky)) {
      throw new Error(`SiteDef ${site.id}: ${field} must not use the g or y flag`)
    }
  }

  for (const [name] of Object.entries(site.listFragment?.headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`SiteDef ${site.id}: header "${name}" is not allowed`)
    }
  }

  if (!site.hosts.length) throw new Error(`SiteDef ${site.id}: hosts must not be empty`)
  return site
}

/** Substitutes `$origin`, `$listUrl`, `$url`, `$q` and the positional captures `$1`..`$9`. */
export function fillTemplate(
  template: string,
  values: { origin?: string, listUrl?: string, url?: string, q?: string, captures?: string[] },
): string {
  return template.replace(/\$(origin|listUrl|url|q|[1-9])/g, (_, token: string) => {
    if (token === 'origin') return values.origin ?? ''
    if (token === 'listUrl') return values.listUrl ?? ''
    if (token === 'url') return values.url ?? ''
    if (token === 'q') return values.q ?? ''
    return values.captures?.[Number.parseInt(token, 10) - 1] ?? ''
  })
}
