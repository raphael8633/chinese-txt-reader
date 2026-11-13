import { parseChapterOrdinal } from '../../../utils/chapterOrdinal.js'
import type { WebSourceChapter } from '../types.js'
import { WebSourceParseError } from '../types.js'
import { NEXT_PAGE_PATTERN } from './content.js'
import { analyzeDocument, MAX_ANCHORS, type AnalyzedDocument, type Anchor } from './document.js'
import { directoryPageSignature, type ResolvedLink } from './pagination.js'
import { getAttribute, type Token } from './tokenizer.js'
import { rangeText } from './text.js'
import { bookIdSegment, isSameSite, normalizeUrl, resolveBaseUrl, resolveHref, shapeKey } from './urls.js'

const MIN_CHAPTERS = 5
const MAX_TITLE_LENGTH = 120
/** A container must hold nearly the whole cluster; otherwise it is a volume subgroup, not the list. */
const CONTAINER_COVERAGE = 0.8
const CONTAINER_ELEMENTS = new Set(['div', 'ul', 'ol', 'dl', 'table', 'tbody', 'section', 'nav', 'article', 'main'])

const ORDINAL_PATTERN = /第\s*[一二三四五六七八九十百千萬万零〇兩两\d]+\s*[章节節回卷部集话話幕]/
const PAGE_ORDINAL_PATTERN = /第\s*([一二三四五六七八九十百千萬万零〇兩两\d]+)\s*[頁页篇]/

export type Confidence = 'high' | 'medium' | 'low'

export type ChapterListResult = {
  chapters: WebSourceChapter[]
  warnings: string[]
  debugMessages: string[]
  confidence: Confidence
}

/** One directory page, extracted but not yet ordered — pagination merges several. */
export type ChapterPageExtraction = {
  document: AnalyzedDocument
  /** Where relative hrefs on this page resolve against, `<base href>` included. */
  baseUrl: string
  /** The URL shape the chapter cluster shares; later pages are forced to reuse it. */
  shapeKey: string
  /**
   * Every same-site link the pagination scan should consider: chapter-shaped anchors
   * plus `<select>` option values and text-less "next page" anchors, which are never
   * chapter candidates themselves.
   */
  links: ResolvedLink[]
  members: Candidate[]
  /** Share of the container's links that are chapters — feeds the confidence call. */
  coverage: number
  warnings: string[]
  debugMessages: string[]
}

export type FinalizeOptions = {
  warnings?: string[]
  debugMessages?: string[]
  /** Caps the reported confidence; a truncated multi-page list can never be 高. */
  confidenceCeiling?: Confidence
}

export type ExtractPageOptions = {
  /** Reuse the first page's winning shape instead of scoring this page's clusters. */
  shapeKey?: string
  /** Book-id guard reference; later pages must be judged against the *list* URL. */
  bookGuardUrl?: URL
  /** A later page may legitimately be short (last page) or empty (wrong guess). */
  allowSparse?: boolean
}

type Candidate = {
  url: URL
  normalized: string
  title: string
  anchor: Anchor
  /** Parsed once at collection time; scoring, ordering and confidence all read it. */
  ordinal: number | null
  /** Ordering only — also covers 第N頁 lists and bare numbers. */
  sequence: number | null
  hasDigits: boolean
}

/** Single-page detection: the shape every non-paginated caller still wants. */
export function detectChapterList(tokens: Token[], responseUrl: string): ChapterListResult {
  return finalizeChapterList([extractChapterPage(tokens, responseUrl)])
}

/**
 * Reads one directory page down to its chapter candidates. Ordering, reversal and
 * confidence are deliberately left to `finalizeChapterList`, which sees every page
 * of a paginated directory at once — deciding "is this list reversed?" per page
 * would flip pages against each other.
 */
