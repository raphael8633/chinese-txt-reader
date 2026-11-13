import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, type LocalWebChapter } from '../db.js'
import { rekeyWebChapterCache } from '../webChapterCacheRekey.js'

const cached = (bookId: string, chapterIndex: number, sourceUrl: string | undefined, extra: Partial<LocalWebChapter> = {}) => ({
  bookId,
  chapterIndex,
  title: `舊標題 ${chapterIndex}`,
  ...(sourceUrl ? { sourceUrl } : {}),
  text: `正文 ${sourceUrl ?? chapterIndex}`,
  cachedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
})

const chapter = (index: number, url: string) => ({ index, title: `新標題 ${url}`, sourceUrl: url, chapterKey: url })

async function rows(bookId = 'b') {
  return (await db.webChapterCache.where('bookId').equals(bookId).toArray())
    .sort((a, b) => a.chapterIndex - b.chapterIndex)
    .map((row) => [row.chapterIndex, row.sourceUrl, row.text, row.title])
}

describe('rekeyWebChapterCache', () => {
  beforeEach(async () => {
    await db.open()
  })

  afterEach(async () => {
    db.close()
    await Dexie.delete('raph-reader')
  })

  it('moves cached text to the new index of the same source URL after a mid-book insert', async () => {
    await db.webChapterCache.bulkPut([cached('b', 0, 'u0'), cached('b', 1, 'u1'), cached('b', 2, 'u2'), cached('other', 1, 'u1')])
    await db.transaction('rw', db.webChapterCache, () => rekeyWebChapterCache('b', [
      chapter(0, 'u0'), chapter(1, 'inserted'), chapter(2, 'u1'), chapter(3, 'u2'),
    ]))
    expect(await rows()).toEqual([
      [0, 'u0', '正文 u0', '新標題 u0'],
      [2, 'u1', '正文 u1', '新標題 u1'],
      [3, 'u2', '正文 u2', '新標題 u2'],
    ])
    expect(await rows('other')).toEqual([[1, 'u1', '正文 u1', '舊標題 1']])
  })

  it('drops text whose source URL left the manifest and shifts the tail back after a removal', async () => {
    await db.webChapterCache.bulkPut([cached('b', 0, 'u0'), cached('b', 1, 'removed'), cached('b', 2, 'u2')])
    await rekeyWebChapterCache('b', [chapter(0, 'u0'), chapter(1, 'u2')])
    expect(await rows()).toEqual([
      [0, 'u0', '正文 u0', '新標題 u0'],
      [1, 'u2', '正文 u2', '新標題 u2'],
    ])
  })

  it('never assigns text to a chapter it cannot prove is the same source URL', async () => {
    await db.webChapterCache.bulkPut([
      cached('b', 0, undefined),
      cached('b', 1, 'dup'),
      cached('b', 2, 'u2', { cachedAt: '2026-10-01T00:00:00.000Z', text: '舊版' }),
      cached('b', 3, 'u2', { cachedAt: '2026-10-02T00:00:00.000Z', text: '新版' }),
    ])
    await rekeyWebChapterCache('b', [chapter(0, 'x'), chapter(1, 'dup'), chapter(2, 'dup'), chapter(3, 'u2')])
    expect(await rows()).toEqual([[3, 'u2', '新版', '新標題 u2']])
  })
})
