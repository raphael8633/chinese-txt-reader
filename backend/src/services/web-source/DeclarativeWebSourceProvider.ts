import iconv from 'iconv-lite'
import type { SafeFetchService } from '../fetch/SafeFetchService.js'
import { percentEncodeBytes } from './htmlUtils.js'
import { toSimplifiedQuery } from './textConversion.js'
import { ensureWebSourceResponse } from './fetchGuard.js'
import {
  cleanText,
  decodeHtmlEntities,
  extractAllBalancedElements,
  extractElement,
  extractFirstElementInner,
  extractSearchHits,
  getFirstAttr,
  resolveUrl,
  splitParagraphs,
  stripScriptsAndStyles,
  stripTags,
  stripTitle,
} from './html.js'
import type { ElementSelector } from './html.js'
import { fillTemplate, validateSiteDef } from './siteDef.js'
import type {
  ChapterUrlNormalizeDef,
  EndMarkerDef,
  PaginationDef,
  SiteDef,
  SiteEncoding,
  TitleSelector,
} from './siteDef.js'
import { UnsupportedWebSourceError, WebSourceParseError } from './types.js'
import type { ParsedWebSource, WebSourceProvider, WebSourceSearchHit } from './types.js'

type SafeFetchLike = Pick<SafeFetchService, 'fetchText'>

const TIMEOUT_MS = 8000
const CHAPTER_MAX_BYTES = 2 * 1024 * 1024
const SEARCH_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_LIST_MAX_BYTES = 4 * 1024 * 1024

/** A WebSourceProvider driven entirely by a SiteDef; no per-site code. */
export class DeclarativeWebSourceProvider implements WebSourceProvider {
  readonly providerId: string
  readonly displayName: string
  readonly displayHost: string
  readonly listUrlExample: string
  private readonly site: SiteDef
  private readonly hosts: Set<string>

  constructor(site: SiteDef, private readonly safeFetch: SafeFetchLike) {
    this.site = validateSiteDef(site)
    this.providerId = site.id
    this.displayName = site.displayName
    this.displayHost = site.displayHost
    this.listUrlExample = site.listUrlExample
    this.hosts = new Set(site.hosts.map((host) => host.toLowerCase()))
  }

