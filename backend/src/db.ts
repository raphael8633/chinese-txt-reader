import Database from 'better-sqlite3'

export function initDb(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  // web_source_chapter_cache cleanup relies on ON DELETE CASCADE; pin FK
  // enforcement instead of trusting better-sqlite3's compile-time default.
  db.pragma('foreign_keys = ON')

  const schema = [
    `CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      char_count INTEGER NOT NULL,
      paragraph_count INTEGER NOT NULL DEFAULT 0,
      chapters_json TEXT NOT NULL DEFAULT '[]',
      normalized_text_hash TEXT,
      source_type TEXT NOT NULL DEFAULT 'txt',
      source_url TEXT,
      provider_id TEXT,
      manifest_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS reader_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      book_id TEXT,
      font_size_px INTEGER NOT NULL DEFAULT 18,
      line_height REAL NOT NULL DEFAULT 1.8,
      letter_spacing_px REAL NOT NULL DEFAULT 0,
      text_color TEXT NOT NULL DEFAULT '#333333',
      background_color TEXT NOT NULL DEFAULT '#f5f0e8',
      reading_mode TEXT NOT NULL DEFAULT 'scroll',
      toolbar_side TEXT NOT NULL DEFAULT 'right',
      hard_wrap_mode TEXT NOT NULL DEFAULT 'auto',
      chinese_conversion TEXT NOT NULL DEFAULT 'none',
      content_filters_json TEXT NOT NULL DEFAULT '[]',
      padding_top REAL NOT NULL DEFAULT 9,
      padding_bottom REAL NOT NULL DEFAULT 8,
      annotation_margin_top REAL NOT NULL DEFAULT 20,
      annotation_margin_bottom REAL NOT NULL DEFAULT 0,
      margin_left REAL NOT NULL DEFAULT 16,
      margin_right REAL NOT NULL DEFAULT 16,
      paragraph_spacing REAL NOT NULL DEFAULT 7,
      paragraph_indent REAL NOT NULL DEFAULT 1,
      font_weight INTEGER NOT NULL DEFAULT 400,
      justify_text INTEGER NOT NULL DEFAULT 1,
      UNIQUE(user_id, book_id)
    )`,
    `CREATE TABLE IF NOT EXISTS reading_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      position_type TEXT NOT NULL DEFAULT 'chunk_offset',
      position_value INTEGER NOT NULL DEFAULT 0,
      page_index INTEGER,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, book_id)
    )`,
    `CREATE TABLE IF NOT EXISTS web_book_chapters (
      book_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      chapter_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      chapter_key TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(book_id, chapter_index)
    )`,
  ]

  for (const stmt of schema) {
    db.prepare(stmt).run()
  }

  migrateProgressTable(db)
  migrateBooksTable(db)
  migrateWebSourceTables(db)
  migrateReaderSettingsTable(db)
  dropNetworkImportTables(db)
  // Existing books are migrated before these FKs are introduced. User-specific
  // membership is reconciled lazily on authenticated reads, never at startup.
  db.exec(`CREATE TABLE IF NOT EXISTS reading_works (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title_key TEXT NOT NULL,
    preferred_book_id TEXT,
    preferred_manual INTEGER NOT NULL DEFAULT 0,
    supplement_book_id TEXT,
    anchor_book_id TEXT,
    anchor_manifest_version INTEGER,
    chapter_index INTEGER,
    chapter_title TEXT,
    chapter_progress REAL,
    chapter_offset INTEGER,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    UNIQUE(user_id, title_key)
  );
  CREATE TABLE IF NOT EXISTS reading_work_members (
    user_id TEXT NOT NULL,
    work_id TEXT NOT NULL REFERENCES reading_works(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    legacy_seen_updated_at TEXT,
    legacy_seen_signature TEXT,
    legacy_surfaced_signature TEXT,
    PRIMARY KEY(user_id, book_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reading_work_members_work ON reading_work_members(user_id, work_id);`)
  const workColumns = new Set((db.prepare('PRAGMA table_info(reading_works)').all() as {name:string}[]).map(c => c.name))
  // The former default was the oldest edition, so only a preference that differs
  // from it is provably manual; a default-equal one stays eligible for ranking.
  if (!workColumns.has('preferred_manual')) {
    db.prepare('ALTER TABLE reading_works ADD COLUMN preferred_manual INTEGER NOT NULL DEFAULT 0').run()
    db.prepare(`UPDATE reading_works SET preferred_manual=1 WHERE preferred_book_id IS NOT NULL
      AND preferred_book_id <> (SELECT b.id FROM reading_work_members m JOIN books b ON b.id=m.book_id AND b.user_id=m.user_id
        WHERE m.work_id=reading_works.id AND m.user_id=reading_works.user_id ORDER BY b.created_at,b.id LIMIT 1)`).run()
  }
  // 補章's target web edition; before a TXT could be preferred it was always the preferred edition.
  if (!workColumns.has('supplement_book_id')) {
    db.prepare('ALTER TABLE reading_works ADD COLUMN supplement_book_id TEXT').run()
    db.prepare('UPDATE reading_works SET supplement_book_id=preferred_book_id WHERE supplement_book_id IS NULL').run()
  }
  // The legacy_* member columns are neither read nor written; they stay so no migration drops data.
  const memberColumns = new Set((db.prepare('PRAGMA table_info(reading_work_members)').all() as {name:string}[]).map(c => c.name))
  if (!memberColumns.has('legacy_seen_signature')) db.prepare('ALTER TABLE reading_work_members ADD COLUMN legacy_seen_signature TEXT').run()
  if (!memberColumns.has('legacy_surfaced_signature')) db.prepare('ALTER TABLE reading_work_members ADD COLUMN legacy_surfaced_signature TEXT').run()

  return db
}

