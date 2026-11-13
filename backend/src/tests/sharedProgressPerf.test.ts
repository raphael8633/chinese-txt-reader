import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

// Count chapter-name normalizations: each book's manifest must be normalized
// once per request, not once per cross-edition mapping.
const counter = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../services/web-source/crossSourceSupplement.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/web-source/crossSourceSupplement.js')>()
  return { ...real, normalizeChapterName: (name: string) => { counter.calls++; return real.normalizeChapterName(name) } }
})

import { initDb } from '../db.js'
import { buildApp } from '../app.js'

const CHAPTERS = 200
const web = (db: Database.Database, id: string, title: string) => {
  db.prepare(`INSERT INTO books (id,user_id,title,original_filename,file_size,char_count,source_type,manifest_version,created_at,updated_at)
     VALUES (?,'dev-user',?,'web',0,0,'web',1,'2026-01-01','2026-01-01')`).run(id, title)
  const insert = db.prepare(`INSERT INTO web_book_chapters (book_id,user_id,chapter_index,title,url,chapter_key,created_at)
    VALUES (?,'dev-user',?,?,?,?,'2026-01-01')`)
  for (let i = 0; i < CHAPTERS; i++) insert.run(id, i, `第${i + 1}章 標題${i}`, `https://${id}.test/${i}`, `${id}:${i}`)
}
const legacy = (db: Database.Database, id: string, position: number) => db.prepare(`INSERT INTO reading_progress
 (user_id,book_id,position_type,position_value,chapter_progress,chapter_offset,updated_at) VALUES ('dev-user',?,'chapter_index',?,0.25,4,'2026-01-02')`).run(id, position)

describe('shared progress manifest work per request', () => {
  let dir: string
  let db: Database.Database
  let app: ReturnType<typeof buildApp>
  let env: string | undefined
  beforeEach(() => {
    env = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    dir = mkdtempSync(join(tmpdir(), 'shared-progress-perf-'))
    db = initDb(join(dir, 'db.sqlite'))
    app = buildApp(db, join(dir, 'uploads'))
  })
  afterEach(async () => {
    await app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
    process.env.NODE_ENV = env
  })

  it('normalizes each book manifest at most once per GET /api/books (reconcile + projection)', async () => {
    // Anchored work with four editions plus a work that adopted a joining record.
    for (const id of ['a', 'b', 'c', 'd']) web(db, id, 'Same')
    for (const id of ['x', 'y']) web(db, id, 'Other')
    legacy(db, 'x', 3); legacy(db, 'y', 9)
    const workId = (await app.inject({ method: 'GET', url: '/api/books/a/shared-progress' })).json().workId
    await app.inject({ method: 'POST', url: '/api/books/a/shared-progress', payload: {
      positionType: 'chapter_index', positionValue: 5, manifestVersion: 1, expectedRevision: 0, expectedWorkId: workId } })
    legacy(db, 'b', 7) // a member's per-book record: never read after joining
    counter.calls = 0
    const list = await app.inject({ method: 'GET', url: '/api/books' })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toHaveLength(6)
    expect(counter.calls).toBeLessThanOrEqual(6 * CHAPTERS + 50)
  })
})
