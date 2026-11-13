import { Converter } from 'opencc-js'
import { parseChapterOrdinal } from '../../utils/chapterOrdinal.js'

/**
 * Same-user cross-source chapter supplementation: deterministic, name-based
 * alignment between two manifests of the same book. The chapter ordinal is never
 * identity across sites (one site's 第103章 is another's 第一百零二章), so only the
 * normalized chapter *name* is compared, and a donor chapter is offered only when
 * its insertion point is bracketed on both sides by name-matched anchors.
 */

export type AlignChapter = {
  index: number
  title: string
  url: string
  chapterKey: string
  /** Already a supplement in the primary manifest: never an anchor, never re-offered. */
  isSupplement?: boolean
}

export type ChapterAnchor = { chapterKey: string; title: string }

export type SupplementCandidateDraft = {
  donorIndex: number
  title: string
  url: string
  chapterKey: string
  anchorAfter: ChapterAnchor
  /** null = appended at the end of the book (a trailing 番外 after the last anchor). */
  anchorBefore: ChapterAnchor | null
  /** Position within its bracket, in donor order. */
  seq: number
}

export type AmbiguousReason = 'renamed_or_variant' | 'unbracketed' | 'mixed_with_supplement' | 'name_elsewhere' | 'no_name'

export type AmbiguousSupplement = {
  reason: AmbiguousReason
  donorTitles: string[]
  primaryTitles: string[]
  afterTitle: string | null
  primaryBefore: string[]
  primaryAfter: string[]
  donorBefore: string[]
  donorAfter: string[]
  /** Internal identities used to bind manual choices to the previewed donor rows. */
  donorUrls: string[]
}

export type SupplementDetection = {
  matchedCount: number
  candidates: SupplementCandidateDraft[]
  ambiguous: AmbiguousSupplement[]
  excludedNotes: string[]
}

export type StoredSupplementPlacement = {
  id: string
  title: string
  url: string
  chapterKey: string
  anchorAfterKey: string
  anchorBeforeKey: string
}

export type SupplementMerge<T extends AlignChapter> = {
  chapters: Array<T | (AlignChapter & { supplementId: string })>
  placed: string[]
  retired: Array<{ id: string; matchedTitle: string }>
  unresolved: Array<{ id: string; reason: 'anchor_missing' | 'anchor_gap_changed' }>
}

/**
 * Stored anchor_before_key of an end-of-book supplement. Real chapter keys are
 * never empty (they fall back to the chapter URL), so '' cannot collide.
 */
export const END_OF_BOOK_ANCHOR_KEY = ''
/** Explicit manual placement before the first primary chapter. */
export const START_OF_BOOK_ANCHOR_KEY = '\u0000start'

const toSimplified = Converter({ from: 't', to: 'cn' })

// 边 tolerates a real site-b typo (第兩邊二十一章 for 第兩百二十一章).
const NUM = '[一二三四五六七八九十百千万萬零〇两兩边\\d]+'
/** A site's own list numbering in front of the real ordinal, e.g. `588.第566章`. */
const LIST_INDEX = /^\s*\d+\s*[.．]\s*(?=第)/
const ORDINAL_PREFIX = new RegExp(`^\\s*(?:第\\s*${NUM}\\s*[章回节節]|${NUM}\\s*[章回节節]|${NUM}\\s*[、.:：]|${NUM}\\s+)\\s*`)
const STORY_ORDINAL = new RegExp(`^\\s*(?:第\\s*${NUM}\\s*[章回节節]|${NUM}\\s*[章回节節])`)
const STORY_SPECIAL = /^\s*(?:序章|楔子|引子|尾声|终章|番外)/
/**
 * Matched against the simplified, note-stripped name. Deliberately broad: a
 * wrongly excluded chapter is merely not offered, while a wrongly offered note
 * would be written into the user's manifest.
 */
const AUTHOR_NOTE_KEYWORDS = [
  '感言', '总结', '推书', '请假', '单章', '感谢', '更新说明', '上架', '月票', '求票', '公告', '新书', '致歉',
  '聊聊', '本书', '作者', '唠叨', '汇报', '成绩', '求订阅', '求推荐', '说两句', '说一说', '通知', '更新',
]
/** Side stories and epilogues: the only chapters that may be appended after the last anchor. */
const TRAILING_EXTRA = /^(?:番外|外传|尾声|终章)/
const PART_MARKER = /^[一二三四五六七八九十百\d上中下终完]+$/

