import { describe, it, expect, afterEach } from 'vitest'
import { initDb } from '../db.js'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('SQLite initialization', () => {
  let tmpDir: string
  let dbPath: string

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates books, reader_settings, and reading_progress tables', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-test-'))
    dbPath = join(tmpDir, 'test.db')
    const db = initDb(dbPath)

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[]

    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toContain('books')
    expect(tableNames).toContain('reader_settings')
    expect(tableNames).toContain('reading_progress')

    db.close()
  })

  it('creates reader settings display option columns', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-test-'))
    dbPath = join(tmpDir, 'test.db')
    const db = initDb(dbPath)
    const columns = db.prepare('PRAGMA table_info(reader_settings)').all() as { name: string }[]
    const columnNames = columns.map((column) => column.name)

    expect(columnNames).toContain('hard_wrap_mode')
    expect(columnNames).toContain('chinese_conversion')

    db.close()
  })

  it('migrates legacy books size_bytes column to file_size', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-test-'))
    dbPath = join(tmpDir, 'test.db')
    const legacyDb = new Database(dbPath)

    legacyDb.prepare(`
      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        detected_encoding TEXT,
        selected_encoding TEXT,
        normalized_text_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run()
    legacyDb.close()

    const db = initDb(dbPath)
    const columns = db.prepare('PRAGMA table_info(books)').all() as { name: string }[]
    const columnNames = columns.map((column) => column.name)

    expect(columnNames).toContain('file_size')
    expect(columnNames).toContain('char_count')
    expect(columnNames).toContain('paragraph_count')
    expect(columnNames).toContain('chapters_json')
    expect(columnNames).not.toContain('size_bytes')

    db.close()
  })
})
