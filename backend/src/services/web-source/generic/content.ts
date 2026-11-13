import { analyzeDocument, anchorTextCharsIn, textCharsIn, type AnalyzedDocument } from './document.js'
import type { Token } from './tokenizer.js'
import { cleanParagraphs, extractParagraphs, rangeText } from './text.js'
import { isContinuationPart, resolveBaseUrl, resolveHref } from './urls.js'

const CONTENT_ELEMENTS = new Set(['div', 'section', 'article', 'td', 'main'])
const MIN_CONTENT_CHARS = 200
/** Above this share of link text the block is a navigation list, not prose. */
const MAX_LINK_RATIO = 0.4
/** A child this close to its parent's score is the tighter, cleaner boundary. */
const CHILD_PREFERENCE = 0.9

/** Shared with the directory-pagination heuristics: what a "next page" control says, in any of these spellings. */
export const NEXT_PAGE_PATTERN = /下一[頁页]|下[頁页]|next/i
const NEXT_CHAPTER_PATTERN = /下一[章节節]/

export type ChapterContent = {
  paragraphs: string[]
  strategy: 'block' | 'br-run'
  debug: string
}

export function extractChapterContent(tokens: Token[]): ChapterContent | null {
  const document = analyzeDocument(tokens)
  const heading = findHeading(document)

  const block = pickContentBlock(document)
  if (block) {
    const paragraphs = cleanParagraphs(
      extractParagraphs(tokens, block.start + 1, block.end),
      heading,
    )
    if (paragraphs.length > 0) {
      return {
        paragraphs,
        strategy: 'block',
        debug: `內文區塊：<${document.blocks[block.id].name}> 文字 ${block.textChars} 字，連結佔比 ${(block.linkRatio * 100).toFixed(0)}%`,
      }
    }
  }

  const run = pickLongestBrRun(document)
  if (run) {
    const paragraphs = cleanParagraphs(extractParagraphs(tokens, run.start, run.end), heading)
    if (paragraphs.length > 0) {
      return {
        paragraphs,
        strategy: 'br-run',
        debug: `內文區塊：無容器，改用 <br> 分隔文字段（${run.textChars} 字）`,
      }
    }
  }

  return null
}

type ScoredBlock = { id: number; start: number; end: number; score: number; textChars: number; linkRatio: number }

function pickContentBlock(document: AnalyzedDocument): ScoredBlock | null {
  const scored = new Map<number, ScoredBlock>()
  let best: ScoredBlock | null = null

  for (const block of document.blocks) {
    if (!CONTENT_ELEMENTS.has(block.name)) continue
    const total = textCharsIn(document, block.start, block.end)
    if (total < MIN_CONTENT_CHARS) continue
    const linkChars = anchorTextCharsIn(document, block.start, block.end)
    const linkRatio = total > 0 ? linkChars / total : 1
    if (linkRatio >= MAX_LINK_RATIO) continue
    const textChars = total - linkChars
    const entry: ScoredBlock = {
      id: block.id,
      start: block.start,
      end: block.end,
      score: textChars * (1 - linkRatio),
      textChars,
      linkRatio,
    }
    scored.set(block.id, entry)
    if (!best || entry.score > best.score) best = entry
  }

  if (!best) return null

  // Walk down into the tightest descendant that keeps essentially the same
  // prose, so wrapper divs full of surrounding chrome are shed.
  let current = best
  for (;;) {
    let tighter: ScoredBlock | null = null
    for (const candidate of scored.values()) {
      if (candidate.id === current.id) continue
      if (candidate.start <= current.start || candidate.end > current.end) continue
      if (candidate.score < current.score * CHILD_PREFERENCE) continue
      if (!tighter || document.blocks[candidate.id].depth > document.blocks[tighter.id].depth) {
        tighter = candidate
      }
    }
    if (!tighter) return current
    current = tighter
  }
}

const RUN_BOUNDARY_ELEMENTS = new Set([
  'div', 'p', 'ul', 'ol', 'dl', 'li', 'dd', 'table', 'tbody', 'tr', 'td', 'section',
  'article', 'main', 'aside', 'nav', 'header', 'footer', 'form', 'center', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
])
const RUN_EXCLUDED_ELEMENTS = new Set(['table', 'form', 'select', 'nav', 'head'])

/**
 * Some sites put the chapter body straight into `<body>` between `<br>` tags,
 * with no element to select at all; the longest such run is the prose.
 */
function pickLongestBrRun(document: AnalyzedDocument): { start: number; end: number; textChars: number } | null {
  const { tokens } = document
  let best: { start: number; end: number; textChars: number } | null = null
  let runStart = 0
  let runBreaks = 0
  let excludedDepth = 0

  const finish = (end: number): void => {
    if (runBreaks >= 2) {
      const textChars = textCharsIn(document, runStart, end) - anchorTextCharsIn(document, runStart, end)
      if (textChars >= MIN_CONTENT_CHARS && (!best || textChars > best.textChars)) {
        best = { start: runStart, end, textChars }
      }
    }
    runStart = end
    runBreaks = 0
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind === 'text') continue
    if (token.name === 'br') {
      runBreaks += 1
      continue
    }
    if (RUN_EXCLUDED_ELEMENTS.has(token.name)) {
      finish(index)
      excludedDepth += token.kind === 'open' ? 1 : -1
      if (excludedDepth < 0) excludedDepth = 0
      runStart = index + 1
      continue
    }
    if (excludedDepth > 0) {
      runStart = index + 1
      continue
    }
    if (RUN_BOUNDARY_ELEMENTS.has(token.name)) finish(index)
  }
  finish(tokens.length)
  return best
}

function findHeading(document: AnalyzedDocument): string | null {
  const { tokens } = document
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'open' || !/^h[1-3]$/.test(token.name)) continue
    for (let end = index + 1; end < tokens.length; end += 1) {
      const candidate = tokens[end]
      if (candidate.kind === 'close' && candidate.name === token.name) {
        const text = rangeText(tokens, index + 1, end)
        if (text) return text
        break
      }
    }
  }
  return null
}

/**
 * The "next page" link of a split chapter. A "下一章" link points at the next
 * chapter and must never be followed, or every chapter would swallow the book.
 */
export function findNextPartUrl(tokens: Token[], pageUrl: string, originalUrl: string): string | null {
  const document = analyzeDocument(tokens)
  const original = new URL(originalUrl)
  const baseUrl = resolveBaseUrl(document.baseHref, pageUrl)
  for (const anchor of document.anchors) {
    const label = rangeText(tokens, anchor.start + 1, anchor.end)
    if (!label || NEXT_CHAPTER_PATTERN.test(label) || !NEXT_PAGE_PATTERN.test(label)) continue
    const url = resolveHref(anchor.href, baseUrl)
    if (!url || !isContinuationPart(original, url)) continue
    return url.toString()
  }
  return null
}
