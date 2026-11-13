import type { Book, WebSourceChapterWindow } from './api.js'
import { AuthExpiredError } from './api.js'
import { db } from './db.js'
import { toLocalBook } from './offline.js'

export type WebDownloadStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'auth-expired'

export interface WebDownloadState {
  bookId: string
  total: number
  downloaded: number
  status: WebDownloadStatus
  errorMessage?: string
  startChapterIndex?: number
  refreshExisting?: boolean
  missingOnly?: boolean
}

type FetchChapter = (chapterIndex: number) => Promise<WebSourceChapterWindow>

export interface WebDownloadOptions {
  startChapterIndex?: number
  refreshExisting?: boolean
  missingOnly?: boolean
}

interface InternalRecord extends WebDownloadState {
  cancel: boolean
}

const records = new Map<string, InternalRecord>()
let snapshot: ReadonlyMap<string, WebDownloadState> = new Map()
const listeners = new Set<() => void>()

function rebuildSnapshot(): void {
  const next = new Map<string, WebDownloadState>()
  for (const [bookId, record] of records) {
    next.set(bookId, {
      bookId: record.bookId,
      total: record.total,
      downloaded: record.downloaded,
      status: record.status,
      errorMessage: record.errorMessage,
      startChapterIndex: record.startChapterIndex,
      refreshExisting: record.refreshExisting,
      missingOnly: record.missingOnly,
    })
  }
  snapshot = next
}

function notify(): void {
  rebuildSnapshot()
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getSnapshot(): ReadonlyMap<string, WebDownloadState> {
  return snapshot
}

export function getDownloadState(bookId: string): WebDownloadState | undefined {
  return snapshot.get(bookId)
}

// Test-only: drop all manager state. Module-level state otherwise leaks across
// tests and pollutes the singleton snapshot returned by useSyncExternalStore.
export function __resetWebDownloadsForTests(): void {
  records.clear()
  rebuildSnapshot()
}

export function clearWebBookDownload(bookId: string): void {
  const record = records.get(bookId)
  if (!record) return
  if (record.status === 'running') return
  records.delete(bookId)
  notify()
}

export function cancelWebBookDownload(bookId: string): void {
  const record = records.get(bookId)
  if (!record || record.status !== 'running') return
  record.cancel = true
  record.status = 'cancelled'
  notify()
}

export async function startWebBookDownload(
  book: Book,
  fetchChapter: FetchChapter,
  options: WebDownloadOptions = {},
): Promise<void> {
  const existing = records.get(book.id)
  if (existing && existing.status === 'running') return

  const chapters = book.chapters ?? []
  if (chapters.length === 0) {
    records.set(book.id, {
      bookId: book.id,
      total: 0,
      downloaded: 0,
      status: 'error',
      errorMessage: '此線上書沒有章節可下載',
      cancel: false,
    })
    notify()
    return
  }

  const optionStart = options.startChapterIndex
  const requestedStart = typeof optionStart === 'number' && Number.isFinite(optionStart)
    ? Math.max(0, Math.floor(optionStart))
    : chapters[0].index
  let targetChapters = chapters.filter(chapter => chapter.index >= requestedStart)
  const refreshExisting = options.refreshExisting === true
  if (targetChapters.length === 0) {
    records.set(book.id, {
      bookId: book.id,
      total: 0,
      downloaded: 0,
      status: 'error',
      errorMessage: '目前閱讀進度超出章節範圍',
      startChapterIndex: requestedStart,
      refreshExisting,
      cancel: false,
    })
    notify()
    return
  }

  // Reserve the job before the first await so two synchronous triggers cannot
  // both pass the running-job guard and create competing downloads.
  const record: InternalRecord = {
    bookId: book.id,
    total: targetChapters.length,
    downloaded: 0,
    status: 'running',
    startChapterIndex: requestedStart,
    refreshExisting,
    missingOnly: options.missingOnly === true,
    cancel: false,
  }
  records.set(book.id, record)
  notify()

  if (options.missingOnly) {
    try {
      const cached = await db.webChapterCache.where('bookId').equals(book.id).toArray()
      if (record.cancel) return
      const chapterByIndex = new Map(chapters.map(chapter => [chapter.index, chapter]))
      const compatibleIndices = new Set(cached.flatMap((row) => {
        const manifestChapter = chapterByIndex.get(row.chapterIndex)
        if (!manifestChapter) return []
        if (manifestChapter.sourceUrl && manifestChapter.sourceUrl !== row.sourceUrl) return []
        return [row.chapterIndex]
      }))
      targetChapters = targetChapters.filter(chapter => !compatibleIndices.has(chapter.index))
      record.total = targetChapters.length
      notify()
    } catch (e) {
      record.status = 'error'
      record.errorMessage = e instanceof Error ? e.message : String(e)
      notify()
      return
    }
  }

  const downloadedAt = new Date().toISOString()
  const targetIndices = new Set(targetChapters.map(chapter => chapter.index))
  // A device-local IndexedDB row does not prove the shared VPS cache is warm.
  // Validate every backend window so a completed download guarantees later
  // devices can reuse the server-side copy without touching the upstream site.
  const completedTargetIndices = new Set<number>()

  record.downloaded = completedTargetIndices.size
  notify()

  // Pre-write a book record so chapter writes survive a reload. A refresh keeps
  // an existing offline copy available until its replacement chapters arrive.
  try {
    const localBook = await db.books.get(book.id)
    if (record.cancel) return
    await db.books.put(toLocalBook(book, downloadedAt, localBook?.isAvailableOffline ?? false))
  } catch (e) {
    record.status = 'error'
    record.errorMessage = e instanceof Error ? e.message : String(e)
    notify()
    return
  }

  try {
    for (const chapter of targetChapters) {
      if (record.cancel) {
        record.status = 'cancelled'
        notify()
        return
      }
      if (completedTargetIndices.has(chapter.index)) continue

      const response = await fetchChapter(chapter.index)
      if (record.cancel) {
        record.status = 'cancelled'
        notify()
        return
      }

      const cachedAt = new Date().toISOString()
      if (response.chapters.length > 0) {
        if (record.cancel) return
        await db.webChapterCache.bulkPut(response.chapters.map((item) => ({
          bookId: book.id,
          chapterIndex: item.index,
          title: item.title,
          sourceUrl: item.sourceUrl,
          sourceTimestamp: item.sourceTimestamp,
          contentHash: item.contentHash,
          text: item.text,
          cachedAt,
        })))
        for (const item of response.chapters) {
          if (targetIndices.has(item.index)) completedTargetIndices.add(item.index)
        }
      }
      // Count only the requested range. A refresh deliberately starts at zero
      // even when stale rows already exist in IndexedDB.
      record.downloaded = completedTargetIndices.size
      notify()
    }

    if (completedTargetIndices.size !== targetChapters.length) {
      throw new Error(
        `來源未回傳完整的目標章節（${completedTargetIndices.size}/${targetChapters.length}）`,
      )
    }
    if (record.cancel) return
    await db.books.put(toLocalBook(book, downloadedAt, true))
    record.status = 'completed'
    record.downloaded = completedTargetIndices.size
    notify()
  } catch (e) {
    const firstIncomplete = targetChapters.find(
      chapter => !completedTargetIndices.has(chapter.index),
    )
    if (firstIncomplete) record.startChapterIndex = firstIncomplete.index
    if (e instanceof AuthExpiredError) {
      record.status = 'auth-expired'
      record.errorMessage = 'Session 已過期，請重新登入後重試下載'
    } else {
      record.status = 'error'
      record.errorMessage = e instanceof Error ? e.message : String(e)
    }
    notify()
  }
}
