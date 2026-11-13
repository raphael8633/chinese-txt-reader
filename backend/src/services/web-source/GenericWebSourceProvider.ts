import { FetchBudgetExceededError, type SafeFetchService } from '../fetch/SafeFetchService.js'
import { ensureWebSourceResponse } from './fetchGuard.js'
import {
  chapterUrlsOf,
  extractBookTitle,
  extractChapterPage,
  finalizeChapterList,
  type ChapterPageExtraction,
  type Confidence,
} from './generic/chapterList.js'
import { extractChapterContent, findNextPartUrl } from './generic/content.js'
import { decodeHtml } from './generic/decode.js'
import { findDirectoryPageLinks } from './generic/pagination.js'
import { tokenize, type Token } from './generic/tokenizer.js'
import type { ParsedWebSource, WebSourceProvider, WebSourceSearchHit } from './types.js'
import { UnsupportedWebSourceError, WebSourceParseError } from './types.js'

const TIMEOUT_MS = 8000
const MAX_BYTES = 4 * 1024 * 1024
const MAX_CHAPTER_PARTS = 8
/**
 * Directory pages to walk, page 1 included. Well under the 120-fetch chapter-list
 * budget, so a paginated directory still leaves room for the service's own work.
 */
const DEFAULT_MAX_LIST_PAGES = 30
const CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'text/xml', 'application/xml']

type SafeFetchLike = Pick<SafeFetchService, 'fetchBuffer'>

export type GenericWebSourceProviderOptions = {
  /** Cap on directory pages fetched for one list, page 1 included. */
  maxListPages?: number
}

type FetchedPage = {
  tokens: Token[]
  finalUrl: string
  encodingDebug: string
}

/** Why the walk stopped short of the last page; null when the directory simply ended. */
type Truncation = 'cap' | 'error' | 'budget' | null

type DirectoryWalk = {
  pages: ChapterPageExtraction[]
  debugMessages: string[]
  truncation: Truncation
}

/**
 * Last-resort provider for sites nobody wrote a dedicated parser for: it reads
 * the page structure instead of site-specific selectors. Every result carries a
 * confidence warning because a heuristic can be confidently wrong.
 */
export class GenericWebSourceProvider implements WebSourceProvider {
  readonly providerId = 'generic'
  readonly displayName = '通用解析'
  readonly displayHost = '任意小說站（實驗）'

  private readonly maxListPages: number

  constructor(
    private readonly safeFetch: SafeFetchLike,
    options: GenericWebSourceProviderOptions = {},
  ) {
    this.maxListPages = Math.max(1, options.maxListPages ?? DEFAULT_MAX_LIST_PAGES)
  }

  /** Registered last, so this deliberately accepts anything the dedicated providers declined. */
  canHandle(url: string): boolean {
    try {
      const protocol = new URL(url).protocol
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  }

  canHandleHost(url: string): boolean {
    return this.canHandle(url)
  }

  /** Includes the host: a path-only key would collide across every site this handles. */
  getChapterKey(url: string): string | null {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      return `${this.providerId}:${parsed.host}${parsed.pathname}${parsed.search}`
    } catch {
      return null
    }
  }

  async search(_title: string): Promise<WebSourceSearchHit[]> {
    return []
  }

  async parseChapterList(url: string): Promise<ParsedWebSource> {
    if (!this.canHandle(url)) throw new UnsupportedWebSourceError(url)

    const page = await this.fetchPage(url)
    const first = extractChapterPage(page.tokens, page.finalUrl)
    const title = extractBookTitle(first.document)

    const walk = await this.followDirectoryPages(first, new URL(page.finalUrl))
    const { warnings, debugMessages, confidenceCeiling } = describeDirectoryWalk(walk)
    const detected = finalizeChapterList(walk.pages, {
      warnings,
      debugMessages: [...walk.debugMessages, ...debugMessages],
      confidenceCeiling,
    })

    return {
      title,
      sourceUrl: page.finalUrl,
      providerId: this.providerId,
      chapters: detected.chapters,
      warnings: detected.warnings,
      debugMessages: [page.encodingDebug, ...detected.debugMessages],
    }
  }