  getChapterKey(url: string): string | null {
    try {
      const pathname = normalizePath(
        new URL(url),
        this.site.chapterKeyNormalize ?? this.site.chapterUrlNormalize,
      ).pathname
      return this.site.chapterPath.test(pathname) ? `${this.providerId}:${pathname}` : null
    } catch {
      return null
    }
  }

  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url)
      if (!this.hosts.has(parsed.hostname.toLowerCase())) return false
      if (this.site.acceptAnyPath) return true
      return this.site.listPath.test(parsed.pathname)
        || this.site.chapterPath.test(parsed.pathname)
        || (this.site.acceptPaths ?? []).some((pattern) => pattern.test(parsed.pathname))
    } catch {
      return false
    }
  }

  canHandleHost(url: string): boolean {
    try {
      return this.hosts.has(new URL(url).hostname.toLowerCase())
    } catch {
      return false
    }
  }

  async search(title: string): Promise<WebSourceSearchHit[]> {
    const def = this.site.search
    const query = title.trim()
    if (!def || !query) return []

    const keyword = def.toSimplified ? toSimplifiedQuery(query) : query
    const encoded = def.queryEncoding === 'gbk'
      ? percentEncodeBytes(iconv.encode(keyword, 'gbk'))
      : encodeURIComponent(keyword)
    const response = await this.safeFetch.fetchText(fillTemplate(def.url, { q: encoded }), {
      timeoutMs: TIMEOUT_MS,
      maxBytes: SEARCH_MAX_BYTES,
      encoding: def.responseEncoding ?? this.site.encoding,
      ...(def.method === 'POST'
        ? { method: 'POST' as const, body: fillTemplate(def.body ?? '', { q: encoded }) }
        : {}),
    })
    ensureWebSourceResponse(response)

    const finalUrl = new URL(response.url)
    const redirected = def.redirectIsHit?.exec(finalUrl.pathname)
    if (redirected) {
      return [{
        providerId: this.providerId,
        title: this.extractTitle(response.text),
        url: fillTemplate(def.redirectHitUrl ?? def.hitUrl, {
          origin: finalUrl.origin,
          url: response.url,
          captures: redirected.slice(1),
        }),
      }]
    }

    return extractSearchHits(response.text, {
      baseUrl: response.url,
      providerId: this.providerId,
      hostPattern: (host) => this.hosts.has(host),
      pathPattern: def.hitPath,
      hitUrl: (origin, captures) => fillTemplate(def.hitUrl, { origin, captures }),
      ...(def.scopeTo ? { scopeTo: def.scopeTo } : {}),
      ...(def.hitTitleSub ? { titleSub: def.hitTitleSub } : {}),
      ...(def.titleTransform === 'title-strips'
        ? { titleTransform: (title: string) => stripTitle(title, this.site.title.strips) }
        : {}),
      ...(def.limit ? { limit: def.limit } : {}),
    })
  }

  async parseChapterList(url: string): Promise<ParsedWebSource> {
    if (!this.canHandle(url)) throw new UnsupportedWebSourceError(url)

    const listUrl = this.toListUrl(url)
    const listPage = await this.safeFetch.fetchText(listUrl, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: this.site.listMaxBytes ?? DEFAULT_LIST_MAX_BYTES,
      encoding: this.site.encoding,
    })
    // A blocked or missing list page must not still trigger the fragment request.
    ensureWebSourceResponse(listPage)

    // Book identity comes from the requested (canonical) list url, so a redirect cannot
    // silently widen the same-book guard or the directory-fragment key.
    const listCaptures = this.site.listPath.exec(new URL(listUrl).pathname)?.slice(1) ?? null
    const directoryHtml = await this.fetchDirectoryHtml(listUrl, listCaptures) ?? listPage.text
    const chapters = this.extractChapterLinks(directoryHtml, listPage.url, listCaptures)
    if (chapters.length === 0) throw new WebSourceParseError('No chapters found')

    const parsed: ParsedWebSource = {
      title: this.extractTitle(listPage.text),
      sourceUrl: listPage.url,
      providerId: this.providerId,
      chapters,
    }

    const hook = this.site.hooks?.onChaptersParsed
    if (!hook) return parsed

    const warnings: string[] = []
    const debugMessages: string[] = []
    return {
      ...parsed,
      chapters: await hook({
        chapters,
        warnings,
        debugMessages,
        fetchText: async (url, options) => (await this.fetchChapterPage(url, options?.encoding)).text,
      }),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(debugMessages.length > 0 ? { debugMessages } : {}),
    }
  }

  async fetchChapterText(url: string): Promise<string> {
    if (!this.canHandle(url)) throw new UnsupportedWebSourceError(url)
    if (this.site.strictChapterFetch && !this.site.chapterPath.test(new URL(url).pathname)) {
      throw new UnsupportedWebSourceError(url)
    }

    const pagination = this.site.pagination
    if (!pagination) return this.extractChapterText((await this.fetchChapterPage(url)).text)

    // One chapter can be split across `…_2`, `…_3` pages linked by a next-chapter anchor
    // that, at the last part, leads out of this chapter — hence the stem check.
    const parts: string[] = []
    const seen = new Set<string>()
    let currentUrl: string | null = url
    for (let count = 0; currentUrl && count < pagination.maxParts; count += 1) {
      if (seen.has(currentUrl)) break
      seen.add(currentUrl)

      const response = await this.fetchChapterPage(currentUrl)
      parts.push(this.extractChapterText(response.text))
      const next = findNavLink(response.text, response.url, pagination)
      currentUrl = next && isSameChapterStem(url, next, pagination.stemPattern) ? next : null
    }

    const text = parts.filter(Boolean).join('\n\n')
    if (!text) throw new WebSourceParseError('No chapter content found')
    return text
  }

  /** A chapter-sized fetch, guarded — the hook's `fetchText` shares it with recovery passes. */
  private async fetchChapterPage(url: string, encoding?: SiteEncoding) {
    const response = await this.safeFetch.fetchText(url, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: CHAPTER_MAX_BYTES,
      encoding: encoding ?? this.site.encoding,
    })
    ensureWebSourceResponse(response)
    return response
  }

  /** Rewrites a bookinfo/loose url into the canonical directory url before fetching. */
  private toListUrl(url: string): string {
    const rewrite = this.site.inputRewrite
    if (!rewrite) return url
    const parsed = new URL(url)
    const match = rewrite.from.exec(parsed.pathname)
    if (!match) return url
    return `${parsed.origin}${fillTemplate(rewrite.to, { captures: match.slice(1) })}`
  }

  private async fetchDirectoryHtml(listUrl: string, captures: string[] | null): Promise<string | null> {
    const fragment = this.site.listFragment
    if (!fragment) return null
    const values = { origin: new URL(listUrl).origin, listUrl, captures: captures ?? [] }
    const headers = Object.fromEntries(
      Object.entries(fragment.headers).map(([name, value]) => [name, fillTemplate(value, values)]),
    )
    const response = await this.safeFetch.fetchText(fillTemplate(fragment.url, values), {
      timeoutMs: TIMEOUT_MS,
      maxBytes: this.site.listMaxBytes ?? DEFAULT_LIST_MAX_BYTES,
      encoding: this.site.encoding,
      method: fragment.method,
      body: fillTemplate(fragment.body, values),
      headers,
    })
    ensureWebSourceResponse(response)
    return response.text
  }

  private extractTitle(html: string): string {
    for (const entry of this.site.title.selectors) {
      const selector = typeof entry === 'object' && 'select' in entry ? entry.select : entry
      const inner = extractFirstElementInner(html, toSelector(selector))
      // A matched-but-empty element still wins; the class providers branch on the match.
      if (inner === null) continue
      const preStrip = typeof entry === 'object' && 'select' in entry ? entry.preStrip : []
      return stripTitle(applyStrips(stripTags(inner), preStrip), this.site.title.strips)
    }
    return '線上書源'
  }

  private extractChapterLinks(
    html: string,
    baseUrl: string,
    listCaptures: string[] | null,
  ): ParsedWebSource['chapters'] {
    const chapters: ParsedWebSource['chapters'] = []
    const seen = new Set<string>()
    const scope = this.scopeToListContainer(html)
    if (scope === null) return chapters

    for (const anchor of scope.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
      const href = getFirstAttr(anchor, 'href')
      if (!href) continue
      let resolved: URL
      try {
        resolved = normalizePath(new URL(resolveUrl(baseUrl, href)), this.site.chapterUrlNormalize)
      } catch {
        continue
      }
      const chapterMatch = this.site.chapterPath.exec(resolved.pathname)
      if (!chapterMatch) continue
      // Guard against recommendation links for other books leaking into the list.
      if (this.site.sameBookGuard && listCaptures && !sameBook(listCaptures, chapterMatch.slice(1))) continue
      const url = resolved.toString()
      if (seen.has(url)) continue
      const title = this.site.anchorTitle === 'strip-tags'
        ? stripTags(anchor)
        : decodeHtmlEntities(stripTags(anchor)).trim()
      if (!title) continue
      seen.add(url)
      chapters.push({ index: chapters.length, title, url })
    }
    return chapters
  }

  private scopeToListContainer(html: string): string | null {
    const candidates = this.site.listContainer
    if (!candidates?.length) return html
    for (const candidate of candidates) {
      const found = extractElement(html, candidate)
      if (found !== null) return found
    }
    return this.site.listContainerFallback === 'document' ? html : null
  }

  private extractChapterText(html: string): string {
    const content = this.site.content
    if (content.kind === 'container' && content.pick === 'first-nonempty') {
      // Walks the candidates in order (e.g. article → content div → <body>), keeping the first with text.
      for (const candidate of content.candidates) {
        const found = extractElement(html, candidate)
        if (found === null) continue
        const text = this.renderParagraphs(found)
        if (text) return text
      }
      throw new WebSourceParseError('No chapter content found')
    }

    const raw = content.kind === 'container'
      ? pickContainer(html, content.candidates, content.pick)
      : sliceBetweenMarkers(html, content) ?? (content.fallback === 'document' ? html : null)
    if (raw === null) throw new WebSourceParseError('No chapter content found')

    const text = this.renderParagraphs(raw)
    if (!text) throw new WebSourceParseError('No chapter content found')
    return text
  }

  /** Paragraph text of one content block; `''` when the block holds none. */
  private renderParagraphs(block: string): string {
    const strips = this.site.contentStrips ?? []
    const filters = this.site.lineFilters ?? []
    const paragraphs = splitParagraphs(block, this.site.paragraphs, strips, this.site.segmentFilters ?? [])
      .filter((line) => !filters.some((filter) => filter.test(line)))
    if (paragraphs.length > 0) return paragraphs.join('\n\n')
    // site-d serves some chapters as naked text with no paragraph markup at all.
    return this.site.paragraphFallback === 'block-text' ? cleanText(block, strips) : ''
  }
}

