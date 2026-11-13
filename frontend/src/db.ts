import Dexie, { type Table } from 'dexie'

export interface LocalBook {
  bookId: string
  title: string
  charCount: number
  fileSize: number
  paragraphCount?: number
  chapters?: { index: number; title: string; sourceUrl?: string; chapterKey?: string }[]
  createdAt: string
  updatedAt?: string
  sourceType?: 'txt' | 'web'
  sourceUrl?: string | null
  manifestVersion?: number
  /** The shared work the server reported at download time; offline cards group by it. */
  workId?: string
  downloadedAt: string
  contentVersion: string
  isAvailableOffline: boolean
}

export interface LocalContentChunk {
  bookId: string
  chunkIndex: number
  text: string
  cachedAt: string
}

export interface LocalWebChapter {
  bookId: string
  chapterIndex: number
  title: string
  sourceUrl?: string
  sourceTimestamp?: string
  contentHash?: string
  text: string
  cachedAt: string
}

export interface LocalProgress {
  bookId: string
  positionType: string
  positionValue: number
  chapterOffset?: number
  chapterProgress?: number
  pageIndex?: number
  updatedAt: string
  // true: this device wrote the position and the server has not confirmed it.
  // Missing on rows written before the flag existed; merges treat that as synced.
  pendingSync?: boolean
  // While pendingSync: the last position the server confirmed (missing when unknown).
  syncedPosition?: { positionType: string; positionValue: number; chapterOffset?: number; chapterProgress?: number }
}

export interface LocalSettings {
  bookId: string | null
  fontSizePx: number
  lineHeight: number
  letterSpacingPx: number
  textColor: string
  backgroundColor: string
  readingMode: string
  tapScrollPercent: number
  tapScrollMode: 'allDown' | 'horizontal' | 'vertical'
  toolbarSide: 'left' | 'right'
  hardWrapMode: 'auto' | 'merge' | 'preserve'
  chineseConversion: 'none' | 'traditional' | 'simplified'
  contentFilters: string[]
  paddingTop: number
  paddingBottom: number
  annotationMarginTop: number
  annotationMarginBottom: number
  marginLeft: number
  marginRight: number
  paragraphSpacing: number
  paragraphIndent: number
  fontWeight: number
  justifyText: boolean
}

export class RaphReaderDb extends Dexie {
  books!: Table<LocalBook, string>
  contentChunks!: Table<LocalContentChunk, [string, number]>
  webChapterCache!: Table<LocalWebChapter, [string, number]>
  progress!: Table<LocalProgress, string>
  settings!: Table<LocalSettings, string | null>

  constructor() {
    super('raph-reader')
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
    this.version(3).stores({
      books: 'bookId, title, downloadedAt, isAvailableOffline',
      content: 'bookId',
      contentChunks: '[bookId+chunkIndex], bookId, cachedAt',
      progress: 'bookId, updatedAt',
      settings: 'bookId',
    }).upgrade(async tx => {
      await tx.table('content').clear()
      await tx.table('books').toCollection().modify(book => {
        book.isAvailableOffline = false
      })
    })
    this.version(4).stores({
      books: 'bookId, title, downloadedAt, isAvailableOffline',
      content: 'bookId',
      contentChunks: '[bookId+chunkIndex], bookId, cachedAt',
      progress: 'bookId, updatedAt',
      settings: 'bookId',
    })
    this.version(5).stores({
      books: 'bookId, title, downloadedAt, isAvailableOffline',
      content: 'bookId',
      contentChunks: '[bookId+chunkIndex], bookId, cachedAt',
      webChapterCache: '[bookId+chapterIndex], bookId, cachedAt',
      progress: 'bookId, updatedAt',
      settings: 'bookId',
    })
  }
}

export const db = new RaphReaderDb()