  /**
   * Walks `index_2.html`-style directory pages after the first one, forcing every
   * page to reuse page 1's chapter shape so a sidebar on page 4 cannot redefine
   * what a chapter looks like half-way through the book.
   */
  private async followDirectoryPages(first: ChapterPageExtraction, listUrl: URL): Promise<DirectoryWalk> {
    const pages = [first]
    const debugMessages: string[] = []
    const chapterUrls = new Set(chapterUrlsOf(first))
    const queued = new Map<number, string>()
    const visited = new Set<number>([1])

    const discover = (source: ChapterPageExtraction): void => {
      for (const link of findDirectoryPageLinks(source.links, listUrl, {
        chapterShapeKey: first.shapeKey,
        chapterUrls,
      })) {
        if (visited.has(link.page) || queued.has(link.page)) continue
        queued.set(link.page, link.url)
      }
    }
    discover(first)

    let truncation: Truncation = null
    while (queued.size > 0) {
      const [nextPage, nextUrl] = [...queued.entries()].sort((a, b) => a[0] - b[0])[0]
      queued.delete(nextPage)
      visited.add(nextPage)
      if (pages.length >= this.maxListPages) {
        truncation = 'cap'
        break
      }

      let fetched: FetchedPage
      try {
        fetched = await this.fetchPage(nextUrl)
      } catch (error) {
        // Everything already collected is still a usable book; the warning tells
        // the user it stops early rather than pretending the directory ended.
        truncation = error instanceof FetchBudgetExceededError ? 'budget' : 'error'
        break
      }
      debugMessages.push(`目錄分頁：第 ${nextPage} 頁 ${fetched.finalUrl}`)

      const extraction = extractChapterPage(fetched.tokens, fetched.finalUrl, {
        shapeKey: first.shapeKey,
        bookGuardUrl: listUrl,
        allowSparse: true,
      })
      if (extraction.members.length === 0) {
        truncation = 'error'
        break
      }

      const fresh = extraction.members.filter((member) => !chapterUrls.has(member.normalized))
      // A page that repeats page 1 verbatim is how sites answer an out-of-range
      // page number; that is the end of the directory, not a failure.
      if (fresh.length === 0) break
      for (const member of fresh) chapterUrls.add(member.normalized)
      pages.push(extraction)
      discover(extraction)
    }

    return { pages, debugMessages, truncation }
  }

  async fetchChapterText(url: string): Promise<string> {
    if (!this.canHandle(url)) throw new UnsupportedWebSourceError(url)

    const paragraphs: string[] = []
    const visited = new Set<string>()
    let currentUrl: string | null = url

    for (let part = 0; currentUrl && part < MAX_CHAPTER_PARTS; part += 1) {
      if (visited.has(currentUrl)) break
      visited.add(currentUrl)

      const page: FetchedPage = await this.fetchPage(currentUrl)
      const content = extractChapterContent(page.tokens)
      if (!content) {
        if (part === 0) throw new WebSourceParseError('找不到內文（通用解析）：此頁可能以 JavaScript 載入內文')
        break
      }
      paragraphs.push(...content.paragraphs)

      const nextUrl: string | null = findNextPartUrl(page.tokens, page.finalUrl, url)
      currentUrl = nextUrl && !visited.has(nextUrl) ? nextUrl : null
    }

    const text = paragraphs.join('\n\n')
    if (!text) throw new WebSourceParseError('找不到內文（通用解析）')
    return text
  }

  private async fetchPage(url: string): Promise<FetchedPage> {
    const response = await this.fetchBufferOrExplain(url)
    const decoded = decodeHtml(response.data, response.headers['content-type'])
    // Non-2xx bodies come back as ordinary bytes; without this an error page
    // would be tokenized and parsed as if it were the book.
    ensureWebSourceResponse({
      url: response.url,
      statusCode: response.statusCode,
      headers: response.headers,
      text: decoded.text,
    })
    return {
      tokens: tokenize(decoded.text),
      finalUrl: response.url,
      encodingDebug: `通用解析：編碼 ${decoded.encoding}（來源：${decoded.source}），${response.bytesRead} bytes`,
    }
  }

  private async fetchBufferOrExplain(url: string) {
    try {
      return await this.safeFetch.fetchBuffer(url, {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
        contentTypes: CONTENT_TYPES,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'UnsupportedContentTypeError') {
        throw new WebSourceParseError(`此網址不是網頁（${error.message}），請貼章節目錄頁網址`)
      }
      throw error
    }
  }
}

function describeDirectoryWalk(walk: DirectoryWalk): { warnings: string[]; debugMessages: string[]; confidenceCeiling?: Confidence } {
  const warnings: string[] = []
  const debugMessages: string[] = []
  if (walk.pages.length > 1 && walk.truncation === null) {
    debugMessages.push(`目錄分頁：已合併 ${walk.pages.length} 頁`)
  }
  if (walk.truncation === 'budget') {
    warnings.push(`目錄分頁因抓取預算中止，僅載入前 ${walk.pages.length} 頁`)
  } else if (walk.truncation !== null) {
    warnings.push(`目錄分頁超過上限，僅載入前 ${walk.pages.length} 頁（可能不完整）`)
  }
  // A list we know is cut short must not claim 高 just because its titles parse well.
  return walk.truncation === null
    ? { warnings, debugMessages }
    : { warnings, debugMessages, confidenceCeiling: 'low' }
}