function toSelector(selector: TitleSelector): ElementSelector {
  return selector === 'h1' || selector === 'title' ? { tag: selector } : selector
}

function applyStrips(value: string, strips: RegExp[]): string {
  return strips.reduce((text, strip) => text.replace(strip, ''), value)
}

/** The next-part link inside the chapter's nav block, or null when there is none. */
function findNavLink(html: string, baseUrl: string, pagination: PaginationDef): string | null {
  const nav = extractElement(html, pagination.navContainer)
  if (!nav) return null
  for (const anchor of nav.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
    if (!stripTags(anchor).includes(pagination.linkText)) continue
    const href = getFirstAttr(anchor, 'href')
    // A text-only next-chapter marker means this was the last part.
    if (!href) return null
    return resolveUrl(baseUrl, href)
  }
  return null
}

function isSameChapterStem(originalUrl: string, candidateUrl: string, stemPattern: RegExp): boolean {
  const original = new URL(originalUrl)
  const candidate = new URL(candidateUrl)
  if (original.origin !== candidate.origin) return false
  const stem = stemPattern.exec(original.pathname)?.[1]
  return !!stem
    && stem === stemPattern.exec(candidate.pathname)?.[1]
    && candidate.pathname !== original.pathname
}

function normalizePath(url: URL, normalize: ChapterUrlNormalizeDef | undefined): URL {
  if (!normalize) return url
  const next = new URL(url.toString())
  if (normalize.replace) next.pathname = next.pathname.replace(normalize.replace[0], normalize.replace[1])
  if (normalize.stripQuery) {
    next.search = ''
    next.hash = ''
  }
  return next
}

