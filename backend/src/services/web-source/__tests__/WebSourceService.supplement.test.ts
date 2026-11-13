import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildApp } from '../../../app.js'
import { initDb } from '../../../db.js'
import { reconcileWorks } from '../../sharedProgress.js'
import { WebSourceService } from '../WebSourceService.js'
import type { WebSourceProvider } from '../types.js'

type Db = ReturnType<typeof initDb>
type SeedChapter = { title: string; url: string; key: string }

const NOW = '2026-10-10T00:00:00.000Z'

function provider(id: string, host: string, overrides: Partial<WebSourceProvider> = {}): WebSourceProvider {
  return {
    providerId: id,
    displayName: id === 'hj' ? '站點B' : '站點A',
    canHandle: (url) => new URL(url).hostname === host,
    getChapterKey: (url) => `${id}:${new URL(url).pathname}`,
    search: vi.fn(),
    parseChapterList: vi.fn(),
    fetchChapterText: vi.fn().mockResolvedValue(`${id} 內文`),
    ...overrides,
  }
}

function seedBook(db: Db, options: {
  id: string
  userId?: string
  title?: string
  providerId: string
  host: string
  chapters: SeedChapter[]
  progress?: number
}): void {
  const userId = options.userId ?? 'reader'
  db.prepare(
    `INSERT INTO books (
       id, user_id, title, original_filename, file_size, char_count, paragraph_count,
       chapters_json, source_type, source_url, provider_id, manifest_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, 0, ?, '[]', 'web', ?, ?, 1, ?, ?)`,
  ).run(options.id, userId, options.title ?? '大奉打更人', `web:${options.host}`, options.chapters.length,
    `https://${options.host}/book`, options.providerId, NOW, NOW)
  const insert = db.prepare(
    `INSERT INTO web_book_chapters (book_id, user_id, chapter_index, title, url, chapter_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  options.chapters.forEach((chapter, index) => insert.run(options.id, userId, index, chapter.title, chapter.url, chapter.key, NOW))
  if (options.progress !== undefined) {
    db.prepare(
      `INSERT INTO reading_progress (user_id, book_id, position_type, position_value, chapter_offset, chapter_progress, updated_at)
       VALUES (?, ?, 'chapter_index', ?, 50, 0.4, ?)`,
    ).run(userId, options.id, options.progress, NOW)
  }
}

const hj = (n: number, title: string): SeedChapter => ({ title, url: `https://hj.test/c/${n}`, key: `hj:/c/${n}` })
const cz = (n: number, title: string): SeedChapter => ({ title, url: `https://cz.test/c/${n}`, key: `cz:/c/${n}` })

const PRIMARY = [
  hj(1, '第一百三十章 甲'), hj(2, '第一百三十一章 乙'), hj(3, '第一百三十二章 吃了師兄'), hj(4, '第一百三十三章 丁'),
]
const DONOR = [
  cz(1, '第132章 甲'), cz(2, '第133章 夜談（為盟主“A狼老師”加更）'), cz(3, '寫個總結'), cz(4, '第134章 乙'),
  cz(5, '第135章 師弟想求你一件事'), cz(6, '第136章 丁'),
]

function setup(options: { progress?: number; userId?: string } = {}) {
  const db = initDb(':memory:')
  seedBook(db, { id: 'primary', userId: options.userId, providerId: 'hj', host: 'hj.test', chapters: PRIMARY, progress: options.progress })
  seedBook(db, { id: 'donor', userId: options.userId, providerId: 'cz', host: 'cz.test', chapters: DONOR })
  seedBook(db, { id: 'other-user', userId: 'someone-else', providerId: 'cz', host: 'cz.test', chapters: DONOR })
  seedBook(db, { id: 'other-title', title: '別的書', providerId: 'cz', host: 'cz.test', chapters: DONOR })
  const hjProvider = provider('hj', 'hj.test')
  const czProvider = provider('cz', 'cz.test')
  let counter = 0
  const service = new WebSourceService({
    db,
    providers: [hjProvider, czProvider],
    now: () => NOW,
    createId: () => `id-${++counter}`,
  })
  return { db, service, hjProvider, czProvider }
}

function manifest(db: Db, bookId = 'primary') {
  return db.prepare(
    'SELECT chapter_index, title, url, chapter_key FROM web_book_chapters WHERE book_id = ? ORDER BY chapter_index',
  ).all(bookId) as Array<{ chapter_index: number; title: string; url: string; chapter_key: string }>
}

function progressRow(db: Db) {
  return db.prepare('SELECT position_value, chapter_offset, chapter_progress FROM reading_progress WHERE book_id = ?').get('primary')
}

// Most supplement fixtures deliberately use a shorter primary; select it
// explicitly so their apply/undo checks exercise a legitimate manual choice.
function pinPrimary(db: Db, userId = 'reader') {
  reconcileWorks(db, userId)
  db.prepare(`UPDATE reading_works SET preferred_book_id='primary',preferred_manual=1 WHERE user_id=? AND title_key='大奉打更人'`).run(userId)
}

describe('WebSourceService cross-source supplements', () => {
  it.each(['primary rename', 'donor rename', 'donor delete', 'primary rename and rejoin', 'donor rename and rejoin',
    'donor anchored rename and rejoin',
    'primary same-work rename', 'donor same-work rename', 'unchanged'])
    ('route rejects stale work tokens and accepts current work: %s', async (change) => {
      const priorEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'development'
      const { db, service } = setup({ userId: 'dev-user' })
      if (change.includes('same-work')) db.prepare('UPDATE books SET title=? WHERE user_id=? AND id=?')
        .run('  大奉打更人  ','dev-user',change.startsWith('primary') ? 'primary' : 'donor')
      pinPrimary(db, 'dev-user')
      const app = buildApp(db, join(tmpdir(), 'supplement-route-fixture'), { webSourceService: service })
      try {
        let anchoredWorkId: string | undefined
        if (change === 'donor anchored rename and rejoin') {
          const initial = (await app.inject({method:'GET',url:'/api/books/donor/shared-progress'})).json()
          anchoredWorkId = initial.workId
          expect((await app.inject({method:'POST',url:'/api/books/donor/shared-progress',payload:{
            positionType:'chapter_index',positionValue:0,manifestVersion:1,
            expectedRevision:initial.revision,expectedWorkId:initial.workId}})).statusCode).toBe(200)
        }
        const preview = await app.inject({ method: 'POST', url: '/api/web-sources/primary/supplements/preview' })
        expect(preview.statusCode).toBe(200)
        const { previewToken, candidates } = preview.json()
        const target = change.startsWith('primary') ? 'primary' : 'donor'
        if (change !== 'unchanged') {
          const mutation = await app.inject({ method: change === 'donor delete' ? 'DELETE' : 'PATCH',
            url: `/api/books/${target}`, ...(change === 'donor delete' ? {} : {
              payload: { title: change.includes('same-work') ? '大奉打更人' : 'Different Story' },
            }) })
          expect(mutation.statusCode).toBe(200)
        }
        if (change.endsWith('rejoin')) {
          const rejoin = await app.inject({ method: 'PATCH', url: `/api/books/${target}`, payload: { title: '大奉打更人' } })
          expect(rejoin.statusCode).toBe(200)
          if (target === 'primary') pinPrimary(db, 'dev-user')
          if (anchoredWorkId) {
            expect((await app.inject({method:'GET',url:'/api/books/primary/shared-progress'})).json())
              .toMatchObject({workId:anchoredWorkId,sharedProgress:{kind:'mapped'}})
            expect((await app.inject({method:'GET',url:'/api/books/donor/shared-progress'})).json())
              .toMatchObject({workId:anchoredWorkId,sharedProgress:{kind:'mapped',positionValue:0}})
          }
        }
        const before = manifest(db)
        const apply = await app.inject({ method: 'POST', url: '/api/web-sources/primary/supplements/apply',
          payload: { previewToken, candidateIds: [candidates[0].id] } })
        if (change === 'unchanged') {
          expect(apply.statusCode).toBe(200)
          expect(manifest(db).map(row => row.url)).toContain(DONOR[1].url)
        } else {
          expect(apply.statusCode).toBe(change.startsWith('primary') ? 409 : 410)
          expect(apply.json().error).toMatch(/重新預覽|preview again/)
          expect(manifest(db)).toEqual(before)
          expect(db.prepare('SELECT COUNT(*) AS n FROM web_book_supplements WHERE book_id = ?').get('primary')).toEqual({ n: 0 })
        }
      } finally {
        await app.close()
        db.close()
        process.env.NODE_ENV = priorEnv
      }
    })
  it('rejects a preview when the primary moves to a different work without changing its manifest', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const before = manifest(db)
    db.prepare('UPDATE books SET title = ? WHERE id = ?').run('Different Story', 'primary')
    await expect(service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [preview.candidates[0].id],
    })).rejects.toMatchObject({ name: 'WebSourceSupplementPreviewExpiredError' })
    expect(manifest(db)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_book_supplements WHERE book_id = ?').get('primary')).toEqual({ n: 0 })
    db.close()
  })
  it.each(['rename', 'delete'])('rejects a preview when the selected donor leaves the work by %s', async (change) => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const before = manifest(db)
    if (change === 'rename') db.prepare('UPDATE books SET title = ? WHERE id = ?').run('Different Story', 'donor')
    else db.prepare('DELETE FROM books WHERE id = ?').run('donor')
    await expect(service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [preview.candidates[0].id],
    })).rejects.toMatchObject({ name: 'WebSourceSupplementPreviewExpiredError' })
    expect(manifest(db)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_book_supplements WHERE book_id = ?').get('primary')).toEqual({ n: 0 })
    db.close()
  })
  it('applies a still-current same-work donor preview', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const result = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [preview.candidates[0].id],
    })
    expect(result.changedCount).toBe(1)
    expect(manifest(db).map(row => row.url)).toContain(DONOR[1].url)
    db.close()
  })
  it('rejects a stale apply after a manual preferred-source switch but permits undoing the old batch', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const applied = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [preview.candidates[0].id],
    })
    const stale = await service.previewSupplements('reader', 'primary')
    db.prepare(`UPDATE reading_works SET preferred_book_id='donor',preferred_manual=1 WHERE user_id='reader'`).run()
    const manual = stale.ambiguous.flatMap(item => item.manualChapters)[0]
    await expect(service.applySupplements('reader', 'primary', {
      previewToken: stale.previewToken, candidateIds: [], manualPlacements: [{ id: manual.id, insertAfterIndex: 2 }],
    })).rejects.toMatchObject({ name: 'WebSourcePreferredSourceConflictError' })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM web_book_supplements WHERE book_id='primary'`).get()).toEqual({ n: 1 })
    expect((await service.undoSupplements('reader', 'primary', applied.batchId)).changedCount).toBe(1)
    db.close()
  })
  it('does not apply to a nonpreferred book when its work disappeared since preview', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    db.prepare(`DELETE FROM reading_works WHERE user_id='reader'`).run()
    await expect(service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [preview.candidates[0].id],
    })).rejects.toMatchObject({ name: 'WebSourcePreferredSourceConflictError' })
    expect(manifest(db)).toHaveLength(4)
    db.close()
  })
  it('targets the best-covered web edition when an uploaded TXT is the preferred edition', async () => {
    const { db, service } = setup()
    db.prepare(`INSERT INTO books (id,user_id,title,original_filename,file_size,char_count,chapters_json,created_at,updated_at)
      VALUES ('upload','reader','大奉打更人','up.txt',0,0,?,?,?)`)
      .run(JSON.stringify([{ index: 1, title: '第一百三十章 甲' }, { index: 6, title: '第一百三十一章 乙' }]), NOW, NOW)
    reconcileWorks(db, 'reader')
    db.prepare(`UPDATE reading_works SET preferred_book_id='upload',preferred_manual=1 WHERE user_id='reader' AND title_key='大奉打更人'`).run()
    await expect(service.previewSupplements('reader', 'donor')).resolves.toMatchObject({ previewToken: expect.any(String) })
    await expect(service.previewSupplements('reader', 'primary'))
      .rejects.toMatchObject({ name: 'WebSourcePreferredSourceConflictError' })
    expect(db.prepare(`SELECT preferred_book_id, supplement_book_id FROM reading_works WHERE user_id='reader' AND title_key='大奉打更人'`).get())
      .toEqual({ preferred_book_id: 'upload', supplement_book_id: 'donor' })
    db.close()
  })
  it('does not offer a preview of nonpreferred gaps', async () => {
    const { db, service } = setup()
    await expect(service.previewSupplements('reader', 'primary'))
      .rejects.toMatchObject({ name: 'WebSourcePreferredSourceConflictError' })
    db.close()
  })
  it('previews only bracketed story chapters from same-title books in the same library', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    expect(preview.donors).toEqual([expect.objectContaining({ bookId: 'donor', providerId: 'cz', displayName: '站點A' })])
    expect(preview.candidates).toEqual([expect.objectContaining({
      donorBookId: 'donor',
      donorDisplayName: '站點A',
      title: '第133章 夜談（為盟主“A狼老師”加更）',
      insertAfterTitle: '第一百三十章 甲',
      insertBeforeTitle: '第一百三十一章 乙',
      // 0-based manifest index of the anchor, so duplicate titles can be told apart.
      insertAfterIndex: 0,
    })])
    expect(preview.ambiguous).toEqual([expect.objectContaining({
      reason: 'renamed_or_variant',
      donorTitles: ['第135章 師弟想求你一件事'],
      primaryTitles: ['第一百三十二章 吃了師兄'],
    })])
    expect(preview.excludedNotes).toEqual([expect.objectContaining({ title: '寫個總結' })])
    expect(preview.manifestVersion).toBe(1)
    expect(typeof preview.previewToken).toBe('string')
    expect(manifest(db)).toHaveLength(4)
    db.close()
  })

  it('lets the reader explicitly place an ambiguous donor chapter using a preview-bound chapter id', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const manual = preview.ambiguous[0].manualChapters[0]
    expect(manual.title).toBe('第135章 師弟想求你一件事')
    await expect(service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [],
      manualPlacements: [{ id: 'forged', insertAfterIndex: 2 }],
    })).rejects.toMatchObject({ name: 'WebSourceSupplementSelectionError' })
    const result = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [],
      manualPlacements: [{ id: manual.id, insertAfterIndex: 2 }],
    })
    expect(result.changedCount).toBe(1)
    expect(manifest(db).map(row => row.title)).toEqual([
      '第一百三十章 甲', '第一百三十一章 乙', '第一百三十二章 吃了師兄',
      '第135章 師弟想求你一件事', '第一百三十三章 丁',
    ])
    db.close()
  })

  it('supports a chosen position before the first primary chapter', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const manual = preview.ambiguous[0].manualChapters[0]
    const result = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [],
      manualPlacements: [{ id: manual.id, insertAfterIndex: -1 }],
    })
    expect(result.changedCount).toBe(1)
    expect(manifest(db)[0].title).toBe(manual.title)
    db.close()
  })

  it('rejects a manual anchor with a nonunique primary key without persisting a batch', async () => {
    const { db, service } = setup()
    db.prepare('UPDATE web_book_chapters SET chapter_key = ? WHERE book_id = ? AND chapter_index = ?')
      .run('hj:/c/2', 'primary', 2)
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const manual = preview.ambiguous.flatMap(item => item.manualChapters)
      .find(item => item.title === '第135章 師弟想求你一件事')!
    await expect(service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [],
      manualPlacements: [{ id: manual.id, insertAfterIndex: 2 }],
    })).rejects.toMatchObject({ name: 'WebSourceSupplementSelectionError', message: expect.stringContaining('插入位置') })
    expect(manifest(db)).toHaveLength(4)
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_book_supplements').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT manifest_version FROM books WHERE id = ?').get('primary')).toEqual({ manifest_version: 1 })
    db.close()
  })

  it.each([
    ['after', 0],
    ['before', 1],
  ])('rejects an automatic candidate with a nonunique %s anchor without claiming success', async (_side, anchorIndex) => {
    const { db, service } = setup()
    db.prepare('UPDATE web_book_chapters SET chapter_key = ? WHERE book_id = ? AND chapter_index = ?')
      .run(PRIMARY[anchorIndex].key, 'primary', 2)
    const before = manifest(db)
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    expect(preview.candidates.map(candidate => candidate.url)).toEqual([DONOR[1].url])
    await expect(service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: preview.candidates.map(candidate => candidate.id),
    })).rejects.toMatchObject({ name: 'WebSourceSupplementSelectionError', message: expect.stringContaining('插入位置') })
    expect(manifest(db)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_book_supplements').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT manifest_version FROM books WHERE id = ?').get('primary')).toEqual({ manifest_version: 1 })
    db.close()
  })

  it('interleaves automatic and manual chapters from one donor in their original order across persistence and refresh', async () => {
    const db = initDb(':memory:')
    const primary = [hj(1, '第一章 甲'), hj(2, '第五章 戊')]
    seedBook(db, { id: 'primary', providerId: 'hj', host: 'hj.test', chapters: primary })
    seedBook(db, { id: 'donor', providerId: 'cz', host: 'cz.test', chapters: [
      cz(1, '第一章 甲'), cz(2, '第二章 乙'), cz(3, '第三章'), cz(4, '第四章 丁'), cz(5, '第五章 戊'),
    ] })
    const hjProvider = provider('hj', 'hj.test')
    const service = new WebSourceService({ db, providers: [hjProvider, provider('cz', 'cz.test')], now: () => NOW })
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    expect(preview.candidates.map(candidate => candidate.url)).toEqual([cz(2, '').url, cz(4, '').url])
    const manual = preview.ambiguous.flatMap(item => item.manualChapters)
    expect(manual.map(item => item.title)).toEqual(['第三章'])
    const applied = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: preview.candidates.map(candidate => candidate.id),
      manualPlacements: [{ id: manual[0].id, insertAfterIndex: 0 }],
    })
    const expectedUrls = [primary[0].url, cz(2, '').url, cz(3, '').url, cz(4, '').url, primary[1].url]
    expect(applied.changedCount).toBe(3)
    expect(applied.book.chapters.map(chapter => chapter.sourceUrl)).toEqual(expectedUrls)
    expect(manifest(db).map(chapter => chapter.url)).toEqual(expectedUrls)
    expect(db.prepare('SELECT url, seq FROM web_book_supplements ORDER BY seq').all()).toEqual([
      { url: cz(2, '').url, seq: 0 }, { url: cz(3, '').url, seq: 1 }, { url: cz(4, '').url, seq: 2 },
    ])
    hjProvider.parseChapterList = vi.fn().mockResolvedValue({
      title: '大奉打更人', sourceUrl: 'https://hj.test/book', providerId: 'hj',
      chapters: primary.map((chapter, index) => ({ index, title: chapter.title, url: chapter.url, chapterKey: chapter.key })),
    })
    const refreshed = await service.refreshFromSource('reader', 'primary')
    expect(refreshed.book.chapters.map(chapter => chapter.sourceUrl)).toEqual(expectedUrls)
    expect(manifest(db).map(chapter => chapter.url)).toEqual(expectedUrls)
    expect(db.prepare('SELECT url, seq FROM web_book_supplements ORDER BY seq').all()).toEqual([
      { url: cz(2, '').url, seq: 0 }, { url: cz(3, '').url, seq: 1 }, { url: cz(4, '').url, seq: 2 },
    ])
    db.close()
  })

  it('orders cross-donor manual selections by donor rank then index regardless of request or ambiguity order', async () => {
    const db = initDb(':memory:')
    seedBook(db, { id: 'primary', providerId: 'hj', host: 'hj.test', chapters: [hj(1, '第一章 甲'), hj(2, '第二章 異名'), hj(3, '第五章 戊')] })
    seedBook(db, { id: 'donor-a', providerId: 'cz', host: 'cz.test', chapters: [
      cz(1, '第一章 甲'), cz(2, '第二章 乙'), cz(3, '第三章'), cz(4, '第五章 戊'),
    ] })
    const third = (n: number, title: string): SeedChapter => ({ title, url: `https://xz.test/c/${n}`, key: `xz:/c/${n}` })
    seedBook(db, { id: 'donor-b', providerId: 'xz', host: 'xz.test', chapters: [third(1, '第一章 甲'), third(2, '第四章 丙'), third(3, '第五章 戊')] })
    const service = new WebSourceService({ db, providers: [provider('hj', 'hj.test'), provider('cz', 'cz.test'), provider('xz', 'xz.test')], now: () => NOW })
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    expect(preview.donors.map(donor => donor.bookId)).toEqual(['donor-a', 'donor-b'])
    const manual = preview.ambiguous.flatMap(item => item.manualChapters)
    expect(manual.map(item => item.title)).toEqual(['第三章', '第二章 乙', '第四章 丙'])
    await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [],
      manualPlacements: [manual[1], manual[2], manual[0]].map(item => ({ id: item.id, insertAfterIndex: 1 })),
    })
    expect(db.prepare('SELECT donor_book_id, url, seq FROM web_book_supplements ORDER BY seq').all()).toEqual([
      { donor_book_id: 'donor-a', url: cz(2, '').url, seq: 0 },
      { donor_book_id: 'donor-a', url: cz(3, '').url, seq: 1 },
      { donor_book_id: 'donor-b', url: third(2, '').url, seq: 2 },
    ])
    expect(manifest(db).map(chapter => chapter.url)).toEqual([
      hj(1, '').url, hj(2, '').url, cz(2, '').url, cz(3, '').url, third(2, '').url, hj(3, '').url,
    ])
    db.close()
  })

  it('uses preview donor rank even when an earlier donor contributes only manual choices', async () => {
    const db = initDb(':memory:')
    const primary = [hj(1, '第一章 甲'), hj(2, '第二章 乙'), hj(3, '第四章 丁')]
    seedBook(db, { id: 'primary', providerId: 'hj', host: 'hj.test', chapters: primary })
    seedBook(db, { id: 'donor-a', providerId: 'cz', host: 'cz.test', chapters: [
      cz(1, '第一章 甲'), cz(2, '第二章 乙'), cz(3, '第三章'), cz(4, '第四章 丁'),
    ] })
    const third = (n: number, title: string): SeedChapter => ({ title, url: `https://xz.test/c/${n}`, key: `xz:/c/${n}` })
    seedBook(db, { id: 'donor-b', providerId: 'xz', host: 'xz.test', chapters: [
      third(1, '第一章 甲'), third(2, '第2章 新'), third(3, '第二章 乙'), third(4, '第四章 丁'),
    ] })
    const service = new WebSourceService({ db, providers: [provider('hj', 'hj.test'), provider('cz', 'cz.test'), provider('xz', 'xz.test')], now: () => NOW })
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    expect(preview.donors.map(donor => donor.bookId)).toEqual(['donor-a', 'donor-b'])
    expect(preview.candidates.map(candidate => candidate.url)).toEqual([third(2, '').url])
    const manual = preview.ambiguous.flatMap(item => item.manualChapters)
    expect(manual.map(item => item.title)).toEqual(['第三章'])
    await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: preview.candidates.map(candidate => candidate.id),
      manualPlacements: [{ id: manual[0].id, insertAfterIndex: 1 }],
    })
    expect(db.prepare('SELECT donor_book_id, seq FROM web_book_supplements ORDER BY seq').all()).toEqual([
      { donor_book_id: 'donor-a', seq: 0 }, { donor_book_id: 'donor-b', seq: 1 },
    ])
    expect(manifest(db).map(chapter => chapter.url)).toEqual([
      primary[0].url, third(2, '').url, primary[1].url, cz(3, '').url, primary[2].url,
    ])
    db.close()
  })

  it('keeps donor order within one manual gap even when placements arrive reversed', async () => {
    const db = initDb(':memory:')
    seedBook(db, { id: 'primary', providerId: 'hj', host: 'hj.test', chapters: [hj(1, '第一章 甲'), hj(2, '第二章 異名'), hj(3, '第四章 丁')] })
    seedBook(db, { id: 'donor', providerId: 'cz', host: 'cz.test', chapters: [
      cz(1, '第一章 甲'), cz(2, '第二章 乙'), cz(3, '第三章 丙'), cz(4, '第四章 丁'),
    ] })
    const service = new WebSourceService({ db, providers: [provider('hj', 'hj.test'), provider('cz', 'cz.test')], now: () => NOW })
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const manual = preview.ambiguous.flatMap(item => item.manualChapters)
    expect(manual.map(item => item.title)).toEqual(['第二章 乙', '第三章 丙'])
    const result = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [],
      manualPlacements: [...manual].reverse().map(item => ({ id: item.id, insertAfterIndex: 1 })),
    })
    expect(result.changedCount).toBe(2)
    expect(manifest(db).map(row => row.title)).toEqual([
      '第一章 甲', '第二章 異名', '第二章 乙', '第三章 丙', '第四章 丁',
    ])
    db.close()
  })

  it('keeps donor order across ambiguous reasons in one manually chosen gap', async () => {
    const db = initDb(':memory:')
    seedBook(db, { id: 'primary', providerId: 'hj', host: 'hj.test', chapters: [hj(1, '第一章 甲'), hj(2, '第二章 異名'), hj(3, '第五章 戊')] })
    seedBook(db, { id: 'donor', providerId: 'cz', host: 'cz.test', chapters: [
      cz(1, '第一章 甲'), cz(2, '第二章 乙'), cz(3, '第三章 丙'), cz(4, '第四章'), cz(5, '第五章 戊'),
    ] })
    const service = new WebSourceService({ db, providers: [provider('hj', 'hj.test'), provider('cz', 'cz.test')], now: () => NOW })
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const manual = preview.ambiguous.flatMap(item => item.manualChapters)
    expect(manual.map(item => item.title)).toEqual(['第四章', '第二章 乙', '第三章 丙'])
    await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: [],
      manualPlacements: manual.map(item => ({ id: item.id, insertAfterIndex: 1 })),
    })
    expect(manifest(db).map(row => row.title)).toEqual([
      '第一章 甲', '第二章 異名', '第二章 乙', '第三章 丙', '第四章', '第五章 戊',
    ])
    db.close()
  })

  it('applies the confirmed candidates atomically and keeps progress on the same chapter key', async () => {
    const { db, service } = setup({ progress: 1 })
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const result = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken,
      candidateIds: preview.candidates.map((candidate) => candidate.id),
    })
    expect(manifest(db).map((row) => [row.chapter_index, row.chapter_key])).toEqual([
      [0, 'hj:/c/1'], [1, 'cz:/c/2'], [2, 'hj:/c/2'], [3, 'hj:/c/3'], [4, 'hj:/c/4'],
    ])
    expect(result).toMatchObject({
      previousChapterCount: 4,
      newChapterCount: 5,
      progressRemap: { previousPosition: 1, newPosition: 2, matchedBy: 'chapter_key' },
      book: { id: 'primary', manifestVersion: 2, paragraphCount: 5 },
      changedCount: 1,
    })
    expect(result.book.chapters[1]).toEqual({
      index: 1, title: '第133章 夜談（為盟主“A狼老師”加更）', sourceUrl: 'https://cz.test/c/2', chapterKey: 'cz:/c/2',
    })
    expect(progressRow(db)).toEqual({ position_value: 2, chapter_offset: 50, chapter_progress: 0.4 })
    expect(db.prepare('SELECT batch_id, donor_book_id, donor_provider_id, anchor_after_key, anchor_before_key, status FROM web_book_supplements').all())
      .toEqual([{ batch_id: result.batchId, donor_book_id: 'donor', donor_provider_id: 'cz',
        anchor_after_key: 'hj:/c/1', anchor_before_key: 'hj:/c/2', status: 'active' }])
    db.close()
  })

  it('rejects a reused, foreign or stale preview token without writing', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const ids = preview.candidates.map((candidate) => candidate.id)
    await expect(service.applySupplements('someone-else', 'primary', { previewToken: preview.previewToken, candidateIds: ids }))
      .rejects.toMatchObject({ name: 'WebSourceSupplementPreviewExpiredError' })
    await expect(service.applySupplements('reader', 'primary', { previewToken: preview.previewToken, candidateIds: ['nope'] }))
      .rejects.toMatchObject({ name: 'WebSourceSupplementSelectionError' })
    db.prepare('UPDATE books SET manifest_version = 7 WHERE id = ?').run('primary')
    await expect(service.applySupplements('reader', 'primary', { previewToken: preview.previewToken, candidateIds: ids }))
      .rejects.toMatchObject({ name: 'WebSourceRefreshConflictError' })
    expect(manifest(db)).toHaveLength(4)
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_book_supplements').get()).toEqual({ n: 0 })
    db.close()
  })

  it('expires preview tokens after the preview TTL', async () => {
    const db = initDb(':memory:')
    seedBook(db, { id: 'primary', providerId: 'hj', host: 'hj.test', chapters: PRIMARY })
    seedBook(db, { id: 'donor', providerId: 'cz', host: 'cz.test', chapters: DONOR })
    let nowMs = 0
    const service = new WebSourceService({ db, providers: [provider('hj', 'hj.test'), provider('cz', 'cz.test')], nowMs: () => nowMs })
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    nowMs = 11 * 60 * 1000
    await expect(service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: preview.candidates.map((candidate) => candidate.id),
    })).rejects.toMatchObject({ name: 'WebSourceSupplementPreviewExpiredError' })
    db.close()
  })

  it('re-merges supplements after a refresh and keeps progress on a supplemented chapter', async () => {
    const { db, service, hjProvider } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    await service.applySupplements('reader', 'primary', { previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id) })
    db.prepare(
      `INSERT INTO reading_progress (user_id, book_id, position_type, position_value, chapter_offset, chapter_progress, updated_at)
       VALUES ('reader', 'primary', 'chapter_index', 1, 10, 0.1, ?)`,
    ).run(NOW)
    hjProvider.parseChapterList = vi.fn().mockResolvedValue({
      title: '大奉打更人', sourceUrl: 'https://hj.test/book', providerId: 'hj',
      chapters: [
        { index: 0, title: '第一百二十九章 新', url: 'https://hj.test/c/0', chapterKey: 'hj:/c/0' },
        ...PRIMARY.map((chapter, index) => ({ index: index + 1, title: chapter.title, url: chapter.url, chapterKey: chapter.key })),
      ],
    })
    const refreshed = await service.refreshFromSource('reader', 'primary')
    expect(manifest(db).map((row) => row.chapter_key)).toEqual([
      'hj:/c/0', 'hj:/c/1', 'cz:/c/2', 'hj:/c/2', 'hj:/c/3', 'hj:/c/4',
    ])
    expect(refreshed.progressRemap).toEqual({ previousPosition: 1, newPosition: 2, matchedBy: 'chapter_key' })
    expect(progressRow(db)).toEqual({ position_value: 2, chapter_offset: 10, chapter_progress: 0.1 })
    expect(refreshed.newChapterCount).toBe(6)
    db.close()
  })

  it('keeps a supplement whose anchor vanished out of the manifest with an active warning', async () => {
    const { db, service, hjProvider } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    await service.applySupplements('reader', 'primary', { previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id) })
    hjProvider.parseChapterList = vi.fn().mockResolvedValue({
      title: '大奉打更人', sourceUrl: 'https://hj.test/book', providerId: 'hj',
      chapters: PRIMARY.slice(1).map((chapter, index) => ({ index, title: chapter.title, url: chapter.url, chapterKey: chapter.key })),
    })
    const refreshed = await service.refreshFromSource('reader', 'primary')
    expect(manifest(db).map((row) => row.chapter_key)).toEqual(['hj:/c/2', 'hj:/c/3', 'hj:/c/4'])
    expect(refreshed.warnings?.join('\n')).toContain('第133章 夜談（為盟主“A狼老師”加更）')
    expect(refreshed.warnings?.join('\n')).toContain('暫未補入')
    expect(db.prepare('SELECT status FROM web_book_supplements').all()).toEqual([{ status: 'active' }])
    db.close()
  })

  it('retires a supplement once the primary source carries the chapter itself', async () => {
    const { db, service, hjProvider } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    await service.applySupplements('reader', 'primary', { previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id) })
    hjProvider.parseChapterList = vi.fn().mockResolvedValue({
      title: '大奉打更人', sourceUrl: 'https://hj.test/book', providerId: 'hj',
      chapters: [PRIMARY[0], hj(9, '第一百三十一章 夜談'), ...PRIMARY.slice(1)]
        .map((chapter, index) => ({ index, title: chapter.title, url: chapter.url, chapterKey: chapter.key })),
    })
    const refreshed = await service.refreshFromSource('reader', 'primary')
    expect(manifest(db).map((row) => row.chapter_key)).toEqual(['hj:/c/1', 'hj:/c/9', 'hj:/c/2', 'hj:/c/3', 'hj:/c/4'])
    expect(refreshed.warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('暫未補入')]))
    expect(refreshed.debugMessages?.join('\n')).toContain('來源已含此章')
    expect(db.prepare('SELECT status FROM web_book_supplements').all()).toEqual([{ status: 'retired' }])
    db.close()
  })

  it('undoes a batch back to the identical manifest and keeps progress on the same chapter key', async () => {
    const { db, service } = setup({ progress: 3 })
    const before = manifest(db)
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const applied = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id),
    })
    expect(progressRow(db)).toMatchObject({ position_value: 4 })
    const undone = await service.undoSupplements('reader', 'primary', applied.batchId)
    expect(manifest(db)).toEqual(before)
    expect(undone).toMatchObject({
      batchId: applied.batchId,
      changedCount: 1,
      previousChapterCount: 5,
      newChapterCount: 4,
      progressRemap: { previousPosition: 4, newPosition: 3, matchedBy: 'chapter_key' },
      book: { manifestVersion: 3 },
    })
    expect(progressRow(db)).toEqual({ position_value: 3, chapter_offset: 50, chapter_progress: 0.4 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_book_supplements').get()).toEqual({ n: 0 })
    await expect(service.undoSupplements('reader', 'primary'))
      .rejects.toMatchObject({ name: 'WebSourceSupplementBatchNotFoundError' })
    db.close()
  })

  it('undoes the latest batch when no batch id is given and lists batches in the preview', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const applied = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id),
    })
    const again = await service.previewSupplements('reader', 'primary')
    expect(again.candidates).toEqual([])
    expect(again.batches).toEqual([expect.objectContaining({ batchId: applied.batchId, count: 1 })])
    const undone = await service.undoSupplements('reader', 'primary')
    expect(undone.batchId).toBe(applied.batchId)
    db.close()
  })

  it('fetches a supplemented chapter through the donor provider and caches it under the primary book', async () => {
    const { db, service, hjProvider, czProvider } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    await service.applySupplements('reader', 'primary', { previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id) })
    const window = await service.readChapterWindow('reader', 'primary', { center: 1, before: 0, after: 0 })
    expect(window.chapters[0]).toMatchObject({ index: 1, sourceUrl: 'https://cz.test/c/2', text: 'cz 內文' })
    expect(czProvider.fetchChapterText).toHaveBeenCalledWith('https://cz.test/c/2')
    expect(hjProvider.fetchChapterText).not.toHaveBeenCalled()
    expect(db.prepare('SELECT book_id, source_url FROM web_source_chapter_cache').all())
      .toEqual([{ book_id: 'primary', source_url: 'https://cz.test/c/2' }])
    db.close()
  })

  it('removes supplements with the primary book', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    await service.applySupplements('reader', 'primary', { previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id) })
    db.prepare('DELETE FROM books WHERE id = ?').run('primary')
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_book_supplements').get()).toEqual({ n: 0 })
    db.close()
  })

  it('remaps the progress saved while the refresh parse was in flight, not a stale snapshot', async () => {
    const { db, service, hjProvider } = setup({ progress: 0 })
    let resolveParse: (value: unknown) => void = () => {}
    hjProvider.parseChapterList = vi.fn(() => new Promise((resolve) => { resolveParse = resolve })) as never
    const refreshing = service.refreshFromSource('reader', 'primary')
    await vi.waitFor(() => expect(hjProvider.parseChapterList).toHaveBeenCalled())
    // The reader saves a later position while the network parse is pending.
    db.prepare(
      `UPDATE reading_progress SET position_value = 2, chapter_offset = 77, chapter_progress = 0.7 WHERE book_id = 'primary'`,
    ).run()
    resolveParse({
      title: '大奉打更人', sourceUrl: 'https://hj.test/book', providerId: 'hj',
      chapters: [hj(0, '第一百二十九章 新'), ...PRIMARY]
        .map((chapter, index) => ({ index, title: chapter.title, url: chapter.url, chapterKey: chapter.key })),
    })
    const refreshed = await refreshing
    expect(refreshed.progressRemap).toEqual({ previousPosition: 2, newPosition: 3, matchedBy: 'chapter_key' })
    expect(progressRow(db)).toEqual({ position_value: 3, chapter_offset: 77, chapter_progress: 0.7 })
    db.close()
  })

  it('lets a retired supplement URL be supplemented again, replacing the retired row', async () => {
    const { db, service, hjProvider } = setup()
    pinPrimary(db)
    const first = await service.previewSupplements('reader', 'primary')
    await service.applySupplements('reader', 'primary', { previewToken: first.previewToken, candidateIds: first.candidates.map((c) => c.id) })
    const parseWith = (chapters: SeedChapter[]) => {
      hjProvider.parseChapterList = vi.fn().mockResolvedValue({
        title: '大奉打更人', sourceUrl: 'https://hj.test/book', providerId: 'hj',
        chapters: chapters.map((chapter, index) => ({ index, title: chapter.title, url: chapter.url, chapterKey: chapter.key })),
      })
    }
    // The primary source briefly carries the chapter (retiring the supplement), then drops it again.
    parseWith([PRIMARY[0], hj(9, '第一百三十一章 夜談'), ...PRIMARY.slice(1)])
    await service.refreshFromSource('reader', 'primary')
    parseWith(PRIMARY)
    await service.refreshFromSource('reader', 'primary')
    expect(db.prepare('SELECT status FROM web_book_supplements').all()).toEqual([{ status: 'retired' }])

    const again = await service.previewSupplements('reader', 'primary')
    expect(again.ambiguous.map((item) => item.reason)).not.toContain('pending_supplement')
    expect(again.candidates.map((candidate) => candidate.url)).toEqual(['https://cz.test/c/2'])
    const applied = await service.applySupplements('reader', 'primary', {
      previewToken: again.previewToken, candidateIds: again.candidates.map((c) => c.id),
    })
    expect(manifest(db).map((row) => row.chapter_key)).toEqual(['hj:/c/1', 'cz:/c/2', 'hj:/c/2', 'hj:/c/3', 'hj:/c/4'])
    expect(db.prepare('SELECT batch_id, status FROM web_book_supplements').all())
      .toEqual([{ batch_id: applied.batchId, status: 'active' }])
    db.close()
  })

  it('reports authoritative batch state and never offers to undo a batch whose rows are all retired', async () => {
    const { db, service, hjProvider } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const applied = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id),
    })
    expect(applied.book).toMatchObject({
      supplementBatchCount: 1,
      latestSupplementBatch: { batchId: applied.batchId, count: 1, titles: ['第133章 夜談（為盟主“A狼老師”加更）'] },
    })
    hjProvider.parseChapterList = vi.fn().mockResolvedValue({
      title: '大奉打更人', sourceUrl: 'https://hj.test/book', providerId: 'hj',
      chapters: [PRIMARY[0], hj(9, '第一百三十一章 夜談'), ...PRIMARY.slice(1)]
        .map((chapter, index) => ({ index, title: chapter.title, url: chapter.url, chapterKey: chapter.key })),
    })
    const refreshed = await service.refreshFromSource('reader', 'primary')
    expect(refreshed.book).toMatchObject({ supplementBatchCount: 0, latestSupplementBatch: null })
    expect((await service.previewSupplements('reader', 'primary')).batches).toEqual([])
    await expect(service.undoSupplements('reader', 'primary'))
      .rejects.toMatchObject({ name: 'WebSourceSupplementBatchNotFoundError' })
    await expect(service.undoSupplements('reader', 'primary', applied.batchId))
      .rejects.toMatchObject({ name: 'WebSourceSupplementBatchNotFoundError' })
    db.close()
  })

  it('reports the remaining batch state after an undo', async () => {
    const { db, service } = setup()
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    const applied = await service.applySupplements('reader', 'primary', {
      previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id),
    })
    const undone = await service.undoSupplements('reader', 'primary', applied.batchId)
    expect(undone.book).toMatchObject({ supplementBatchCount: 0, latestSupplementBatch: null })
    db.close()
  })

  it('appends trailing 番外 at the end of the book and keeps them there across a refresh', async () => {
    const db = initDb(':memory:')
    const primaryChapters = [hj(1, '第一章 甲'), hj(2, '第二章 乙'), hj(3, '完本感言')]
    seedBook(db, { id: 'primary', providerId: 'hj', host: 'hj.test', chapters: primaryChapters })
    seedBook(db, { id: 'donor', providerId: 'cz', host: 'cz.test', chapters: [
      cz(1, '第1章 甲'), cz(2, '第2章 乙'), cz(3, '完本感言'), cz(4, '第916章 番外一：劫後'), cz(5, '番外二：一統天下'),
    ] })
    const hjProvider = provider('hj', 'hj.test')
    const service = new WebSourceService({ db, providers: [hjProvider, provider('cz', 'cz.test')], now: () => NOW })
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    expect(preview.candidates.map((candidate) => [candidate.title, candidate.atEnd, candidate.insertAfterIndex, candidate.insertBeforeTitle]))
      .toEqual([['第916章 番外一：劫後', true, 2, ''], ['番外二：一統天下', true, 2, '']])
    await service.applySupplements('reader', 'primary', { previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id) })
    expect(manifest(db).map((row) => row.chapter_key)).toEqual(['hj:/c/1', 'hj:/c/2', 'hj:/c/3', 'cz:/c/4', 'cz:/c/5'])
    expect(db.prepare('SELECT anchor_before_key, anchor_before_title FROM web_book_supplements ORDER BY seq').all())
      .toEqual([{ anchor_before_key: '', anchor_before_title: '' }, { anchor_before_key: '', anchor_before_title: '' }])

    hjProvider.parseChapterList = vi.fn().mockResolvedValue({
      title: '大奉打更人', sourceUrl: 'https://hj.test/book', providerId: 'hj',
      chapters: primaryChapters.map((chapter, index) => ({ index, title: chapter.title, url: chapter.url, chapterKey: chapter.key })),
    })
    const refreshed = await service.refreshFromSource('reader', 'primary')
    expect(manifest(db).map((row) => row.chapter_key)).toEqual(['hj:/c/1', 'hj:/c/2', 'hj:/c/3', 'cz:/c/4', 'cz:/c/5'])
    expect((refreshed.warnings ?? []).filter((warning) => warning.startsWith('補章'))).toEqual([])
    db.close()
  })

  it.each([
    ['a provider that cannot handle the URL', 'hj'],
    ['the generic provider', 'generic'],
  ])('refuses to fetch a supplemented chapter through %s', async (_label, providerId) => {
    const { db, hjProvider, czProvider } = setup()
    const generic = provider('generic', 'any', { canHandle: () => true })
    let counter = 0
    const service = new WebSourceService({
      db, providers: [hjProvider, czProvider, generic], now: () => NOW, createId: () => `id-${++counter}`,
    })
    pinPrimary(db)
    const preview = await service.previewSupplements('reader', 'primary')
    await service.applySupplements('reader', 'primary', { previewToken: preview.previewToken, candidateIds: preview.candidates.map((c) => c.id) })
    db.prepare('UPDATE web_book_supplements SET donor_provider_id = ?').run(providerId)
    await expect(service.readChapterWindow('reader', 'primary', { center: 1, before: 0, after: 0 }))
      .rejects.toMatchObject({ name: 'UnsupportedWebSourceError' })
    expect(hjProvider.fetchChapterText).not.toHaveBeenCalled()
    expect(generic.fetchChapterText).not.toHaveBeenCalled()
    db.close()
  })
})
