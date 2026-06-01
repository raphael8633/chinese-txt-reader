import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import FormData from 'form-data'
import { buildApp } from '../app.js'
import { initDb } from '../db.js'
import type Database from 'better-sqlite3'

function makeTestEnv() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'raph-books-test-'))
  const dbPath = join(tmpDir, 'test.db')
  const uploadsDir = join(tmpDir, 'uploads')
  mkdirSync(uploadsDir, { recursive: true })
  const db = initDb(dbPath)
  return { tmpDir, db, uploadsDir }
}

function buildTestApp(db: Database.Database, uploadsDir: string, userId = 'dev-user') {
  process.env.NODE_ENV = 'development'
  return buildApp(db, uploadsDir)
}

async function uploadBook(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  content: string,
  filename = 'test.txt',
  title?: string,
  userId = 'dev-user',
) {
  const form = new FormData()
  form.append('file', Buffer.from(content, 'utf-8'), { filename, contentType: 'text/plain' })
  if (title) form.append('title', title)

  const headers: Record<string, string> = { ...form.getHeaders() }
  if (userId !== 'dev-user') {
    // Switch to production mode for different user
    headers['x-forwarded-user'] = userId
  }

  const env = process.env.NODE_ENV
  if (userId !== 'dev-user') process.env.NODE_ENV = 'production'

  const res = await app.inject({
    method: 'POST',
    url: '/api/books',
    payload: form,
    headers,
  })

  process.env.NODE_ENV = env
  return res
}

