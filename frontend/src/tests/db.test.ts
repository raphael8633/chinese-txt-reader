import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db, RaphReaderDb } from '../db.js'
import { localBookToBook, saveBookForOffline, syncOfflineWorkIds, toLocalBook } from '../offline.js'

class RaphReaderDbV2 extends Dexie {
  constructor(name: string) {
    super(name)
    this.version(1).stores({
      books: 'bookId, title, downloadedAt',
      content: 'bookId, cachedAt',
      progress: 'bookId, updatedAt',
      settings: 'bookId',
    })
    this.version(2).stores({
      books: 'bookId, title, downloadedAt',
      content: 'bookId',
      progress: 'bookId, updatedAt',
      settings: 'bookId',
    })
  }
}

describe('RaphReaderDb migrations', () => {
  afterEach(async () => {
    db.close()
    await Dexie.delete('raph-reader')
    vi.restoreAllMocks()
  })

  it('upgrades v2 content storage without changing the old content primary key', async () => {
    const oldDb = new RaphReaderDbV2('raph-reader')
    await oldDb.open()
    await oldDb.table('books').put({
      bookId: 'book-1',
      title: '舊書',
      downloadedAt: '2026-05-12T00:00:00.000Z',
      isAvailableOffline: true,
    })
    await oldDb.table('content').put({
      bookId: 'book-1',
      text: '舊整本 cache',
      cachedAt: '2026-05-12T00:00:00.000Z',
    })
    oldDb.close()

    const nextDb = new RaphReaderDb()
    await expect(nextDb.open()).resolves.toBe(nextDb)

    expect(nextDb.tables.map(table => table.name)).toContain('contentChunks')
    await expect(nextDb.table('content').toArray()).resolves.toEqual([])
    await expect(nextDb.contentChunks.toArray()).resolves.toEqual([])
    await expect(nextDb.books.get('book-1')).resolves.toMatchObject({
      bookId: 'book-1',
      isAvailableOffline: false,
    })

    nextDb.close()
  })

  it('marks a book offline only after chunks and the app shell service worker are ready', async () => {
    let resolveReady!: () => void
    const ready = new Promise<ServiceWorkerRegistration>(resolve => {
      resolveReady = () => resolve({} as ServiceWorkerRegistration)
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready },
    })
    await db.open()

    let completed = false
    const savePromise = saveBookForOffline({
      id: 'book-2',
      title: '離線測試',
      charCount: 4,
      fileSize: 8,
      createdAt: '2026-05-13T00:00:00.000Z',
    }, '第一段\n第二段').then(() => {
      completed = true
    })

    await waitForStoredBook('book-2')
    await expect(db.contentChunks.where('bookId').equals('book-2').count()).resolves.toBe(1)
    await expect(db.books.get('book-2')).resolves.toMatchObject({
      bookId: 'book-2',
      isAvailableOffline: false,
    })
    expect(completed).toBe(false)

    resolveReady()
    await savePromise

    await expect(db.books.get('book-2')).resolves.toMatchObject({
      bookId: 'book-2',
      isAvailableOffline: true,
    })
  })

  it('keeps the work id on an offline copy so the offline library groups editions by work', () => {
    const book = { id: 'web-a', title: '同名書', charCount: 0, fileSize: 0, createdAt: '2026-08-01T00:00:00Z',
      sourceType: 'web' as const, workId: 'w1' }
    expect(localBookToBook(toLocalBook(book, '2026-11-13T00:00:00Z', true)).workId).toBe('w1')
  })

  it('refreshes the work id of copies downloaded earlier from the online library', async () => {
    await db.open()
    const base = { id: 'web-a', title: '同名書', charCount: 0, fileSize: 0, createdAt: '2026-08-01T00:00:00Z', sourceType: 'web' as const }
    await db.books.put(toLocalBook(base, '2026-11-01T00:00:00Z', true))
    await db.books.put(toLocalBook({ ...base, id: 'web-b', workId: 'old' }, '2026-11-01T00:00:00Z', true))
    await syncOfflineWorkIds([{ ...base, workId: 'w1' }, { ...base, id: 'web-b' }])
    expect((await db.books.get('web-a'))?.workId).toBe('w1')
    expect((await db.books.get('web-b'))?.workId).toBeUndefined()
  })
})

async function waitForStoredBook(bookId: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (await db.books.get(bookId)) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for ${bookId}`)
}
