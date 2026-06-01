// Strips at most 2 leading whitespace chars (ASCII space, fullwidth space 　, NBSP) per paragraph.
// This eliminates Chinese-novel source indentation that would double-stack with CSS textIndent.
// Mirrors the .trim() applied in mergeHardWrappedParagraphs and the backend splitParagraphs.
export function preserveParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .filter(p => p.trim().length > 0)
    .map(p => p.replace(/^[ 　 ]{1,2}/, ''))
}

export function resolveScrollTarget(
  pendingProgress: { positionType: string; positionValue: number },
  chapters: Array<{ index: number; title: string }>,
  paragraphCount: number,
): number | null {
  if (pendingProgress.positionType === 'chapter_index') {
    if (pendingProgress.positionValue >= chapters.length) return null
    const idx = Math.min(Math.max(pendingProgress.positionValue, 0), chapters.length - 1)
    return chapters[idx]?.index ?? 0
  }
  return Math.min(Math.max(pendingProgress.positionValue, 0), Math.max(paragraphCount - 1, 0))
}
