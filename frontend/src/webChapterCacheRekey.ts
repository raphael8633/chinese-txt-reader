import { db, type LocalWebChapter } from './db.js'

type ManifestChapter = { index: number; title: string; sourceUrl?: string }

/**
 * Re-keys a web book's offline chapter cache after its manifest changed
 * (refresh, supplement apply/undo). Rows are keyed by the mutable chapter index
 * (M-008), so a chapter inserted or removed mid-book would otherwise make every
 * later cached chapter fail its sourceUrl check and silently turn the offline
 * copy partial. Text follows its own sourceUrl to the new index; a row whose URL
 * left the manifest, has no URL, or maps to a URL the manifest lists twice is
 * dropped — text is never assigned to a different sourceUrl.
 *
 * Joins the caller's Dexie transaction when it includes db.webChapterCache.
 */
export async function rekeyWebChapterCache(bookId: string, chapters: ManifestChapter[]): Promise<void> {
  const indexByUrl = new Map<string, ManifestChapter | null>()
  for (const chapter of chapters) {
    if (!chapter.sourceUrl) continue
    indexByUrl.set(chapter.sourceUrl, indexByUrl.has(chapter.sourceUrl) ? null : chapter)
  }

  const rows = await db.webChapterCache.where('bookId').equals(bookId).toArray()
  const next = new Map<number, LocalWebChapter>()
  for (const row of rows) {
    const target = row.sourceUrl ? indexByUrl.get(row.sourceUrl) : null
    if (!target) continue
    const existing = next.get(target.index)
    if (existing && existing.cachedAt >= row.cachedAt) continue
    next.set(target.index, { ...row, chapterIndex: target.index, title: target.title })
  }

  const unchanged = rows.length === next.size && rows.every((row) => {
    const moved = next.get(row.chapterIndex)
    return moved !== undefined && moved.sourceUrl === row.sourceUrl && moved.title === row.title
  })
  if (unchanged) return
  await db.webChapterCache.where('bookId').equals(bookId).delete()
  if (next.size > 0) await db.webChapterCache.bulkPut([...next.values()])
}