function stripNotes(simplified: string): string {
  return simplified
    .replace(LIST_INDEX, '')
    .replace(ORDINAL_PREFIX, '')
    .replace(/【[^】]*】|\[[^\]]*\]/g, '')
    .replace(/\(([^()]*)\)/g, (_match, content: string) => (PART_MARKER.test(content.trim()) ? `(${content.trim()})` : ''))
    .replace(/第[一二三四五六七八九十百千\d]+更/g, '')
    .replace(/为.{0,3}盟主.*$/, '')
    .replace(/(?:加更|求月票|求订阅|求推荐票)\s*$/, '')
}

function simplify(title: string): string {
  return toSimplified(title.normalize('NFKC'))
}

/** Script-, punctuation- and ordinal-insensitive chapter name; '' when nothing is left. */
export function normalizeChapterName(title: string): string {
  return stripNotes(simplify(title))
    .replace(/[\s\p{P}\p{S}_]+/gu, '')
    .toLowerCase()
}

/** A chapter-ordinal-like story title that is not an author note. */
export function isStoryChapterTitle(title: string): boolean {
  const simplified = simplify(title).replace(LIST_INDEX, '')
  if (!STORY_ORDINAL.test(simplified) && !STORY_SPECIAL.test(simplified)) return false
  const name = stripNotes(simplified)
  if (AUTHOR_NOTE_KEYWORDS.some((keyword) => name.includes(keyword))) return false
  return true
}

/** A 番外/外傳/尾聲 title (ordinal prefix allowed), the only kind appended at the end of a book. */
export function isTrailingExtraTitle(title: string): boolean {
  return TRAILING_EXTRA.test(stripNotes(simplify(title)).trim())
}

/** Patience-style ordered alignment on names unique within each compared range. */
function alignByName(a: string[], b: string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  const stack: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]]
  while (stack.length > 0) {
    const [aLo, aHi, bLo, bHi] = stack.pop()!
    if (aLo >= aHi || bLo >= bHi) continue
    const countA = new Map<string, number>()
    const countB = new Map<string, number>()
    const posB = new Map<string, number>()
    for (let i = aLo; i < aHi; i += 1) if (a[i]) countA.set(a[i], (countA.get(a[i]) ?? 0) + 1)
    for (let j = bLo; j < bHi; j += 1) {
      if (!b[j]) continue
      countB.set(b[j], (countB.get(b[j]) ?? 0) + 1)
      posB.set(b[j], j)
    }
    const unique: Array<[number, number]> = []
    for (let i = aLo; i < aHi; i += 1) {
      if (a[i] && countA.get(a[i]) === 1 && countB.get(a[i]) === 1) unique.push([i, posB.get(a[i])!])
    }
    const anchors = longestIncreasingByB(unique)
    if (anchors.length === 0) continue
    let prevA = aLo
    let prevB = bLo
    for (const [i, j] of anchors) {
      pairs.push([i, j])
      stack.push([prevA, i, prevB, j])
      prevA = i + 1
      prevB = j + 1
    }
    stack.push([prevA, aHi, prevB, bHi])
  }
  return pairs.sort((x, y) => x[0] - y[0])
}

function longestIncreasingByB(pairs: Array<[number, number]>): Array<[number, number]> {
  const tails: number[] = []
  const previous: number[] = new Array(pairs.length).fill(-1)
  for (let k = 0; k < pairs.length; k += 1) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[k] = tails[lo - 1]
    tails[lo] = k
  }
  const result: Array<[number, number]> = []
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = previous[k]) result.push(pairs[k])
  return result.reverse()
}