describe('Books API', () => {
  let tmpDir: string
  let db: Database.Database
  let uploadsDir: string
  let app: ReturnType<typeof buildTestApp>
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV
    const env = makeTestEnv()
    tmpDir = env.tmpDir
    db = env.db
    uploadsDir = env.uploadsDir
    app = buildTestApp(db, uploadsDir)
  })

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('POST /api/books', () => {
    it('happy path: uploads .txt file, returns 201 with correct fields', async () => {
      const content = '這是一本測試書。Hello world!'
      const form = new FormData()
      form.append('file', Buffer.from(content, 'utf-8'), {
        filename: 'my-book.txt',
        contentType: 'text/plain',
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body).toHaveProperty('id')
      expect(body.title).toBe('my-book')
      expect(body.charCount).toBe(content.length)
      expect(body.fileSize).toBe(Buffer.byteLength(content, 'utf-8'))
      expect(body.paragraphCount).toBe(1)
      expect(body.chapters).toEqual([])
      expect(body).toHaveProperty('createdAt')
    })

    it('uses provided title when title field is given', async () => {
      const form = new FormData()
      form.append('file', Buffer.from('content', 'utf-8'), {
        filename: 'file.txt',
        contentType: 'text/plain',
      })
      form.append('title', '我的書')

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })

      expect(res.statusCode).toBe(201)
      expect(res.json().title).toBe('我的書')
    })

    it('rejects request with no file part with 400', async () => {
      const form = new FormData()
      form.append('title', 'missing-file')

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })

      expect(res.statusCode).toBe(400)
    })

    it('trims whitespace from provided title', async () => {
      const form = new FormData()
      form.append('file', Buffer.from('content', 'utf-8'), {
        filename: 'file.txt',
        contentType: 'text/plain',
      })
      form.append('title', '  padded title  ')

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })

      expect(res.statusCode).toBe(201)
      expect(res.json().title).toBe('padded title')
    })

    it('rejects non-.txt file with 400', async () => {
      const form = new FormData()
      form.append('file', Buffer.from('not text'), {
        filename: 'book.pdf',
        contentType: 'application/pdf',
      })

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })

      expect(res.statusCode).toBe(400)
    })

    it('rejects oversized file with 413', async () => {
      // Build a small-limit app for this test
      const smallLimitApp = buildApp(db, uploadsDir, { fileSizeLimit: 100 })
      const form = new FormData()
      form.append('file', Buffer.from('x'.repeat(200), 'utf-8'), {
        filename: 'big.txt',
        contentType: 'text/plain',
      })

      const res = await smallLimitApp.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })

      expect(res.statusCode).toBe(413)
    })
  })

  describe('GET /api/books', () => {
    it('returns empty array for new user', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    })

    it('returns uploaded book after upload', async () => {
      const form = new FormData()
      form.append('file', Buffer.from('內容', 'utf-8'), {
        filename: 'novel.txt',
        contentType: 'text/plain',
      })
      await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })

      const res = await app.inject({ method: 'GET', url: '/api/books' })
      expect(res.statusCode).toBe(200)
      const books = res.json()
      expect(books).toHaveLength(1)
      expect(books[0]).toHaveProperty('id')
      expect(books[0].title).toBe('novel')
      expect(books[0]).toHaveProperty('charCount')
      expect(books[0]).toHaveProperty('fileSize')
      expect(books[0].paragraphCount).toBe(1)
      expect(books[0].chapters).toEqual([])
      expect(books[0]).toHaveProperty('createdAt')
      expect(books[0]).toHaveProperty('updatedAt')
      expect(books[0].progress).toBeNull()
    })

    it('returns paragraph count and detected chapter metadata', async () => {
      await uploadBook(app, '第一章 開始\n內容\n第二章 繼續\n內容', 'chapters.txt')

      const res = await app.inject({ method: 'GET', url: '/api/books' })
      expect(res.statusCode).toBe(200)
      const books = res.json()
      expect(books[0].paragraphCount).toBe(4)
      expect(books[0].chapters).toEqual([
        { index: 0, title: '第一章 開始' },
        { index: 2, title: '第二章 繼續' },
      ])
    })

    it('counts hard-wrapped narrative as a single paragraph while preserving chapters', async () => {
      await uploadBook(app, '第一章 開始\n這是被原檔\n硬換行的敘事。\n第二章 繼續\n下一段內容', 'wrapped.txt')

      const res = await app.inject({ method: 'GET', url: '/api/books' })
      expect(res.statusCode).toBe(200)
      const books = res.json()
      expect(books[0].paragraphCount).toBe(4)
      expect(books[0].chapters).toEqual([
        { index: 0, title: '第一章 開始' },
        { index: 2, title: '第二章 繼續' },
      ])
    })

    it('includes latest reading progress without fetching content separately', async () => {
      const uploadRes = await uploadBook(app, '第一段\n第二段\n第三段', 'novel.txt')
      const { id } = uploadRes.json()

      const progressRes = await app.inject({
        method: 'POST',
        url: `/api/books/${id}/progress`,
        payload: { positionType: 'paragraph_index', positionValue: 2 },
      })
      expect(progressRes.statusCode).toBe(200)

      const res = await app.inject({ method: 'GET', url: '/api/books' })
      expect(res.statusCode).toBe(200)
      const books = res.json()
      expect(books[0].progress).toMatchObject({
        positionType: 'paragraph_index',
        positionValue: 2,
        pageIndex: null,
      })
      expect(books[0].progress.updatedAt).toEqual(expect.any(String))
    })
  })

  describe('GET /api/books/:id/content', () => {
    it('returns correct UTF-8 text after upload', async () => {
      const content = '這是書的內容'
      const form = new FormData()
      form.append('file', Buffer.from(content, 'utf-8'), {
        filename: 'story.txt',
        contentType: 'text/plain',
      })
      const uploadRes = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })
      const { id } = uploadRes.json()

      const res = await app.inject({ method: 'GET', url: `/api/books/${id}/content` })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/plain')
      expect(res.body).toBe(content)
    })

    it('returns 404 for book owned by different user', async () => {
      // Upload as dev-user
      const form = new FormData()
      form.append('file', Buffer.from('secret', 'utf-8'), {
        filename: 'private.txt',
        contentType: 'text/plain',
      })
      const uploadRes = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })
      const { id } = uploadRes.json()

      // Try to access as different user (alice)
      const savedEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      const res = await app.inject({
        method: 'GET',
        url: `/api/books/${id}/content`,
        headers: { 'x-forwarded-user': 'alice' },
      })
      process.env.NODE_ENV = savedEnv

      expect(res.statusCode).toBe(404)
    })
  })

  describe('PATCH /api/books/:id', () => {
    it('renames book and returns updated record', async () => {
      const form = new FormData()
      form.append('file', Buffer.from('test content', 'utf-8'), {
        filename: 'old-name.txt',
        contentType: 'text/plain',
      })
      const uploadRes = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })
      const { id } = uploadRes.json()

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/books/${id}`,
        payload: { title: '新書名' },
        headers: { 'content-type': 'application/json' },
      })

      expect(patchRes.statusCode).toBe(200)
      const body = patchRes.json()
      expect(body.id).toBe(id)
      expect(body.title).toBe('新書名')
      expect(body).toHaveProperty('updatedAt')
    })

    it('rejects whitespace-only title with 400', async () => {
      const uploadRes = await uploadBook(app, 'test content', 'book.txt')
      const { id } = uploadRes.json()

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/books/${id}`,
        payload: { title: '   ' },
        headers: { 'content-type': 'application/json' },
      })

      expect(res.statusCode).toBe(400)
    })

    it('trims whitespace from title on rename', async () => {
      const uploadRes = await uploadBook(app, 'test content', 'book.txt')
      const { id } = uploadRes.json()

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/books/${id}`,
        payload: { title: '  新書名  ' },
        headers: { 'content-type': 'application/json' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().title).toBe('新書名')
    })

    it('returns 404 when patching another user\'s book', async () => {
      const form = new FormData()
      form.append('file', Buffer.from('content', 'utf-8'), {
        filename: 'book.txt',
        contentType: 'text/plain',
      })
      const uploadRes = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: form,
        headers: form.getHeaders(),
      })
      const { id } = uploadRes.json()

      const savedEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/books/${id}`,
        payload: { title: 'hacked' },
        headers: {
          'content-type': 'application/json',
          'x-forwarded-user': 'mallory',
        },
      })
      process.env.NODE_ENV = savedEnv

      expect(res.statusCode).toBe(404)
    })
  })

  describe('GET /api/books sort order', () => {
    it('sorts books: most recently read first, unread by upload time', async () => {
      const res1 = await uploadBook(app, '書一', 'book1.txt')
      const id1 = res1.json().id
      const res2 = await uploadBook(app, '書二', 'book2.txt')
      const id2 = res2.json().id
      const res3 = await uploadBook(app, '書三', 'book3.txt')
      const id3 = res3.json().id

      // Set book3 as most recently read, book1 as less recently read
      db.prepare(
        `INSERT INTO reading_progress (user_id, book_id, position_type, position_value, updated_at)
         VALUES ('dev-user', ?, 'chapter_index', 0, ?)`,
      ).run(id3, '2026-05-17T12:00:00Z')
      db.prepare(
        `INSERT INTO reading_progress (user_id, book_id, position_type, position_value, updated_at)
         VALUES ('dev-user', ?, 'chapter_index', 0, ?)`,
      ).run(id1, '2026-05-17T10:00:00Z')
      // book2 has no progress

      const listRes = await app.inject({ method: 'GET', url: '/api/books' })
      expect(listRes.statusCode).toBe(200)
      const books = listRes.json()
      expect(books).toHaveLength(3)
      expect(books[0].id).toBe(id3)
      expect(books[1].id).toBe(id1)
      expect(books[2].id).toBe(id2)
    })
  })

  describe('DELETE /api/books/:id', () => {
    it('deletes book, progress, settings, and content', async () => {
      const uploadRes = await uploadBook(app, 'test content', 'delete-me.txt')
      const { id } = uploadRes.json()
      await app.inject({
        method: 'POST',
        url: `/api/books/${id}/progress`,
        payload: { positionType: 'paragraph_index', positionValue: 2 },
      })
      await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: id,
          fontSizePx: 20,
          lineHeight: 1.8,
          letterSpacingPx: 0,
          textColor: '#fff',
          backgroundColor: '#000',
          readingMode: 'scroll',
        },
      })

      const deleteRes = await app.inject({ method: 'DELETE', url: `/api/books/${id}` })

      expect(deleteRes.statusCode).toBe(200)
      expect(deleteRes.json()).toEqual({ ok: true })
      expect((await app.inject({ method: 'GET', url: '/api/books' })).json()).toEqual([])
      expect((await app.inject({ method: 'GET', url: `/api/books/${id}/content` })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `/api/books/${id}/progress` })).json()).toBe(null)
    })

    it('returns 404 when deleting another user\'s book', async () => {
      const uploadRes = await uploadBook(app, 'private content', 'private.txt')
      const { id } = uploadRes.json()

      const savedEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/books/${id}`,
        headers: { 'x-forwarded-user': 'mallory' },
      })
      process.env.NODE_ENV = savedEnv

      expect(res.statusCode).toBe(404)
    })
  })
})
