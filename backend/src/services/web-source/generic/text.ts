import { decodeHtmlEntities } from '../htmlUtils.js'
import type { Token } from './tokenizer.js'

/**
 * Anything that ends a line of prose. Splitting on these uniformly covers both
 * `<p>text</p>` pages and `text<br>text` pages, and also the sites that emit
 * bare `<p/>` separators between naked text runs.
 */
const PARAGRAPH_BOUNDARIES = new Set([
  'p', 'br', 'div', 'li', 'dd', 'dt', 'dl', 'ul', 'ol', 'tr', 'td', 'th', 'table',
  'section', 'article', 'main', 'aside', 'nav', 'header', 'footer', 'blockquote',
  'pre', 'hr', 'center', 'form', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
])

/** Promo lines these sites inject into the prose itself, where no markup marks them out. */
const PROMO_LINE_PATTERN = /請記住本站|请记住本站|收藏本站|手機版閱讀|手机版阅读|最新章節請|最新章节请|本站域名|一秒記住|一秒记住|加入書籤|加入书签|推薦票|月票|\(本章完\)|（本章完）/

const NAVIGATION_LINE_PATTERN = /^[\s|｜/·、]*(上一[章頁页节節]|下一[章頁页节節]|返回目[錄录]|回目[錄录]|目[錄录]|加入書[籤签]|投推薦票|章[節节][錯错][誤误])[\s|｜/·、]*$/

const INDENT_CHARACTERS = /^[\s 　   ﻿]+/
const TRAILING_SPACE = /[\s 　   ﻿]+$/

export function extractParagraphs(tokens: Token[], start: number, end: number): string[] {
  const paragraphs: string[] = []
  let buffer = ''

  const flush = (): void => {
    const line = normalizeLine(buffer)
    buffer = ''
    if (line) paragraphs.push(line)
  }

  for (let index = start; index < end; index += 1) {
    const token = tokens[index]
    if (token.kind === 'text') {
      buffer += token.text
      continue
    }
    if (PARAGRAPH_BOUNDARIES.has(token.name)) flush()
  }
  flush()
  return paragraphs
}

/** Entity decoding is regex work; a page of 50k anchor labels rarely needs it. */
function decodeIfNeeded(raw: string): string {
  return raw.includes('&') ? decodeHtmlEntities(raw) : raw
}

export function normalizeLine(raw: string): string {
  return decodeIfNeeded(raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(INDENT_CHARACTERS, '')
    .replace(TRAILING_SPACE, '')
    .replace(/ {2,}/g, ' ')
}

export function cleanParagraphs(paragraphs: string[], chapterTitle?: string | null): string[] {
  const title = chapterTitle ? normalizeLine(chapterTitle) : null
  return paragraphs.filter((paragraph) => {
    if (!paragraph) return false
    if (PROMO_LINE_PATTERN.test(paragraph)) return false
    if (NAVIGATION_LINE_PATTERN.test(paragraph)) return false
    if (title && paragraph === title) return false
    return true
  })
}

/** Plain text of a token range, used for anchor labels and headings. */
export function rangeText(tokens: Token[], start: number, end: number): string {
  let buffer = ''
  for (let index = start; index < end; index += 1) {
    const token = tokens[index]
    if (token.kind === 'text') buffer += token.text
    else if (PARAGRAPH_BOUNDARIES.has(token.name)) buffer += ' '
  }
  return decodeIfNeeded(buffer).replace(/\s+/g, ' ').trim()
}
