import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildApp } from '../app.js'
import { initDb } from '../db.js'
import type Database from 'better-sqlite3'

function makeTestEnv() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'raph-sync-test-'))
  const dbPath = join(tmpDir, 'test.db')
  const uploadsDir = join(tmpDir, 'uploads')
  mkdirSync(uploadsDir, { recursive: true })
  const db = initDb(dbPath)
  return { tmpDir, db, uploadsDir }
}

function buildTestApp(db: Database.Database, uploadsDir: string) {
  process.env.NODE_ENV = 'development'
  return buildApp(db, uploadsDir)
}

describe('Sync API', () => {
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

  describe('Progress', () => {
    it('GET /api/books/b1/progress → null when no progress exists', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books/b1/progress' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toBe(null)
    })

    it('POST /api/books/b1/progress with valid body → 200', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/books/b1/progress',
        payload: { positionType: 'paragraph_index', positionValue: 42 },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
    })

    it('GET /api/books/b1/progress after POST returns saved values', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/books/b1/progress',
        payload: { positionType: 'paragraph_index', positionValue: 42 },
        headers: { 'content-type': 'application/json' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/books/b1/progress' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.positionType).toBe('paragraph_index')
      expect(body.positionValue).toBe(42)
    })

    it('two consecutive POSTs upsert — GET returns second value', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/books/b1/progress',
        payload: { positionType: 'paragraph_index', positionValue: 42 },
        headers: { 'content-type': 'application/json' },
      })
      await app.inject({
        method: 'POST',
        url: '/api/books/b1/progress',
        payload: { positionType: 'paragraph_index', positionValue: 50 },
        headers: { 'content-type': 'application/json' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/books/b1/progress' })
      expect(res.statusCode).toBe(200)
      expect(res.json().positionValue).toBe(50)
    })

    it('POST with missing positionValue → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/books/b1/progress',
        payload: { positionType: 'paragraph_index' },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('Settings', () => {
    it('GET /api/settings → 200 with hardcoded defaults when nothing saved', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/settings' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.fontSizePx).toBe(18)
      expect(body.textColor).toBe('#333333')
      expect(body.hardWrapMode).toBe('auto')
      expect(body.chineseConversion).toBe('none')
    })

    it('POST /api/settings with full valid payload → 200', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 22,
          lineHeight: 2.0,
          letterSpacingPx: 1,
          textColor: '#222222',
          backgroundColor: '#ffffff',
          readingMode: 'scroll',
          hardWrapMode: 'preserve',
          chineseConversion: 'traditional',
        },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
    })

    it('two consecutive POST /api/settings upsert — GET returns latest value', async () => {
      const base = {
        bookId: null,
        fontSizePx: 22,
        lineHeight: 2.0,
        letterSpacingPx: 1,
        textColor: '#222222',
        backgroundColor: '#ffffff',
        readingMode: 'scroll',
      }
      await app.inject({
        method: 'POST', url: '/api/settings',
        payload: base,
        headers: { 'content-type': 'application/json' },
      })
      await app.inject({
        method: 'POST', url: '/api/settings',
        payload: { ...base, fontSizePx: 24 },
        headers: { 'content-type': 'application/json' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/settings' })
      expect(res.statusCode).toBe(200)
      expect(res.json().fontSizePx).toBe(24)
    })

    it('GET /api/settings after POST returns saved fontSizePx: 22', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 22,
          lineHeight: 2.0,
          letterSpacingPx: 1,
          textColor: '#222222',
          backgroundColor: '#ffffff',
          readingMode: 'scroll',
        },
        headers: { 'content-type': 'application/json' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/settings' })
      expect(res.statusCode).toBe(200)
      expect(res.json().fontSizePx).toBe(22)
      expect(res.json().hardWrapMode).toBe('auto')
      expect(res.json().chineseConversion).toBe('none')
    })

    it('GET /api/settings?bookId=b1 with no book override falls back to global', async () => {
      // Save global settings first
      await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 22,
          lineHeight: 2.0,
          letterSpacingPx: 1,
          textColor: '#222222',
          backgroundColor: '#ffffff',
          readingMode: 'scroll',
        },
        headers: { 'content-type': 'application/json' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/settings?bookId=b1' })
      expect(res.statusCode).toBe(200)
      expect(res.json().fontSizePx).toBe(22)
    })

    it('POST with bookId=b1 then GET?bookId=b1 returns book-specific fontSizePx: 30', async () => {
      // Save global
      await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 22,
          lineHeight: 2.0,
          letterSpacingPx: 1,
          textColor: '#222222',
          backgroundColor: '#ffffff',
          readingMode: 'scroll',
        },
        headers: { 'content-type': 'application/json' },
      })
      // Save book-specific
      await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: 'b1',
          fontSizePx: 30,
          lineHeight: 2.0,
          letterSpacingPx: 1,
          textColor: '#222222',
          backgroundColor: '#ffffff',
          readingMode: 'scroll',
        },
        headers: { 'content-type': 'application/json' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/settings?bookId=b1' })
      expect(res.statusCode).toBe(200)
      expect(res.json().fontSizePx).toBe(30)
    })

    it('POST with invalid toolbarSide → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 18,
          lineHeight: 1.6,
          letterSpacingPx: 0,
          textColor: '#333333',
          backgroundColor: '#f5f5f0',
          readingMode: 'scroll',
          toolbarSide: 'center',
        },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('POST with invalid hardWrapMode → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 18,
          lineHeight: 1.6,
          letterSpacingPx: 0,
          textColor: '#333333',
          backgroundColor: '#f5f5f0',
          readingMode: 'scroll',
          hardWrapMode: 'unknown',
        },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('POST with invalid chineseConversion → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 18,
          lineHeight: 1.6,
          letterSpacingPx: 0,
          textColor: '#333333',
          backgroundColor: '#f5f5f0',
          readingMode: 'scroll',
          chineseConversion: 'both',
        },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/chineseConversion/)
    })

    it('POST /api/settings with fontWeight out of range → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 18,
          lineHeight: 1.8,
          letterSpacingPx: 0,
          textColor: '#333333',
          backgroundColor: '#f5f0e8',
          readingMode: 'scroll',
          fontWeight: 50,
        },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/fontWeight/)
    })

    it('POST /api/settings with fontWeight not a multiple of 100 → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 18,
          lineHeight: 1.8,
          letterSpacingPx: 0,
          textColor: '#333333',
          backgroundColor: '#f5f0e8',
          readingMode: 'scroll',
          fontWeight: 450,
        },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/fontWeight/)
    })

    it('POST /api/settings with new fields returns them in GET', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 18,
          lineHeight: 1.8,
          letterSpacingPx: 0,
          textColor: '#333333',
          backgroundColor: '#f5f0e8',
          readingMode: 'scroll',
          paddingTop: 15,
          fontWeight: 700,
          justifyText: false,
        },
        headers: { 'content-type': 'application/json' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/settings' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.paddingTop).toBe(15)
      expect(body.fontWeight).toBe(700)
      expect(body.justifyText).toBe(false)
    })

    it('GET /api/settings returns new fields with defaults when nothing saved', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/settings' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.paddingTop).toBe(9)
      expect(body.paddingBottom).toBe(8)
      expect(body.annotationMarginTop).toBe(20)
      expect(body.annotationMarginBottom).toBe(0)
      expect(body.marginLeft).toBe(16)
      expect(body.marginRight).toBe(16)
      expect(body.paragraphSpacing).toBe(7)
      expect(body.paragraphIndent).toBe(1)
      expect(body.fontWeight).toBe(400)
      expect(body.justifyText).toBe(true)
      expect(body.chineseConversion).toBe('none')
    })

    it('POST /api/settings with non-finite paddingTop → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          bookId: null,
          fontSizePx: 18,
          lineHeight: 1.8,
          letterSpacingPx: 0,
          textColor: '#333333',
          backgroundColor: '#f5f0e8',
          readingMode: 'scroll',
          paddingTop: 'abc',
        },
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/paddingTop/)
    })
  })
})
