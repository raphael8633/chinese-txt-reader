import Database from 'better-sqlite3'

export function initDb(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')

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
      detected_encoding TEXT,
      selected_encoding TEXT,
      normalized_text_hash TEXT,
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
  ]

  for (const stmt of schema) {
    db.prepare(stmt).run()
  }

  migrateBooksTable(db)
  migrateReaderSettingsTable(db)

  return db
}

function migrateBooksTable(db: Database.Database): void {
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