// 2026-09-04: the network-import pipeline was removed (1 preview batch ever, 0
// adopted; the generic web-source provider covers the fallback it existed for).
// Drop the child table first — foreign_keys is ON.
function dropNetworkImportTables(db: Database.Database): void {
  db.prepare('DROP TABLE IF EXISTS network_import_candidates').run()
  db.prepare('DROP TABLE IF EXISTS network_import_batches').run()
}

function migrateBooksTable(db: Database.Database): void {
  db.prepare('CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id)').run()

  const columns = db.prepare('PRAGMA table_info(books)').all() as { name: string }[]
  const columnNames = new Set(columns.map((column) => column.name))

  if (!columnNames.has('file_size') && columnNames.has('size_bytes')) {
    db.prepare('ALTER TABLE books RENAME COLUMN size_bytes TO file_size').run()
    columnNames.add('file_size')
  }

  if (!columnNames.has('char_count')) {
    db.prepare('ALTER TABLE books ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0').run()
  }

  if (!columnNames.has('paragraph_count')) {
    db.prepare('ALTER TABLE books ADD COLUMN paragraph_count INTEGER NOT NULL DEFAULT 0').run()
  }

  if (!columnNames.has('chapters_json')) {
    db.prepare(`ALTER TABLE books ADD COLUMN chapters_json TEXT NOT NULL DEFAULT '[]'`).run()
  }

  if (!columnNames.has('source_type')) {
    db.prepare(`ALTER TABLE books ADD COLUMN source_type TEXT NOT NULL DEFAULT 'txt'`).run()
  }

  if (!columnNames.has('source_url')) {
    db.prepare(`ALTER TABLE books ADD COLUMN source_url TEXT`).run()
  }

  if (!columnNames.has('provider_id')) {
    db.prepare(`ALTER TABLE books ADD COLUMN provider_id TEXT`).run()
  }

  if (!columnNames.has('manifest_version')) {
    db.prepare(`ALTER TABLE books ADD COLUMN manifest_version INTEGER NOT NULL DEFAULT 0`).run()
  }
  db.prepare(`UPDATE books SET manifest_version = 1 WHERE source_type = 'web' AND manifest_version = 0`).run()

  // 2026-09-04: never written (all NULL in production) and no override UI ever
  // shipped — automatic detection in utils/encoding.ts is the whole story.
  // better-sqlite3 bundles SQLite 3.49, well past the 3.35 DROP COLUMN floor.
  if (columnNames.has('detected_encoding')) {
    db.prepare('ALTER TABLE books DROP COLUMN detected_encoding').run()
  }
  if (columnNames.has('selected_encoding')) {
    db.prepare('ALTER TABLE books DROP COLUMN selected_encoding').run()
  }
}

