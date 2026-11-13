import OpenCCCn2T from 'opencc-js/cn2t'
import OpenCCT2Cn from 'opencc-js/t2cn'
import type { MouseEvent } from 'react'
import type { Chapter, ReaderSettings } from '../api.js'

// ── Constants ────────────────────────────────────────────────────────────────

export const chapterPattern = /^(第[一二三四五六七八九十百千萬万零〇兩两\d]+[章回節卷部篇]|Chapter\s+\d+)/i
export const chapterTitlePattern = /^(第[一二三四五六七八九十百千萬万零〇兩两\d]+[章回節卷部篇]|Chapter\s+\d+)\s*(.*)$/i
export const dialoguePattern = /^[「『"']/
const indentPattern = /^(?:　| {2})/
const chineseChapterMarkerPattern = /^第([一二三四五六七八九十百千萬万零〇兩两\d]+)[章回節卷部篇]\s*/

const chineseDigits: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
}

const chineseUnits: Record<string, number> = {
  十: 10, 百: 100, 千: 1000, 萬: 10000, 万: 10000,
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSizePx: 18, lineHeight: 1.8, letterSpacingPx: 0,
  textColor: '#333333', backgroundColor: '#f5f0e8', readingMode: 'scroll',
  tapScrollPercent: 90, tapScrollMode: 'allDown', toolbarSide: 'right', hardWrapMode: 'auto',
  chineseConversion: 'none',
  contentFilters: [],
  paddingTop: 9, paddingBottom: 8,
  annotationMarginTop: 20, annotationMarginBottom: 0,
  marginLeft: 16, marginRight: 16,
  paragraphSpacing: 7, paragraphIndent: 1,
  fontWeight: 400, justifyText: true,
}

// ── Paragraph / chapter parsing ──────────────────────────────────────────────

// Strips at most 2 leading whitespace chars (ASCII space, fullwidth space 　, NBSP) per paragraph.
// This eliminates Chinese-novel source indentation that would double-stack with CSS textIndent.
// Mirrors the .trim() applied in mergeHardWrappedParagraphs and the backend splitParagraphs.
export function preserveParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .filter(p => p.trim().length > 0)
    .map(p => p.replace(/^[ 　 ]{1,2}/, ''))
}

export function mergeHardWrappedParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .flatMap(block => {
      const paragraphs: string[] = []
      let pending = ''

      for (const raw of block.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        if (chapterPattern.test(line) || dialoguePattern.test(line)) {
          if (pending) paragraphs.push(pending)
          paragraphs.push(line)
          pending = ''
          continue
        }
        // An indented line opens a new paragraph in hard-wrapped TXT.
        if (indentPattern.test(raw)) {
          if (pending) paragraphs.push(pending)
          pending = line
          continue
        }
        pending = pending ? `${pending}${line}` : line
      }

      if (pending) paragraphs.push(pending)
      return paragraphs
    })
}

/** true merges, false preserves, 'detect' merges only text that {@link looksHardWrapped}. */
export type HardWrapHandling = boolean | 'detect'

const LINE_END_PUNCTUATION = /[。！？…：；」』”’"'）)!?~～—]$/
const HARD_WRAP_SAMPLE_LINES = 400

/**
 * Hard-wrapped text breaks paragraphs mid-sentence at a fixed width, so only a
 * paragraph's last line ends with sentence-final punctuation; a
 * one-paragraph-per-line TXT ends nearly every line with it (87–98% in real books).
 */
export function looksHardWrapped(text: string): boolean {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    // Headings and dialogue lines stay standalone either way, so they say nothing about wrapping.
    if (line && !chapterPattern.test(line) && !dialoguePattern.test(line)) lines.push(line)
    if (lines.length >= HARD_WRAP_SAMPLE_LINES) break
  }
  if (lines.length === 0) return false
  const ended = lines.filter(line => LINE_END_PUNCTUATION.test(line)).length
  return ended / lines.length < 0.7
}