export function detectSupplementCandidates(
  primary: AlignChapter[],
  donor: AlignChapter[],
): SupplementDetection {
  const primaryNames = primary.map((chapter) => normalizeChapterName(chapter.title))
  const donorNames = donor.map((chapter) => normalizeChapterName(chapter.title))
  const donorNameOf = new Map(donor.map((chapter, position) => [chapter, donorNames[position]]))
  const pairs = alignByName(primaryNames, donorNames)
  const matchedPrimary = new Set(pairs.map(([i]) => i))
  const ordinalOf = (chapter: AlignChapter) => parseChapterOrdinal(chapter.title.replace(LIST_INDEX, ''))
  /**
   * A same-name donor chapter is a reorder or repost (never offered) unless every
   * primary chapter of that name is already matched elsewhere AND the donor's
   * same-name chapters carry different ordinals within the donor site itself
   * (e.g. two distinct 夜談 chapters). Ordinals are compared intra-site only.
   */
  const accountedElsewhere = (chapter: AlignChapter, name: string): AlignChapter[] => {
    const samePrimary = primary.filter((_, position) => primaryNames[position] === name)
    if (samePrimary.length === 0) return []
    const freePrimary = samePrimary.filter((match) => !matchedPrimary.has(primary.indexOf(match)))
    const ordinal = ordinalOf(chapter)
    const repost = donor.some((other) => other !== chapter
      && donorNameOf.get(other) === name
      && (ordinal === null || ordinalOf(other) === null || ordinalOf(other) === ordinal))
    return freePrimary.length > 0 || repost ? samePrimary : []
  }
  const coveredDonor = new Set(pairs.filter(([i]) => primary[i].isSupplement).map(([, j]) => j))
  const anchors = pairs.filter(([i]) => !primary[i].isSupplement)
  const bounds: Array<[number, number]> = [[-1, -1], ...anchors, [primary.length, donor.length]]

  const candidates: SupplementCandidateDraft[] = []
  const ambiguous: AmbiguousSupplement[] = []
  const excludedNotes: string[] = []
  for (let k = 0; k + 1 < bounds.length; k += 1) {
    const [pStart, dStart] = bounds[k]
    const [pEnd, dEnd] = bounds[k + 1]
    const donorBlock: AlignChapter[] = []
    for (let j = dStart + 1; j < dEnd; j += 1) if (!coveredDonor.has(j)) donorBlock.push(donor[j])
    const allStories = donorBlock.filter((chapter) => isStoryChapterTitle(chapter.title))
    excludedNotes.push(...donorBlock.filter((chapter) => !isStoryChapterTitle(chapter.title)).map((c) => c.title))
    const primaryBlock = primary.slice(pStart + 1, pEnd)
    const afterTitle = pStart >= 0 ? primary[pStart].title : null
    const context = (donorPosition = dStart + 1) => ({
      primaryBefore: primary.slice(Math.max(0, pStart - 1), pStart + 1).map(chapter => chapter.title),
      primaryAfter: primary.slice(pEnd, pEnd + 2).map(chapter => chapter.title),
      donorBefore: donor.slice(Math.max(0, donorPosition - 2), donorPosition).map(chapter => chapter.title),
      donorAfter: donor.slice(dEnd, dEnd + 2).map(chapter => chapter.title),
    })
    // A donor chapter whose name the primary already carries elsewhere is a
    // reordering between sites, not a missing chapter: never add a duplicate.
    const stories: AlignChapter[] = []
    for (const chapter of allStories) {
      const name = donorNameOf.get(chapter)
      // An ordinal-only title ('第103章') has no name to compare, so a duplicate of a
      // nameless primary chapter elsewhere could never be ruled out: never offer it.
      // primaryTitles lists what the primary already has at this spot.
      if (!name) {
        ambiguous.push({ reason: 'no_name', donorTitles: [chapter.title], donorUrls: [chapter.url],
          primaryTitles: primaryBlock.map((match) => match.title), afterTitle,
          ...context(donor.indexOf(chapter)) })
        continue
      }
      const elsewhere = accountedElsewhere(chapter, name)
      if (elsewhere.length === 0) {
        stories.push(chapter)
        continue
      }
      ambiguous.push({
        reason: 'name_elsewhere',
        donorTitles: [chapter.title],
        donorUrls: [chapter.url],
        primaryTitles: elsewhere.map((match) => match.title),
        afterTitle,
        ...context(donor.indexOf(chapter)),
      })
    }
    if (stories.length === 0) continue

    const report = (reason: AmbiguousReason, primaryTitles: string[]) => ambiguous.push({
      reason,
      donorTitles: stories.map((chapter) => chapter.title),
      donorUrls: stories.map((chapter) => chapter.url),
      primaryTitles,
      afterTitle,
      ...context(),
    })
    if (pStart < 0 || pEnd >= primary.length) {
      // After the last anchor only a block made entirely of 番外-like chapters may
      // be appended (the primary already has everything before them); a regular
      // chapter there means the primary may simply be behind, so nothing is added.
      const trailingExtras = pStart >= 0 && primaryBlock.length === 0
        && stories.every((chapter) => isTrailingExtraTitle(chapter.title))
      if (!trailingExtras) {
        report('unbracketed', primaryBlock.map((chapter) => chapter.title))
        continue
      }
    }
    const unmatchedPrimary = primaryBlock.filter((chapter) => !chapter.isSupplement)
    if (unmatchedPrimary.length > 0) {
      report('renamed_or_variant', unmatchedPrimary.map((chapter) => chapter.title))
      continue
    }
    if (primaryBlock.length > 0) {
      report('mixed_with_supplement', primaryBlock.map((chapter) => chapter.title))
      continue
    }
    stories.forEach((chapter, seq) => candidates.push({
      donorIndex: chapter.index,
      title: chapter.title,
      url: chapter.url,
      chapterKey: chapter.chapterKey,
      anchorAfter: { chapterKey: primary[pStart].chapterKey, title: primary[pStart].title },
      anchorBefore: pEnd < primary.length ? { chapterKey: primary[pEnd].chapterKey, title: primary[pEnd].title } : null,
      seq,
    }))
  }
  return { matchedCount: pairs.length, candidates, ambiguous, excludedNotes }
}