export function extractChapterPage(
  tokens: Token[],
  responseUrl: string,
  options: ExtractPageOptions = {},
): ChapterPageExtraction {
  const document = analyzeDocument(tokens)
  const baseUrl = resolveBaseUrl(document.baseHref, responseUrl)
  const pageUrl = new URL(responseUrl)
  const allowSparse = options.allowSparse ?? false

  const candidates = collectCandidates(document, baseUrl, pageUrl.hostname)
  if (!allowSparse && candidates.length < MIN_CHAPTERS) throw noChapterList()

  const clusters = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const key = shapeKey(candidate.url)
    const bucket = clusters.get(key)
    if (bucket) bucket.push(candidate)
    else clusters.set(key, [candidate])
  }

  const picked = options.shapeKey
    ? { key: options.shapeKey, members: clusters.get(options.shapeKey) ?? [], score: -1 }
    : pickBestCluster(clusters)
  if (!picked || (!allowSparse && picked.members.length < MIN_CHAPTERS)) throw noChapterList()

  const debugMessages: string[] = [
    `通用解析：候選連結 ${candidates.length}，形狀分群 ${clusters.size}，`
    + `選中形狀 ${picked.key}（${picked.members.length} 條，分數 ${picked.score}）`,
  ]
  const warnings: string[] = []
  if (document.anchorsTruncated) {
    warnings.push(`頁面連結過多，僅分析前 ${MAX_ANCHORS} 條，章節可能不完整`)
  }
  const paginationLinks = collectPaginationOnlyLinks(document, baseUrl, pageUrl.hostname)
  const base = {
    document,
    baseUrl,
    shapeKey: picked.key,
    links: [...candidates, ...paginationLinks],
    warnings,
    debugMessages,
  }
  if (picked.members.length === 0) return { ...base, members: [], coverage: 0 }

  const scoped = scopeToContainer(document, picked.members)
  if (scoped.containerId >= 0) {
    const container = document.blocks[scoped.containerId]
    debugMessages.push(
      `容器：<${container.name}${container.attrs.trim() ? ` ${container.attrs.trim()}` : ''}>，`
      + `容器內同站連結 ${scoped.containerAnchorCount} 條，其中章節 ${scoped.members.length} 條`,
    )
  } else {
    debugMessages.push('容器：未找到共同容器，改用整頁連結')
  }

  const guarded = applySameBookGuard(scoped.members, options.bookGuardUrl ?? pageUrl)
  if (guarded.skipped) {
    warnings.push('無法用書號過濾，章節可能混入其他書籍的連結')
  }
  if (guarded.dropped > 0) {
    debugMessages.push(`書號過濾：以「${guarded.bookId}」剔除 ${guarded.dropped} 條其他書籍連結`)
  }

  const deduped = dedupe(guarded.members)
  if (!allowSparse && deduped.length < MIN_CHAPTERS) throw noChapterList()

  return { ...base, members: deduped, coverage: scoped.coverage }
}

/**
 * Merges directory pages in page order and turns them into the final list. The
 * merge happens before ordering so a reversed directory is detected once, over the
 * whole book, rather than per page.
 */
export function finalizeChapterList(
  pages: ChapterPageExtraction[],
  options: FinalizeOptions = {},
): ChapterListResult {
  const warnings = uniqueStrings([...pages.flatMap((page) => page.warnings), ...(options.warnings ?? [])])
  const debugMessages = [...pages.flatMap((page) => page.debugMessages), ...(options.debugMessages ?? [])]

  const merged = dedupe(pages.flatMap((page) => page.members))
  if (merged.length < MIN_CHAPTERS) throw noChapterList()

  const ordered = orderChapters(merged)
  if (ordered.reversed) {
    debugMessages.push('目錄為倒序，已自動反轉為由舊到新')
  }

  const ordinalRatio = ratioWithOrdinal(ordered.members)
  const coverage = Math.min(...pages.map((page) => page.coverage))
  const confidence = capConfidence(pickConfidence(ordinalRatio, coverage), options.confidenceCeiling)
  warnings.unshift(`通用解析（信心：${confidenceLabel(confidence)}）：請確認章節數與首尾章名`)
  debugMessages.push(
    `信心判定：章節序號比例 ${(ordinalRatio * 100).toFixed(0)}%，容器內章節佔比 ${(coverage * 100).toFixed(0)}%`,
  )

  const firstOrdinal = ordered.members[0].ordinal
  if (firstOrdinal !== null && firstOrdinal > 1) {
    warnings.push('目錄可能不完整：首章序號 > 1')
  }

  return {
    chapters: ordered.members.map((candidate, index) => ({
      index,
      title: candidate.title,
      url: candidate.normalized,
    })),
    warnings,
    debugMessages,
    confidence,
  }
}