export function splitParagraphs(text: string, mergeHardWrap: HardWrapHandling): string[] {
  const merge = mergeHardWrap === 'detect' ? looksHardWrapped(text) : mergeHardWrap
  return merge ? mergeHardWrappedParagraphs(text) : preserveParagraphs(text)
}

export function stripMatchingChapterHeading(metadataTitle: string, text: string): string {
  const metadataMarker = metadataTitle.trim().match(chineseChapterMarkerPattern)
  const textMarker = text.match(chineseChapterMarkerPattern)
  if (!metadataMarker || !textMarker) return text
  const metadataOrdinal = parseChineseChapterOrdinal(metadataMarker[1])
  const textOrdinal = parseChineseChapterOrdinal(textMarker[1])
  const metadataName = metadataTitle.trim().slice(metadataMarker[0].length).trim()
  const textName = text.slice(textMarker[0].length).split(/\r?\n/, 1)[0].trim()
  const ordinalMatches = metadataOrdinal !== null && textOrdinal === metadataOrdinal
  const nameMatches = metadataOrdinal !== null
    && textOrdinal !== null
    && metadataName.length > 0
    && textName === metadataName
  if (!ordinalMatches && !nameMatches) return text

  let bodyStart = textMarker[0].length
  if (metadataName && text.slice(bodyStart).startsWith(metadataName)) {
    bodyStart += metadataName.length
  }
  return text.slice(bodyStart).replace(/^\s+/, '')
}

function parseChineseChapterOrdinal(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const ordinal = Number.parseInt(token, 10)
    return Number.isSafeInteger(ordinal) ? ordinal : null
  }

  if (![...token].some(character => character in chineseUnits)) {
    const digits = [...token].map(character => chineseDigits[character])
    if (digits.some(digit => digit === undefined)) return null
    return Number.parseInt(digits.join(''), 10)
  }

  let total = 0
  let section = 0
  let digit = 0
  for (const character of token) {
    if (character in chineseDigits) {
      digit = chineseDigits[character]
      continue
    }
    const unit = chineseUnits[character]
    if (!unit) return null
    if (unit === 10000) {
      section += digit
      total += (section || 1) * unit
      section = 0
    } else {
      section += (digit || 1) * unit
    }
    digit = 0
  }
  return total + section + digit
}

export function formatChapterTitle(text: string): string {
  const match = text.trim().match(chapterTitlePattern)
  if (!match) return text
  const name = match[2]?.trim()
  return name ? `${match[1]} ${name}` : match[1]
}

export function formatParagraphForDisplay(text: string): string {
  return chapterPattern.test(text.trim()) ? formatChapterTitle(text) : text
}

export interface ParagraphLayout {
  contentWidthPx: number
  fontSizePx: number
  letterSpacingPx: number
  lineHeight: number
  paddingTopPx: number
  paddingBottomPx: number
  paragraphSpacingPx: number
  indentEm: number
}

// Virtual row height before the row is measured. Rows above the viewport that
// measure differently make the virtualizer rewrite scrollTop, which shakes the
// text while scrolling back, so the estimate follows the wrapped line count:
// CJK glyphs are 1em wide, Latin about half; a glyph that does not fit wraps whole.
export function estimateParagraphHeight(text: string, layout: ParagraphLayout): number {
  const { fontSizePx, letterSpacingPx } = layout
  const lineWidth = Math.max(layout.contentWidthPx, fontSizePx) + 0.01
  let lines = 1
  let x = layout.indentEm * fontSizePx
  for (let i = 0; i < text.length; i++) {
    const glyph = (text.charCodeAt(i) < 0x0250 ? 0.55 : 1) * fontSizePx + letterSpacingPx
    if (x > 0 && x + glyph > lineWidth) {
      lines += 1
      x = glyph
    } else x += glyph
  }
  return layout.paddingTopPx + layout.paddingBottomPx + layout.paragraphSpacingPx + lines * fontSizePx * layout.lineHeight
}

