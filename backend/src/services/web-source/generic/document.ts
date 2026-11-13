import { getAttribute, type Token } from './tokenizer.js'

/** Elements that can plausibly wrap a chapter list or a chapter body. */
const TRACKED_ELEMENTS = new Set([
  'div', 'ul', 'ol', 'dl', 'table', 'tbody', 'section', 'nav', 'article', 'main',
  'td', 'li', 'dd', 'aside', 'center', 'form', 'body', 'p', 'blockquote',
])

export type Block = {
  id: number
  name: string
  /** Index of the open token. */
  start: number
  /** Index of the close token (exclusive end of the element's children). */
  end: number
  parent: number
  depth: number
  attrs: string
}

/**
 * Nesting beyond this is treated as siblings of the deepest kept block. Depth is
 * the cheap dimension of a hostile page — one token per `<div>` — so without a cap
 * a small page can make any per-anchor ancestry work quadratic.
 */
export const MAX_BLOCK_DEPTH = 200
/** Anchors past this are not recorded; the caller warns that the list may be short. */
export const MAX_ANCHORS = 60_000

export type Anchor = {
  href: string
  /** Index of the `<a>` open token. */
  start: number
  end: number
  /**
   * Innermost enclosing tracked block, or -1. Ancestry is walked through
   * `Block.parent` on demand instead of being copied into every anchor.
   */
  parent: number
}

export type AnalyzedDocument = {
  tokens: Token[]
  blocks: Block[]
  anchors: Anchor[]
  /** Non-whitespace text characters before token i. */
  textPrefix: Int32Array
  /** Of those, the ones inside an `<a>`. */
  anchorTextPrefix: Int32Array
  baseHref: string | null
  /** True when the page held more than MAX_ANCHORS links and the rest were dropped. */
  anchorsTruncated: boolean
}

/**
 * One pass over the token array yields everything the heuristics need:
 * element ranges, anchor positions with their ancestry, and prefix sums that
 * make "how much text does this element hold" an O(1) question.
 */
export function analyzeDocument(tokens: Token[]): AnalyzedDocument {
  const blocks: Block[] = []
  const anchors: Anchor[] = []
  const textPrefix = new Int32Array(tokens.length + 1)
  const anchorTextPrefix = new Int32Array(tokens.length + 1)
  const stack: number[] = []
  const openAnchors: Anchor[] = []
  let baseHref: string | null = null
  /** Tracked elements opened past the depth cap, so their closes unwind nothing. */
  let suppressedDepth = 0
  /** Tracks link text even for anchors the cap stopped recording. */
  let anchorOpen = false
  let anchorsTruncated = false

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    textPrefix[index + 1] = textPrefix[index]
    anchorTextPrefix[index + 1] = anchorTextPrefix[index]

    if (token.kind === 'text') {
      const chars = countTextChars(token.text)
      textPrefix[index + 1] += chars
      if (anchorOpen) anchorTextPrefix[index + 1] += chars
      continue
    }

    if (token.kind === 'open') {
      if (token.name === 'base' && baseHref === null) {
        baseHref = getAttribute(token.attrs, 'href')
      }
      if (token.name === 'a') {
        // Old markup leaves anchors unclosed; a browser ends the previous one
        // here, and without that its title would swallow the rest of the page
        // and mark every later block as pure navigation.
        while (openAnchors.length > 0) {
          const stale = openAnchors.pop()
          if (stale) stale.end = index
        }
        anchorOpen = false
        const href = getAttribute(token.attrs, 'href')
        if (href !== null) {
          anchorOpen = true
          if (anchors.length < MAX_ANCHORS) {
            const anchor: Anchor = {
              href,
              start: index,
              end: tokens.length,
              parent: stack.length > 0 ? stack[stack.length - 1] : -1,
            }
            anchors.push(anchor)
            openAnchors.push(anchor)
          } else {
            anchorsTruncated = true
          }
        }
        continue
      }
      if (!TRACKED_ELEMENTS.has(token.name)) continue
      if (stack.length >= MAX_BLOCK_DEPTH) {
        suppressedDepth += 1
        continue
      }
      const parent = stack.length > 0 ? stack[stack.length - 1] : -1
      blocks.push({
        id: blocks.length,
        name: token.name,
        start: index,
        end: tokens.length,
        parent,
        depth: stack.length,
        attrs: token.attrs,
      })
      stack.push(blocks.length - 1)
      continue
    }

    if (token.name === 'a') {
      const anchor = openAnchors.pop()
      if (anchor) anchor.end = index
      anchorOpen = false
      continue
    }
    if (!TRACKED_ELEMENTS.has(token.name)) continue
    // Balances the opens the depth cap skipped, so they cannot unwind real blocks.
    if (suppressedDepth > 0) {
      suppressedDepth -= 1
      continue
    }
    // Real pages leave elements unclosed; closing everything down to the
    // matching open keeps nesting sane instead of dropping the close entirely.
    for (let position = stack.length - 1; position >= 0; position -= 1) {
      if (blocks[stack[position]].name !== token.name) continue
      const closedFrom = blocks[stack[position]].start
      for (let unwind = stack.length - 1; unwind >= position; unwind -= 1) {
        blocks[stack[unwind]].end = index
      }
      stack.length = position
      // An anchor left open inside the element ends with it, as in a browser.
      while (openAnchors.length > 0 && openAnchors[openAnchors.length - 1].start > closedFrom) {
        const stale = openAnchors.pop()
        if (stale) stale.end = index
      }
      if (openAnchors.length === 0) anchorOpen = false
      break
    }
  }

  return { tokens, blocks, anchors, textPrefix, anchorTextPrefix, baseHref, anchorsTruncated }
}

export function textCharsIn(document: AnalyzedDocument, start: number, end: number): number {
  return document.textPrefix[end] - document.textPrefix[start]
}

export function anchorTextCharsIn(document: AnalyzedDocument, start: number, end: number): number {
  return document.anchorTextPrefix[end] - document.anchorTextPrefix[start]
}

function countTextChars(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) count += 1
  }
  return count
}