function sameBook(listCaptures: string[], chapterCaptures: string[]): boolean {
  return listCaptures.every((value, index) => value === chapterCaptures[index])
}

function pickContainer(
  html: string,
  candidates: ElementSelector[],
  pick: 'first' | 'first-nonempty' | 'largest-text',
): string | null {
  if (pick !== 'largest-text') {
    for (const candidate of candidates) {
      const found = extractElement(html, candidate)
      if (found !== null) return found
    }
    return null
  }

  // Several blocks can share the selector (site-b: one only holds the domain notice),
  // so the real body is the text-heaviest candidate rather than the first one.
  let best: string | null = null
  let bestLength = 0
  for (const candidate of candidates) {
    for (const found of extractAllBalancedElements(html, candidate)) {
      const length = cleanText(found).replace(/\s+/g, '').length
      if (length > bestLength) {
        best = found
        bestLength = length
      }
    }
  }
  return best
}

function sliceBetweenMarkers(
  html: string,
  content: Extract<SiteDef['content'], { kind: 'markers' }>,
): string | null {
  const cleaned = stripScriptsAndStyles(html)
  let end = -1
  for (const marker of content.end) {
    const index = findMarker(cleaned, marker)
    if (index >= 0) {
      end = index
      break
    }
  }
  if (end < 0) {
    if (content.endFallback !== 'document-end') return null
    end = cleaned.length
  }

  const startPattern = new RegExp(content.start.source, ensureGlobal(content.start.flags))
  let start = -1
  let marker: RegExpExecArray | null
  while ((marker = startPattern.exec(cleaned)) !== null) {
    if (marker.index >= end) break
    start = marker.index + marker[0].length
    if (content.startPick === 'first') break
  }
  return start < 0 ? null : cleaned.slice(start, end)
}

function ensureGlobal(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`
}

/** Index of an end marker's match, `-1` when it does not match at all. */
function findMarker(html: string, marker: EndMarkerDef): number {
  const { pattern, pick } = marker instanceof RegExp ? { pattern: marker, pick: 'first' as const } : marker
  if (pick === 'first') {
    return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).exec(html)?.index ?? -1
  }
  // site-e ends at the last `</div>` when the page_dir footer is absent.
  const scan = new RegExp(pattern.source, ensureGlobal(pattern.flags))
  let last = -1
  let match: RegExpExecArray | null
  while ((match = scan.exec(html)) !== null) {
    last = match.index
    if (match[0].length === 0) scan.lastIndex += 1
  }
  return last
}