export function getChapters(paragraphs: string[]): Chapter[] {
  const chapters = paragraphs
    .map((paragraph, index) => ({ index, title: formatChapterTitle(paragraph.trim()).slice(0, 40) }))
    .filter(chapter => chapterPattern.test(chapter.title))

  return chapters.length > 0 ? chapters : [{ index: 0, title: '開頭' }]
}

// ── Position resolution ──────────────────────────────────────────────────────

export function getCurrentChapterIndex(chapters: Chapter[], paragraphIndex: number): number {
  let currentIndex = 0
  for (let index = 0; index < chapters.length; index += 1) {
    if (chapters[index].index <= paragraphIndex) currentIndex = index
  }
  return currentIndex
}

export function clampChapterIndex(index: number, chapters: Chapter[]): number {
  return Math.min(Math.max(Math.floor(index), 0), Math.max(chapters.length - 1, 0))
}

export interface ProgressPosition {
  positionType: string
  positionValue: number
  chapterOffset?: number
  chapterProgress?: number
}

export interface ChapterTextMap {
  paragraphs: string[]
  prefix: number[]
  chapters: { start: number; bodyStart: number; end: number; length: number }[]
}

function textLength(text: string): number {
  return text.replace(/\s/g, '').length
}

// Prefix lengths are computed once per document, so scroll saves only inspect
// the current paragraph. Whitespace does not move anchors after hard-wrap merges.
export function buildChapterTextMap(chapters: Chapter[], paragraphs: string[]): ChapterTextMap {
  const prefix = [0]
  for (const paragraph of paragraphs) prefix.push(prefix[prefix.length - 1] + textLength(paragraph))
  return {
    paragraphs,
    prefix,
    chapters: chapters.map((chapter, index) => {
      const start = Math.min(Math.max(chapter.index, 0), paragraphs.length)
      const end = Math.min(chapters[index + 1]?.index ?? paragraphs.length, paragraphs.length)
      const first = paragraphs[start] ?? ''
      const hasHeading = chapterPattern.test(first.trim())
        || (chapter.title !== '開頭' && first === chapter.title)
      const bodyStart = Math.min(start + (hasHeading ? 1 : 0), end)
      return { start, bodyStart, end, length: prefix[end] - prefix[bodyStart] }
    }),
  }
}

export function makeChapterProgress(
  chapterIndex: number,
  paragraphIndex: number,
  rawCharacterOffset: number,
  map: ChapterTextMap,
): ProgressPosition {
  const positionValue = Math.min(Math.max(Math.floor(chapterIndex), 0), Math.max(map.chapters.length - 1, 0))
  const chapter = map.chapters[positionValue]
  if (!chapter) return { positionType: 'chapter_index', positionValue, chapterOffset: 0, chapterProgress: 0 }
  const index = Math.min(Math.max(paragraphIndex, chapter.start), Math.max(chapter.end - 1, chapter.start))
  const paragraph = map.paragraphs[index] ?? ''
  const rawOffset = Math.min(Math.max(Math.floor(rawCharacterOffset), 0), paragraph.length)
  const chapterOffset = index < chapter.bodyStart ? 0 : Math.min(chapter.length,
    map.prefix[index] - map.prefix[chapter.bodyStart] + textLength(paragraph.slice(0, rawOffset)))
  return {
    positionType: 'chapter_index', positionValue, chapterOffset,
    chapterProgress: chapter.length > 0 ? chapterOffset / chapter.length : 0,
  }
}

