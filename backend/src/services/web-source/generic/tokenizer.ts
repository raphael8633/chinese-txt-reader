import { WebSourceParseError } from '../types.js'

/**
 * A generic provider cannot rely on site-specific selectors, so every heuristic
 * downstream reads the same flat token array produced by one linear scan.
 * Re-scanning the raw HTML with a regex per heuristic is what turns an
 * adversarial 4 MB page into a multi-second parse.
 */
export type Token =
  | { kind: 'open'; name: string; attrs: string }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string }

export const MAX_TOKENS = 400_000

/** Elements whose content is never markup — skipped whole, so a `</div>` inside a script cannot fake a container boundary. */
const SKIPPED_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe'])

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const TAG_START = /<(\/?)([a-zA-Z][a-zA-Z0-9:_.-]*)/y

export function tokenize(html: string, maxTokens: number = MAX_TOKENS): Token[] {
  const tokens: Token[] = []
  const length = html.length
  let textStart = 0
  let cursor = 0

  const push = (token: Token): void => {
    if (tokens.length >= maxTokens) {
      throw new WebSourceParseError('頁面結構過於龐大，通用解析無法處理')
    }
    tokens.push(token)
  }

  const flushText = (end: number): void => {
    if (end > textStart && hasNonWhitespace(html, textStart, end)) {
      push({ kind: 'text', text: html.slice(textStart, end) })
    }
  }

  while (cursor < length) {
    const lt = html.indexOf('<', cursor)
    if (lt < 0) break

    if (html.startsWith('<!--', lt)) {
      flushText(lt)
      const end = html.indexOf('-->', lt + 4)
      cursor = end < 0 ? length : end + 3
      textStart = cursor
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      flushText(lt)
      const end = html.indexOf('>', lt + 2)
      cursor = end < 0 ? length : end + 1
      textStart = cursor
      continue
    }

    TAG_START.lastIndex = lt
    const tagMatch = TAG_START.exec(html)
    if (!tagMatch) {
      // A bare '<' in prose is text, not a tag.
      cursor = lt + 1
      continue
    }

    const tagEnd = findTagEnd(html, TAG_START.lastIndex)
    const isClose = tagMatch[1] === '/'
    const name = tagMatch[2].toLowerCase()
    const attrs = html.slice(TAG_START.lastIndex, tagEnd)
    flushText(lt)
    cursor = tagEnd + 1
    textStart = cursor

    if (SKIPPED_ELEMENTS.has(name)) {
      if (!isClose && !attrs.trimEnd().endsWith('/')) {
        cursor = skipElement(html, name, cursor)
        textStart = cursor
      }
      continue
    }

    if (isClose) {
      push({ kind: 'close', name })
      continue
    }

    push({ kind: 'open', name, attrs })
    // Void and XHTML self-closed elements get a matching close so consumers
    // can treat every open token as balanced.
    if (VOID_ELEMENTS.has(name) || attrs.trimEnd().endsWith('/')) {
      push({ kind: 'close', name })
    }
  }

  flushText(length)
  return tokens
}

/** Scans to the tag's `>`, ignoring one inside a quoted attribute value. */
function findTagEnd(html: string, start: number): number {
  let quote = ''
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index
  }
  return html.length
}

function skipElement(html: string, name: string, start: number): number {
  const closePattern = new RegExp(`</${name}[\\s>]`, 'gi')
  closePattern.lastIndex = start
  const match = closePattern.exec(html)
  if (!match) return html.length
  const end = html.indexOf('>', match.index)
  return end < 0 ? html.length : end + 1
}

function hasNonWhitespace(html: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const code = html.charCodeAt(index)
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) return true
  }
  return false
}

const ATTR_PATTERN = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

/** Reads one attribute out of a token's raw attribute text (exact name match, so `data-href` never answers for `href`). */
export function getAttribute(attrs: string, name: string): string | null {
  if (!attrs) return null
  ATTR_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTR_PATTERN.exec(attrs)) !== null) {
    if (match[1].toLowerCase() !== name) continue
    return match[2] ?? match[3] ?? match[4] ?? ''
  }
  return null
}