/** Chapter URLs of one page, in the form the pagination scan needs to exclude them. */
export function chapterUrlsOf(page: ChapterPageExtraction): string[] {
  return page.members.map((member) => member.normalized)
}

function pickBestCluster(clusters: Map<string, Candidate[]>): { key: string; members: Candidate[]; score: number } | null {
  let best: { key: string; members: Candidate[]; score: number } | null = null
  for (const [key, members] of clusters) {
    const score = scoreCluster(members)
    if (best && score <= best.score) continue
    best = { key, members, score }
  }
  return best
}

const CONFIDENCE_ORDER: Confidence[] = ['low', 'medium', 'high']

function capConfidence(confidence: Confidence, ceiling?: Confidence): Confidence {
  if (!ceiling) return confidence
  return CONFIDENCE_ORDER.indexOf(confidence) <= CONFIDENCE_ORDER.indexOf(ceiling) ? confidence : ceiling
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function noChapterList(): WebSourceParseError {
  return new WebSourceParseError(
    '找不到章節列表（通用解析）：此頁可能以 JavaScript 載入目錄，或需要專屬的站點解析器',
  )
}

function collectCandidates(document: AnalyzedDocument, baseUrl: string, host: string): Candidate[] {
  const candidates: Candidate[] = []
  for (const anchor of document.anchors) {
    const url = resolveHref(anchor.href, baseUrl)
    if (!url || !isSameSite(url.hostname, host)) continue
    const title = rangeText(document.tokens, anchor.start + 1, anchor.end)
    // A title this long means the anchor never really closed and swallowed
    // neighbouring markup; it is not a chapter link.
    if (!title || title.length > MAX_TITLE_LENGTH) continue
    const ordinal = chapterOrdinalOf(title)
    candidates.push({
      url,
      normalized: normalizeUrl(url),
      title,
      anchor,
      ordinal,
      sequence: ordinal ?? looseSequenceOf(title),
      hasDigits: /\d/.test(title),
    })
  }
  return candidates
}

/**
 * Pagination-only links: `<select>` page pickers and image-only/text-less "next
 * page" anchors. Neither can ever be a chapter candidate — a `<option>` is not an
 * anchor, and a text-less anchor already failed `collectCandidates`'s title check
 * — so they are collected separately and only feed `findDirectoryPageLinks`.
 */
function collectPaginationOnlyLinks(document: AnalyzedDocument, baseUrl: string, host: string): ResolvedLink[] {
  const links: ResolvedLink[] = []

  for (const anchor of document.anchors) {
    const title = rangeText(document.tokens, anchor.start + 1, anchor.end)
    if (title) continue
    const url = resolveHref(anchor.href, baseUrl)
    if (!url || !isSameSite(url.hostname, host)) continue
    const isPageShaped = directoryPageSignature(url).page !== null
    if (!isPageShaped && !isPaginationMarkerAnchor(document.tokens, anchor)) continue
    links.push({ url, normalized: normalizeUrl(url) })
  }

  for (let index = 0; index < document.tokens.length; index += 1) {
    const token = document.tokens[index]
    if (token.kind !== 'open' || token.name !== 'option') continue
    const value = getAttribute(token.attrs, 'value')
    if (!value) continue
    const url = resolveHref(value, baseUrl)
    if (!url || !isSameSite(url.hostname, host)) continue
    links.push({ url, normalized: normalizeUrl(url) })
  }

  return links
}

/** True when a text-less anchor still announces itself as a "next page" control. */
function isPaginationMarkerAnchor(tokens: Token[], anchor: Anchor): boolean {
  const openToken = tokens[anchor.start]
  if (openToken.kind !== 'open') return false
  const rel = getAttribute(openToken.attrs, 'rel')
  if (rel && /(?:^|\s)next(?:\s|$)/i.test(rel)) return true
  const markers = [
    getAttribute(openToken.attrs, 'class'),
    getAttribute(openToken.attrs, 'id'),
    getAttribute(openToken.attrs, 'title'),
    getAttribute(openToken.attrs, 'aria-label'),
  ]
  if (markers.some((value) => value && NEXT_PAGE_PATTERN.test(value))) return true
  for (let index = anchor.start + 1; index < anchor.end; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'open' || token.name !== 'img') continue
    const alt = getAttribute(token.attrs, 'alt')
    if (alt && NEXT_PAGE_PATTERN.test(alt)) return true
  }
  return false
}