/**
 * Splices stored supplements into a primary-only manifest. Supplements whose
 * bracket no longer exists stay out of the manifest and are reported, never
 * silently dropped; a supplement the primary now carries by name is retired.
 * `supplements` must already be in insertion order (batch, then seq).
 */
export function mergeSupplements<T extends AlignChapter>(
  primary: T[],
  supplements: StoredSupplementPlacement[],
): SupplementMerge<T> {
  const keyPos = new Map<string, number>()
  const duplicateKeys = new Set<string>()
  primary.forEach((chapter, position) => {
    if (keyPos.has(chapter.chapterKey)) duplicateKeys.add(chapter.chapterKey)
    keyPos.set(chapter.chapterKey, position)
  })
  for (const key of duplicateKeys) keyPos.delete(key)

  const insertions = new Map<number, Array<AlignChapter & { supplementId: string }>>()
  const result: Omit<SupplementMerge<T>, 'chapters'> = { placed: [], retired: [], unresolved: [] }
  for (const supplement of supplements) {
    const sameSource = primary.find((chapter) => chapter.url === supplement.url || chapter.chapterKey === supplement.chapterKey)
    if (sameSource) {
      result.retired.push({ id: supplement.id, matchedTitle: sameSource.title })
      continue
    }
    const name = normalizeChapterName(supplement.title)
    const after = supplement.anchorAfterKey === START_OF_BOOK_ANCHOR_KEY
      ? -1 : keyPos.get(supplement.anchorAfterKey)
    // An end-of-book supplement is bracketed by its anchor and the end of the primary.
    const before = supplement.anchorBeforeKey === END_OF_BOOK_ANCHOR_KEY
      ? primary.length
      : keyPos.get(supplement.anchorBeforeKey)
    if (after === undefined || before === undefined || before <= after) {
      // Never retire by name here: a same-name chapter elsewhere may be distinct.
      result.unresolved.push({ id: supplement.id, reason: 'anchor_missing' })
      continue
    }
    const between = primary.slice(after + 1, before)
    const nameMatch = name ? between.find((chapter) => normalizeChapterName(chapter.title) === name) : undefined
    if (nameMatch) {
      result.retired.push({ id: supplement.id, matchedTitle: nameMatch.title })
      continue
    }
    if (between.length > 0) {
      result.unresolved.push({ id: supplement.id, reason: 'anchor_gap_changed' })
      continue
    }
    const list = insertions.get(after) ?? []
    list.push({
      index: 0,
      title: supplement.title,
      url: supplement.url,
      chapterKey: supplement.chapterKey,
      supplementId: supplement.id,
    })
    insertions.set(after, list)
    result.placed.push(supplement.id)
  }

  const chapters: SupplementMerge<T>['chapters'] = []
  chapters.push(...(insertions.get(-1) ?? []))
  primary.forEach((chapter, position) => {
    chapters.push(chapter)
    chapters.push(...(insertions.get(position) ?? []))
  })
  return { chapters: insertions.size > 0 ? chapters.map((chapter, index) => ({ ...chapter, index })) : chapters, ...result }
}