function migrateWebSourceTables(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(web_book_chapters)').all() as { name: string }[]
  const columnNames = new Set(columns.map((column) => column.name))

  if (!columnNames.has('chapter_key')) {
    db.prepare(`ALTER TABLE web_book_chapters ADD COLUMN chapter_key TEXT`).run()
  }
  db.prepare(
    `UPDATE web_book_chapters
     SET chapter_key = url
     WHERE chapter_key IS NULL OR chapter_key = ''`,
  ).run()

  db.prepare(`CREATE TABLE IF NOT EXISTS web_source_chapter_cache (
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY(book_id, source_url)
  )`).run()
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_web_source_chapter_cache_book ON web_source_chapter_cache(book_id)',
  ).run()

  // Cross-source supplements are the source of truth for chapters spliced into a
  // primary manifest from a same-title sibling book; refresh re-merges them. Every
  // column is NOT NULL (no NULL sentinels, see M-003).
  db.prepare(`CREATE TABLE IF NOT EXISTS web_book_supplements (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    donor_book_id TEXT NOT NULL,
    donor_provider_id TEXT NOT NULL,
    url TEXT NOT NULL,
    chapter_key TEXT NOT NULL,
    title TEXT NOT NULL,
    anchor_after_key TEXT NOT NULL,
    anchor_after_title TEXT NOT NULL,
    anchor_before_key TEXT NOT NULL,
    anchor_before_title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    status_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(book_id, url)
  )`).run()
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_web_book_supplements_book ON web_book_supplements(book_id, user_id)',
  ).run()
}

function migrateReaderSettingsTable(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(reader_settings)').all() as { name: string }[]
  const columnNames = new Set(columns.map((column) => column.name))

  if (!columnNames.has('toolbar_side')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN toolbar_side TEXT NOT NULL DEFAULT 'right'`).run()
  }

  if (!columnNames.has('hard_wrap_mode')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN hard_wrap_mode TEXT NOT NULL DEFAULT 'auto'`).run()
  }

  if (!columnNames.has('chinese_conversion')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN chinese_conversion TEXT NOT NULL DEFAULT 'none'`).run()
  }

  if (!columnNames.has('content_filters_json')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN content_filters_json TEXT NOT NULL DEFAULT '[]'`).run()
  }

  if (!columnNames.has('padding_top')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN padding_top REAL NOT NULL DEFAULT 9`).run()
  }

  if (!columnNames.has('padding_bottom')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN padding_bottom REAL NOT NULL DEFAULT 8`).run()
  }

  if (!columnNames.has('annotation_margin_top')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN annotation_margin_top REAL NOT NULL DEFAULT 20`).run()
  }

  if (!columnNames.has('annotation_margin_bottom')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN annotation_margin_bottom REAL NOT NULL DEFAULT 0`).run()
  }

  if (!columnNames.has('margin_left')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN margin_left REAL NOT NULL DEFAULT 16`).run()
  }

  if (!columnNames.has('margin_right')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN margin_right REAL NOT NULL DEFAULT 16`).run()
  }

  if (!columnNames.has('paragraph_spacing')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN paragraph_spacing REAL NOT NULL DEFAULT 7`).run()
  }

  if (!columnNames.has('paragraph_indent')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN paragraph_indent REAL NOT NULL DEFAULT 1`).run()
  }

  if (!columnNames.has('font_weight')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN font_weight INTEGER NOT NULL DEFAULT 400`).run()
  }

  if (!columnNames.has('justify_text')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN justify_text INTEGER NOT NULL DEFAULT 1`).run()
  }

  if (!columnNames.has('tap_scroll_percent')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN tap_scroll_percent REAL NOT NULL DEFAULT 90`).run()
  }

  if (!columnNames.has('tap_scroll_mode')) {
    db.prepare(`ALTER TABLE reader_settings ADD COLUMN tap_scroll_mode TEXT NOT NULL DEFAULT 'allDown'`).run()
  }

  // Fix: SQLite UNIQUE(user_id, book_id) does not prevent duplicate NULLs (NULL != NULL).
  // Migrate all book_id IS NULL rows to book_id = '__global__' (a valid string key) so
  // ON CONFLICT upserts work correctly. Keep only the most-recently-inserted row per user.
  db.prepare(
    `DELETE FROM reader_settings
     WHERE book_id IS NULL AND id NOT IN (
       SELECT MAX(id) FROM reader_settings WHERE book_id IS NULL GROUP BY user_id
     )`,
  ).run()
  // If a '__global__' row already exists for the user, drop the NULL survivor to avoid conflict.
  db.prepare(
    `DELETE FROM reader_settings
     WHERE book_id IS NULL AND user_id IN (
       SELECT user_id FROM reader_settings WHERE book_id = '__global__'
     )`,
  ).run()
  db.prepare(`UPDATE reader_settings SET book_id = '__global__' WHERE book_id IS NULL`).run()
}

function migrateProgressTable(db: Database.Database): void {
  const columns = new Set((db.prepare('PRAGMA table_info(reading_progress)').all() as { name: string }[]).map(column => column.name))
  if (!columns.has('chapter_offset')) db.prepare('ALTER TABLE reading_progress ADD COLUMN chapter_offset INTEGER').run()
  if (!columns.has('chapter_progress')) db.prepare('ALTER TABLE reading_progress ADD COLUMN chapter_progress REAL').run()
}