function scoreCluster(members: Candidate[]): number {
  let ordinals = 0
  let withDigits = 0
  for (const member of members) {
    if (member.ordinal !== null) ordinals += 1
    if (member.hasDigits) withDigits += 1
  }
  return members.length + 2 * ordinals + withDigits
}

/**
 * Picks the *deepest* element that still holds nearly the whole cluster. The
 * outermost element always holds the most members, so "most members" would
 * always answer `<body>` and let the sidebar's "最新章節" links back in.
 */
function scopeToContainer(document: AnalyzedDocument, members: Candidate[]): {
  containerId: number
  members: Candidate[]
  containerAnchorCount: number
  coverage: number
} {
  // Members land on their immediate parent, then roll up the block tree. A block
  // is always pushed after its parent, so one descending sweep gives every block
  // its whole subtree's count without walking any anchor's ancestry.
  const subtree = new Int32Array(document.blocks.length)
  for (const member of members) {
    if (member.anchor.parent >= 0) subtree[member.anchor.parent] += 1
  }
  for (let blockId = document.blocks.length - 1; blockId >= 0; blockId -= 1) {
    const parent = document.blocks[blockId].parent
    if (parent >= 0) subtree[parent] += subtree[blockId]
  }

  const required = members.length * CONTAINER_COVERAGE
  let bestId = -1
  let bestDepth = -1
  for (let blockId = 0; blockId < document.blocks.length; blockId += 1) {
    const block = document.blocks[blockId]
    if (subtree[blockId] < required) continue
    if (!CONTAINER_ELEMENTS.has(block.name)) continue
    if (block.depth > bestDepth) {
      bestDepth = block.depth
      bestId = blockId
    }
  }

  if (bestId < 0) {
    return { containerId: -1, members, containerAnchorCount: members.length, coverage: 1 }
  }

  // Same ascending order argument: a block's parent is already marked when it is
  // reached, so membership of the winner's subtree costs one pass, not a walk per anchor.
  const inContainer = new Uint8Array(document.blocks.length)
  inContainer[bestId] = 1
  for (let blockId = bestId + 1; blockId < document.blocks.length; blockId += 1) {
    const parent = document.blocks[blockId].parent
    if (parent >= 0 && inContainer[parent] === 1) inContainer[blockId] = 1
  }
  const scopedMembers = members.filter(
    (member) => member.anchor.parent >= 0 && inContainer[member.anchor.parent] === 1,
  )
  const container = document.blocks[bestId]
  let containerAnchorCount = 0
  for (const anchor of document.anchors) {
    if (anchor.start > container.start && anchor.start < container.end) containerAnchorCount += 1
  }
  return {
    containerId: bestId,
    members: scopedMembers,
    containerAnchorCount,
    coverage: containerAnchorCount > 0 ? scopedMembers.length / containerAnchorCount : 1,
  }
}

/**
 * Recommendation blocks reuse the chapter URL shape for *other* books, so a
 * shape cluster alone can mix two books together.
 */