export function getChapterTextTarget(
  progress: ProgressPosition,
  chapters: Chapter[],
  paragraphs: string[],
  map = buildChapterTextMap(chapters, paragraphs),
): { index: number; characterOffset: number } {
  if (progress.positionType !== 'chapter_index') {
    return { index: Math.min(Math.max(Math.floor(progress.positionValue), 0), Math.max(paragraphs.length - 1, 0)), characterOffset: 0 }
  }
  const chapter = map.chapters[clampChapterIndex(progress.positionValue, chapters)]
  if (!chapter) return { index: 0, characterOffset: 0 }
  const savedOffset = progress.chapterOffset ?? Math.round((progress.chapterProgress ?? 0) * chapter.length)
  const offset = Math.min(Math.max(Math.floor(savedOffset), 0), chapter.length)
  if (offset === 0 || chapter.bodyStart >= chapter.end) return { index: chapter.start, characterOffset: 0 }
  const absolute = map.prefix[chapter.bodyStart] + offset
  let low = chapter.bodyStart
  let high = chapter.end - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (map.prefix[middle + 1] <= absolute) low = middle + 1
    else high = middle
  }
  const paragraph = paragraphs[low] ?? ''
  let remaining = absolute - map.prefix[low]
  let characterOffset = 0
  while (characterOffset < paragraph.length) {
    if (!/\s/.test(paragraph[characterOffset])) {
      if (remaining === 0) break
      remaining -= 1
    }
    characterOffset += 1
  }
  return { index: low, characterOffset }
}

export function progressToChapterIndex(progress: ProgressPosition, chapters: Chapter[], paragraphCount: number): number {
  if (progress.positionType === 'chapter_index') {
    return clampChapterIndex(progress.positionValue, chapters)
  }
  const paragraphIndex = Math.min(Math.max(Math.floor(progress.positionValue), 0), Math.max(paragraphCount - 1, 0))
  return getCurrentChapterIndex(chapters, paragraphIndex)
}

export function getChapterProgressRatio(chapterIndex: number, chapters: Chapter[]): number {
  if (chapters.length <= 1) return 0
  return clampChapterIndex(chapterIndex, chapters) / (chapters.length - 1)
}

export const PROGRESS_CONFLICT_GAP = 0.1

export type ProgressMergeDecision =
  | { kind: 'conflict'; reason: 'gap' | 'offline-earlier' }
  | { kind: 'auto'; source: 'local' | 'server' }

interface MergeCandidate extends ProgressPosition {
  updatedAt: string
  pendingSync?: boolean
  syncedPosition?: ProgressPosition
}

// A shared position mapped from another edition carries no offset, so the offset
// is compared only when both sides have one; index and ratio identify it otherwise.
function isConfirmedPosition(server: ProgressPosition, confirmed: ProgressPosition): boolean {
  const offsets = [server.chapterOffset ?? undefined, confirmed.chapterOffset ?? undefined]
  return server.positionType === confirmed.positionType
    && server.positionValue === confirmed.positionValue
    && (server.chapterProgress ?? undefined) === (confirmed.chapterProgress ?? undefined)
    && (offsets.includes(undefined) || offsets[0] === offsets[1])
}

// Only this device moved when its row is unsent and the cloud still holds the
// position this device last confirmed: the local position wins without asking.
// Otherwise gap ≥ 10% (chapter ratio, or in-chapter ratio within one chapter)
// asks the user. Below it: one chapter → newer record; local later → local;
// local earlier → ask only when that local row was never confirmed by the server
// (read offline), otherwise follow the cloud (another device read further).
export function decideProgressMerge({ server, local, serverChapterIndex, localChapterIndex, chapters }: {
  server: MergeCandidate
  local: MergeCandidate
  serverChapterIndex: number
  localChapterIndex: number
  chapters: Chapter[]
}): ProgressMergeDecision {
  if (local.pendingSync === true && local.syncedPosition && isConfirmedPosition(server, local.syncedPosition)) {
    return { kind: 'auto', source: 'local' }
  }
  const sameChapter = localChapterIndex === serverChapterIndex
  const gap = sameChapter && server.chapterProgress !== undefined && local.chapterProgress !== undefined
    ? Math.abs(server.chapterProgress - local.chapterProgress)
    : Math.abs(getChapterProgressRatio(serverChapterIndex, chapters) - getChapterProgressRatio(localChapterIndex, chapters))
  if (gap >= PROGRESS_CONFLICT_GAP) return { kind: 'conflict', reason: 'gap' }
  if (sameChapter) return { kind: 'auto', source: local.updatedAt > server.updatedAt ? 'local' : 'server' }
  if (localChapterIndex > serverChapterIndex) return { kind: 'auto', source: 'local' }
  return local.pendingSync === true ? { kind: 'conflict', reason: 'offline-earlier' } : { kind: 'auto', source: 'server' }
}

