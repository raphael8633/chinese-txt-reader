import type { Chapter } from '../api.js'

export type WebChapterPositionRemap = {
  position: number
  matchedBy: 'chapter_key' | 'source_url' | 'position'
}

export function remapWebChapterPosition(
  oldChapters: Chapter[],
  newChapters: Chapter[],
  oldPosition: number,
): WebChapterPositionRemap {
  const target = oldChapters.find(chapter => chapter.index === oldPosition)
  if (target?.chapterKey) {
    const oldMatches = oldChapters.filter(chapter => chapter.chapterKey === target.chapterKey)
    const newMatches = newChapters.filter(chapter => chapter.chapterKey === target.chapterKey)
    if (oldMatches.length === 1 && newMatches.length === 1) {
      return { position: newMatches[0].index, matchedBy: 'chapter_key' }
    }
  }

  const targetUrl = target?.sourceUrl ? canonicalizeSourceUrl(target.sourceUrl) : null
  if (targetUrl) {
    const oldMatches = oldChapters.filter(
      chapter => chapter.sourceUrl && canonicalizeSourceUrl(chapter.sourceUrl) === targetUrl,
    )
    const newMatches = newChapters.filter(
      chapter => chapter.sourceUrl && canonicalizeSourceUrl(chapter.sourceUrl) === targetUrl,
    )
    if (oldMatches.length === 1 && newMatches.length === 1) {
      return { position: newMatches[0].index, matchedBy: 'source_url' }
    }
  }

  const maxPosition = newChapters.reduce(
    (maximum, chapter) => Math.max(maximum, chapter.index),
    0,
  )
  return {
    position: Math.max(0, Math.min(Math.floor(oldPosition), maxPosition)),
    matchedBy: 'position',
  }
}

function canonicalizeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}
