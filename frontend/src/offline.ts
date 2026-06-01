import type { Book, Progress, ReaderSettings } from './api.js'
import { db, type LocalBook } from './db.js'

const CONTENT_CHUNK_SIZE = 128 * 1024
const SERVICE_WORKER_READY_TIMEOUT_MS = 8000

export function toLocalBook(book: Book, downloadedAt: string, isAvailableOffline: boolean): LocalBook {
  return {
    bookId: book.id,
    title: book.title,
    charCount: book.charCount,
    fileSize: book.fileSize,
    paragraphCount: book.paragraphCount,
    chapters: book.chapters,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    contentVersion: book.updatedAt ?? book.createdAt,
    downloadedAt,
    isAvailableOffline,
  }
}

export function localBookToBook(book: LocalBook, progress?: Progress | null): Book {
  return {
    id: book.bookId,
    title: book.title,
    charCount: book.charCount,
    fileSize: book.fileSize,
    paragraphCount: book.paragraphCount,
    chapters: book.chapters,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    progress,
  }
}

export async function listOfflineBooks(): Promise<Book[]> {
  const localBooks = await db.books.filter(book => book.isAvailableOffline).toArray()
  const books = await Promise.all(localBooks.map(async book => {
    const progress = await db.progress.get(book.bookId)
    return localBookToBook(book, progress ?? null)
  }))
  return books.sort((a, b) => {
    const aTime = a.progress?.updatedAt ?? a.createdAt
    const bTime = b.progress?.updatedAt ?? b.createdAt
    return bTime.localeCompare(aTime)
  })
}

export async function getOfflineBook(bookId: string): Promise<Book | null> {
  const localBook = await db.books.get(bookId)
  if (!localBook?.isAvailableOffline) return null
  const progress = await db.progress.get(bookId)
  return localBookToBook(localBook, progress ?? null)
}

export async function readBookContentChunks(bookId: string): Promise<string | null> {
  const localBook = await db.books.get(bookId)
  if (!localBook?.isAvailableOffline) return null
  const chunks = await db.contentChunks.where('bookId').equals(bookId).sortBy('chunkIndex')
  if (chunks.length === 0) return null
  return chunks.map(chunk => chunk.text).join('')
}

export async function saveBookForOffline(book: Book, text: string): Promise<void> {
  const downloadedAt = new Date().toISOString()
  const chunks = Array.from(
    { length: Math.max(1, Math.ceil(text.length / CONTENT_CHUNK_SIZE)) },
    (_, chunkIndex) => ({
      bookId: book.id,
      chunkIndex,
      text: text.slice(chunkIndex * CONTENT_CHUNK_SIZE, (chunkIndex + 1) * CONTENT_CHUNK_SIZE),
      cachedAt: downloadedAt,
    }),
  )

  await db.transaction('rw', db.books, db.contentChunks, async () => {
    await db.books.put(toLocalBook(book, downloadedAt, false))
    await db.contentChunks.where('bookId').equals(book.id).delete()
    await db.contentChunks.bulkPut(chunks)
  })

  await ensureOfflineAppShellReady()
  await navigator.storage?.persist?.().catch(() => false)
  await db.books.put(toLocalBook(book, downloadedAt, true))
}

export async function removeOfflineBook(bookId: string): Promise<void> {
  await db.transaction('rw', db.books, db.contentChunks, async () => {
    await db.contentChunks.where('bookId').equals(bookId).delete()
    await db.books.delete(bookId)
  })
}

export function settingsToLocal(settings: ReaderSettings, bookId: string | null): ReaderSettings & { bookId: string | null } {
  return { ...settings, bookId }
}

async function ensureOfflineAppShellReady(): Promise<void> {
  if (!('serviceWorker' in navigator)) return

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('Service Worker 尚未準備完成，請稍後再試一次離線下載。'))
        }, SERVICE_WORKER_READY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