export function resolveScrollTarget(
  pendingProgress: ProgressPosition,
  chapters: Chapter[],
  paragraphCount: number,
  paragraphs?: string[],
): number | null {
  if (pendingProgress.positionType === 'chapter_index') {
    if (pendingProgress.positionValue >= chapters.length) return null
    if (paragraphs) return getChapterTextTarget(pendingProgress, chapters, paragraphs).index
    const idx = clampChapterIndex(pendingProgress.positionValue, chapters)
    return chapters[idx]?.index ?? 0
  }
  return Math.min(Math.max(pendingProgress.positionValue, 0), Math.max(paragraphCount - 1, 0))
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function normalizeSettings(settings: ReaderSettings): ReaderSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    tapScrollPercent: settings.tapScrollPercent ?? DEFAULT_SETTINGS.tapScrollPercent,
    tapScrollMode: settings.tapScrollMode ?? DEFAULT_SETTINGS.tapScrollMode,
    hardWrapMode: settings.hardWrapMode ?? DEFAULT_SETTINGS.hardWrapMode,
    chineseConversion: settings.chineseConversion ?? DEFAULT_SETTINGS.chineseConversion,
    contentFilters: Array.isArray(settings.contentFilters)
      ? settings.contentFilters.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
      : DEFAULT_SETTINGS.contentFilters,
    paddingTop: settings.paddingTop ?? DEFAULT_SETTINGS.paddingTop,
    paddingBottom: settings.paddingBottom ?? DEFAULT_SETTINGS.paddingBottom,
    annotationMarginTop: settings.annotationMarginTop ?? DEFAULT_SETTINGS.annotationMarginTop,
    annotationMarginBottom: settings.annotationMarginBottom ?? DEFAULT_SETTINGS.annotationMarginBottom,
    marginLeft: settings.marginLeft ?? DEFAULT_SETTINGS.marginLeft,
    marginRight: settings.marginRight ?? DEFAULT_SETTINGS.marginRight,
    paragraphSpacing: settings.paragraphSpacing ?? DEFAULT_SETTINGS.paragraphSpacing,
    paragraphIndent: settings.paragraphIndent ?? DEFAULT_SETTINGS.paragraphIndent,
    fontWeight: settings.fontWeight ?? DEFAULT_SETTINGS.fontWeight,
    justifyText: settings.justifyText ?? DEFAULT_SETTINGS.justifyText,
  }
}

export function applyContentFilters(text: string, filters: string[]): string {
  return filters
    .map(filter => filter.trim())
    .filter(Boolean)
    .reduce((result, filter) => result.split(filter).join(''), text)
}

export function getChineseConverter(mode: ReaderSettings['chineseConversion']): (text: string) => string {
  if (mode === 'traditional') return OpenCCCn2T.Converter({ from: 'cn', to: 'tw' })
  if (mode === 'simplified') return OpenCCT2Cn.Converter({ from: 'tw', to: 'cn' })
  return text => text
}

export function shouldMergeHardWrap(settings: ReaderSettings, isMobileViewport: boolean): HardWrapHandling {
  if (settings.hardWrapMode === 'merge') return true
  if (settings.hardWrapMode === 'preserve') return false
  return isMobileViewport ? false : 'detect'
}

export function getIsMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(max-width: 767px)').matches
}

export function getTapScrollDirection(
  event: MouseEvent<HTMLDivElement>,
  rect: DOMRect,
  mode: ReaderSettings['tapScrollMode'],
): 1 | -1 {
  if (mode === 'horizontal') {
    return event.clientX < rect.left + rect.width / 2 ? -1 : 1
  }
  if (mode === 'vertical') {
    return event.clientY < rect.top + rect.height / 2 ? -1 : 1
  }
  return 1
}