function applySameBookGuard(members: Candidate[], listUrl: URL): {
  members: Candidate[]
  dropped: number
  skipped: boolean
  bookId: string | null
} {
  const bookId = bookIdSegment(listUrl)
  if (!bookId) return { members, dropped: 0, skipped: false, bookId: null }

  const kept = members.filter((member) => member.url.pathname.includes(bookId))
  if (kept.length < members.length * 0.5) {
    // The id guess was wrong (or chapters live under a different id space);
    // keeping every link beats returning half a book.
    return { members, dropped: 0, skipped: true, bookId }
  }
  return { members: kept, dropped: members.length - kept.length, skipped: false, bookId }
}

function dedupe(members: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  const result: Candidate[] = []
  for (const member of members) {
    if (seen.has(member.normalized)) continue
    seen.add(member.normalized)
    result.push(member)
  }
  return result
}

function orderChapters(members: Candidate[]): { members: Candidate[]; reversed: boolean } {
  const sequence = members.map((member) => member.sequence)
  let ascending = 0
  let descending = 0
  let previous: number | null = null
  for (const value of sequence) {
    if (value === null) continue
    if (previous !== null) {
      if (value > previous) ascending += 1
      else if (value < previous) descending += 1
    }
    previous = value
  }
  if (descending > ascending && descending > 0) {
    return { members: [...members].reverse(), reversed: true }
  }
  return { members, reversed: false }
}

function ratioWithOrdinal(members: Candidate[]): number {
  if (members.length === 0) return 0
  const count = members.filter((member) => member.ordinal !== null).length
  return count / members.length
}

function pickConfidence(ordinalRatio: number, coverage: number): Confidence {
  if (ordinalRatio >= 0.6 && coverage >= 0.8) return 'high'
  if (ordinalRatio >= 0.3) return 'medium'
  return 'low'
}

function confidenceLabel(confidence: Confidence): string {
  if (confidence === 'high') return '高'
  return confidence === 'medium' ? '中' : '低'
}

export function chapterOrdinalOf(title: string): number | null {
  const parsed = parseChapterOrdinal(title)
  if (parsed !== null) return parsed
  const match = title.match(ORDINAL_PATTERN)
  return match ? parseChapterOrdinal(match[0].replace(/\s+/g, '')) : null
}

/** Ordering only: understands 第N頁 lists and bare leading numbers, which are not chapter ordinals. */
function looseSequenceOf(title: string): number | null {
  const page = title.match(PAGE_ORDINAL_PATTERN)
  if (page) {
    const asNumber = parseChapterOrdinal(`第${page[1]}章`)
    if (asNumber !== null) return asNumber
  }
  const digits = title.match(/\d+/)
  return digits ? Number.parseInt(digits[0], 10) : null
}

export function extractBookTitle(document: AnalyzedDocument): string {
  const heading = findElementText(document, 'h1')
  if (heading) return stripBookTitle(heading)
  const ogTitle = findMetaContent(document, 'og:title')
  if (ogTitle) return stripBookTitle(ogTitle)
  const title = findElementText(document, 'title')
  if (title) return stripBookTitle(title)
  return '線上書源'
}

function findElementText(document: AnalyzedDocument, name: string): string | null {
  const { tokens } = document
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'open' || token.name !== name) continue
    for (let end = index + 1; end < tokens.length; end += 1) {
      const candidate = tokens[end]
      if (candidate.kind === 'close' && candidate.name === name) {
        const text = rangeText(tokens, index + 1, end)
        if (text) return text
        break
      }
    }
  }
  return null
}

function findMetaContent(document: AnalyzedDocument, property: string): string | null {
  for (const token of document.tokens) {
    if (token.kind !== 'open' || token.name !== 'meta') continue
    const key = getAttribute(token.attrs, 'property') ?? getAttribute(token.attrs, 'name')
    if (key?.toLowerCase() !== property) continue
    const content = getAttribute(token.attrs, 'content')
    if (content) return content.trim()
  }
  return null
}

function stripBookTitle(raw: string): string {
  return raw
    .replace(/最新章[節节].*$/u, '')
    .replace(/章[節节][列目].*$/u, '')
    .replace(/目[錄录].*$/u, '')
    .replace(/[_\-｜|].*$/u, '')
    .replace(/[《》]/gu, '')
    .trim() || '線上書源'
}
