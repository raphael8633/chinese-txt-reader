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

  it('adds chapter anchors to a legacy database without losing saved progress', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-legacy-progress-'))
    dbPath = join(tmpDir, 'test.db')
    const legacy = new Database(dbPath)
    legacy.exec(`CREATE TABLE reading_progress (
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, book_id TEXT NOT NULL,
      position_type TEXT NOT NULL, position_value INTEGER NOT NULL, page_index INTEGER,
      updated_at TEXT NOT NULL, UNIQUE(user_id, book_id));
      INSERT INTO reading_progress VALUES (1, 'reader', 'book', 'chapter_index', 7, NULL, '2026-01-01')`)
    legacy.close()
    const db = initDb(dbPath)
    expect(db.prepare('SELECT * FROM reading_progress').get()).toMatchObject({
      position_value: 7, chapter_offset: null, chapter_progress: null,
    })
    db.close()
    const reopened = initDb(dbPath)
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM reading_progress').get()).toEqual({ n: 1 })
    reopened.close()
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

  it('preserves distinct legacy positions across additive work-schema initialization and reopen', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-work-'))
    dbPath = join(tmpDir, 'test.db')
    const first = initDb(dbPath)
    for (const id of ['a', 'b']) {
      first.prepare(`INSERT INTO books (id,user_id,title,original_filename,file_size,char_count,source_type,created_at,updated_at)
        VALUES (?, 'u', ' Same  Title ', 'web', 0, 0, 'web', 'now', 'now')`).run(id)
      first.prepare(`INSERT INTO reading_progress (user_id,book_id,position_type,position_value,chapter_offset,chapter_progress,updated_at)
        VALUES ('u',?,'chapter_index',?,4,0.25,'now')`).run(id, id === 'a' ? 0 : 1)
    }
    const before = first.prepare('SELECT * FROM reading_progress ORDER BY book_id').all()
    first.close()
    const db = initDb(dbPath)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'reading_works'").get()).toBeDefined()
    expect(db.prepare('SELECT * FROM reading_progress ORDER BY book_id').all()).toEqual(before)
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
    const reopened = initDb(dbPath)
    expect(reopened.prepare('SELECT * FROM reading_progress ORDER BY book_id').all()).toEqual(before)
    reopened.close()
  })

  it('creates reader settings display option columns', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-test-'))
    dbPath = join(tmpDir, 'test.db')
    const db = initDb(dbPath)
    const columns = db.prepare('PRAGMA table_info(reader_settings)').all() as { name: string }[]
    const columnNames = columns.map((column) => column.name)

    expect(columnNames).toContain('hard_wrap_mode')
    expect(columnNames).toContain('chinese_conversion')
    expect(columnNames).toContain('content_filters_json')

    db.close()
  })

  it('creates idx_books_user index on books(user_id)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-test-'))
    dbPath = join(tmpDir, 'test.db')
    const db = initDb(dbPath)

    const indexes = db.prepare(`PRAGMA index_list(books)`).all() as { name: string }[]
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_books_user')

    db.close()
  })

  it('creates web source metadata and chapter table', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-test-'))
    dbPath = join(tmpDir, 'test.db')
    const db = initDb(dbPath)

    const bookColumns = db.prepare('PRAGMA table_info(books)').all() as { name: string }[]
    const bookColumnNames = bookColumns.map((column) => column.name)
    expect(bookColumnNames).toContain('source_type')
    expect(bookColumnNames).toContain('source_url')
    expect(bookColumnNames).toContain('provider_id')
    expect(bookColumnNames).toContain('manifest_version')

    const chapterColumns = db.prepare('PRAGMA table_info(web_book_chapters)').all() as { name: string }[]
    const chapterColumnNames = chapterColumns.map((column) => column.name)
    expect(chapterColumnNames).toEqual([
      'book_id',
      'user_id',
      'chapter_index',
      'title',
      'url',
      'chapter_key',
      'created_at',
    ])

    db.close()
  })

  it('creates the persistent web source chapter content cache', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-web-cache-test-'))
    dbPath = join(tmpDir, 'test.db')
    const db = initDb(dbPath)

    const columns = db.prepare(
      'PRAGMA table_info(web_source_chapter_cache)',
    ).all() as Array<{ name: string; pk: number }>
    expect(columns.map((column) => column.name)).toEqual([
      'book_id',
      'user_id',
      'source_url',
      'text',
      'content_hash',
      'fetched_at',
    ])
    expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
      'book_id',
      'source_url',
    ])

    const indexes = db.prepare(
      'PRAGMA index_list(web_source_chapter_cache)',
    ).all() as Array<{ name: string }>
    expect(indexes.map((index) => index.name)).toContain('idx_web_source_chapter_cache_book')

    db.close()
  })

  it('creates the cross-source supplement table idempotently without nullable sentinels', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-web-supplement-test-'))
    dbPath = join(tmpDir, 'test.db')
    const first = initDb(dbPath)
    first.prepare(
      `INSERT INTO books (id, user_id, title, original_filename, file_size, char_count, source_type, created_at, updated_at)
       VALUES ('b', 'u', 't', 'web:x', 0, 0, 'web', 'now', 'now')`,
    ).run()
    first.prepare(
      `INSERT INTO web_book_supplements (
         id, book_id, user_id, batch_id, seq, donor_book_id, donor_provider_id, url, chapter_key, title,
         anchor_after_key, anchor_after_title, anchor_before_key, anchor_before_title, created_at
       ) VALUES ('s', 'b', 'u', 'batch', 0, 'd', 'cz', 'https://cz.test/1', 'cz:1', '第1章', 'a', 'A', 'b', 'B', 'now')`,
    ).run()
    first.close()

    const db = initDb(dbPath)
    const reopened = initDb(dbPath)
    reopened.close()
    const columns = db.prepare('PRAGMA table_info(web_book_supplements)').all() as Array<{
      name: string; notnull: number; pk: number
    }>
    expect(columns.map((column) => column.name)).toEqual([
      'id', 'book_id', 'user_id', 'batch_id', 'seq', 'donor_book_id', 'donor_provider_id', 'url', 'chapter_key',
      'title', 'anchor_after_key', 'anchor_after_title', 'anchor_before_key', 'anchor_before_title', 'status',
      'status_reason', 'created_at',
    ])
    expect(columns.filter((column) => column.pk === 0 && column.notnull !== 1)).toEqual([])
    expect(db.prepare('SELECT status, status_reason FROM web_book_supplements').get())
      .toEqual({ status: 'active', status_reason: '' })
    db.prepare(`DELETE FROM books WHERE id = 'b'`).run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM web_book_supplements').get()).toEqual({ n: 0 })
    db.close()
  })

  it('migrates legacy web source identity columns and backfills existing rows', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-web-identity-test-'))
    dbPath = join(tmpDir, 'test.db')
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE books (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        char_count INTEGER NOT NULL,
        paragraph_count INTEGER NOT NULL DEFAULT 0,
        chapters_json TEXT NOT NULL DEFAULT '[]',
        detected_encoding TEXT,
        selected_encoding TEXT,
        normalized_text_hash TEXT,
        source_type TEXT NOT NULL DEFAULT 'txt',
        source_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE web_book_chapters (
        book_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(book_id, chapter_index)
      );
      INSERT INTO books (
        id, user_id, title, original_filename, file_size, char_count,
        paragraph_count, chapters_json, source_type, source_url, created_at, updated_at
      ) VALUES (
        'web-1', 'dev-user', '舊線上書', 'web:example.test', 0, 0, 1, '[]',
        'web', 'https://example.test/dir', '2026-01-01', '2026-01-01'
      );
      INSERT INTO web_book_chapters (
        book_id, user_id, chapter_index, title, url, created_at
      ) VALUES (
        'web-1', 'dev-user', 0, '第一章',
        'https://example.test/chapter/1', '2026-01-01'
      );
    `)
    legacyDb.close()

    const db = initDb(dbPath)
    const book = db.prepare(
      'SELECT manifest_version FROM books WHERE id = ?',
    ).get('web-1') as { manifest_version: number }
    const chapter = db.prepare(
      'SELECT chapter_key FROM web_book_chapters WHERE book_id = ?',
    ).get('web-1') as { chapter_key: string }

    expect(book.manifest_version).toBe(1)
    expect(chapter.chapter_key).toBe('https://example.test/chapter/1')
    const bookColumns = db.prepare('PRAGMA table_info(books)').all() as { name: string }[]
    const bookColumnNames = bookColumns.map((column) => column.name)
    expect(bookColumnNames).not.toContain('detected_encoding')
    expect(bookColumnNames).not.toContain('selected_encoding')
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
    expect(columnNames).toContain('provider_id')
    expect(columnNames).not.toContain('size_bytes')
    // Dead since upload never wrote them and no override UI shipped.
    expect(columnNames).not.toContain('detected_encoding')
    expect(columnNames).not.toContain('selected_encoding')

    db.close()
  })

  it('drops legacy network_import tables and never recreates them', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raph-reader-network-import-drop-test-'))
    dbPath = join(tmpDir, 'test.db')
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE network_import_batches (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        query_title TEXT NOT NULL,
        candidate_cap INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE network_import_candidates (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES network_import_batches(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_candidates_batch ON network_import_candidates(batch_id);
      INSERT INTO network_import_batches (id, user_id, query_title, candidate_cap, created_at)
        VALUES ('batch-1', 'raph', '某書', 8, '2026-06-14');
      INSERT INTO network_import_candidates (id, batch_id, provider_id, source_url, source_title, created_at)
        VALUES ('cand-1', 'batch-1', 'freexiaoshuo', 'https://example.test/x', '某書', '2026-06-14');
    `)
    legacyDb.close()

    const db = initDb(dbPath)
    const leftovers = db
      .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'network_import%' OR name = 'idx_candidates_batch'`)
      .all() as { name: string }[]

    expect(leftovers).toEqual([])

    // A second run must stay idempotent (DROP TABLE IF EXISTS).
    db.close()
    const reopened = initDb(dbPath)
    expect(
      reopened
        .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'network_import%'`)
        .all(),
    ).toEqual([])
    reopened.close()
  })
})
