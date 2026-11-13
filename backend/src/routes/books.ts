import { FastifyPluginAsync } from 'fastify'
import type Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { v4 as uuid } from 'uuid'
import { authHook } from '../auth.js'
import { prepareMerge, projectWork, readWork, reconcileWorks, releaseWork, type ManifestCache, type Work } from '../services/sharedProgress.js'
import { titleKey } from '../utils/titleKey.js'
import { detectAndConvert } from '../utils/encoding.js'
import { detectChapters, parseChaptersJson, splitParagraphs } from '../utils/bookText.js'
import { decodeHtmlEntities } from '../utils/htmlEntities.js'
import {
  listActiveSupplementBatches,
  type WebSourceService,
  type WebSourceSupplementBatch,
} from '../services/web-source/WebSourceService.js'

interface BooksPluginOptions {
  db: Database.Database
  uploadsDir: string
  webSourceService?: Pick<WebSourceService, 'readBookText'>
}

interface BookRow {
  id: string
  user_id: string
  title: string
  original_filename: string
  file_size: number
  char_count: number
  paragraph_count: number
  chapters_json: string
  source_type: string
  source_url: string | null
  provider_id: string | null
  manifest_version: number
  created_at: string
  updated_at: string
  position_type: string | null
  position_value: number | null
  chapter_offset: number | null
  chapter_progress: number | null
  page_index: number | null
  progress_updated_at: string | null
}

interface WebChapterMetadataRow {
  book_id: string
  chapter_index: number
  title: string
  url: string
  chapter_key: string | null
}

export const booksRoutes: FastifyPluginAsync<BooksPluginOptions> = async (app, opts) => {
  const { db, uploadsDir } = opts

  // POST /api/books — multipart upload
  app.post('/api/books', { preHandler: authHook }, async (req, reply) => {
    let fileBuffer: Buffer | null = null
    let filename = ''
    let title = ''

    // Iterate all parts to capture both 'file' and 'title' fields
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          filename = part.filename
          fileBuffer = await part.toBuffer()
        } else if (part.type === 'field' && part.fieldname === 'title') {
          title = (part.value as string).trim()
        }
      }
    } catch (err: unknown) {
      const e = err as { code?: string; statusCode?: number }
      if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.statusCode === 413) {
        return reply.code(413).send({ error: 'File too large. Maximum size is 20MB.' })
      }
      throw err
    }

    if (!fileBuffer || !filename) {
      return reply.code(400).send({ error: 'No file uploaded' })
    }

    const ext = extname(filename).toLowerCase()
    if (ext !== '.txt') {
      return reply.code(400).send({ error: 'Only .txt files are supported' })
    }

    if (!title) {
      title = basename(filename, extname(filename))
    }

    const utf8Text = decodeHtmlEntities(detectAndConvert(fileBuffer))
    const paragraphs = splitParagraphs(utf8Text)
    const chapters = detectChapters(paragraphs)
    const bookId = uuid()
    const now = new Date().toISOString()
    const userId = req.userId

    // Save files
    const bookDir = join(uploadsDir, userId, bookId)
    mkdirSync(bookDir, { recursive: true })
    writeFileSync(join(bookDir, 'original'), fileBuffer)
    writeFileSync(join(bookDir, 'utf8.txt'), utf8Text, 'utf-8')

    // Insert into DB
    db.prepare(
      `INSERT INTO books (
         id, user_id, title, original_filename, file_size, char_count,
         paragraph_count, chapters_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bookId,
      userId,
      title,
      filename,
      fileBuffer.length,
      utf8Text.length,
      paragraphs.length,
      JSON.stringify(chapters),
      now,
      now,
    )

    return reply.code(201).send({
      id: bookId,
      title,
      charCount: utf8Text.length,
      fileSize: fileBuffer.length,
      paragraphCount: paragraphs.length,
      chapters,
      createdAt: now,
    })
  })

  // GET /api/books — list books for current user
  app.get('/api/books', { preHandler: authHook }, async (req, reply) => {
    const userId = req.userId
    // One manifest cache per request: reconcile and every card projection share
    // each book's manifest and its normalized-name index.
    const manifestCache: ManifestCache = new Map()
    reconcileWorks(db, userId, manifestCache)
    const rows = db
      .prepare(
        `SELECT
           b.id,
           b.title,
           b.file_size,
           b.char_count,
           b.paragraph_count,
           b.chapters_json,
           b.source_type,
           b.source_url,
           b.provider_id,
           b.manifest_version,
           b.created_at,
           b.updated_at,
           p.position_type,
           p.position_value,
           p.chapter_offset,
           p.chapter_progress,
           p.page_index,
           p.updated_at AS progress_updated_at
         FROM books b
         LEFT JOIN reading_progress p
           ON p.user_id = b.user_id
          AND p.book_id = b.id
         LEFT JOIN reading_work_members m
           ON m.user_id = b.user_id
          AND m.book_id = b.id
         LEFT JOIN reading_works w
           ON w.id = m.work_id
          AND w.user_id = m.user_id
         WHERE b.user_id = ?
         ORDER BY MAX(COALESCE(p.updated_at, ''), COALESCE(w.updated_at, '')) DESC, b.created_at DESC`,
      )
      .all(userId) as Pick<
        BookRow,
        | 'id'
        | 'title'
        | 'file_size'
        | 'char_count'
        | 'paragraph_count'
        | 'chapters_json'
        | 'source_type'
        | 'source_url'
        | 'provider_id'
        | 'manifest_version'
        | 'created_at'
        | 'updated_at'
        | 'position_type'
        | 'position_value'
        | 'chapter_offset'
      | 'chapter_progress'
      | 'page_index'
        | 'progress_updated_at'
      >[]

    for (const row of rows) {
      if (row.paragraph_count > 0) continue
      try {
        const text = await readFile(join(uploadsDir, userId, row.id, 'utf8.txt'), 'utf-8')
        const paragraphs = splitParagraphs(text)
        const chapters = detectChapters(paragraphs)
        db.prepare(
          `UPDATE books
           SET paragraph_count = ?, chapters_json = ?
           WHERE id = ? AND user_id = ?`,
        ).run(paragraphs.length, JSON.stringify(chapters), row.id, userId)
        row.paragraph_count = paragraphs.length
        row.chapters_json = JSON.stringify(chapters)
      } catch {
        row.paragraph_count = 0
        row.chapters_json = '[]'
      }
    }

    const webChaptersByBookId = new Map<string, Array<{
      index: number
      title: string
      sourceUrl: string
      chapterKey: string
    }>>()
    let supplementBatches = new Map<string, WebSourceSupplementBatch[]>()
    if (rows.some((row) => row.source_type === 'web')) {
      // Only batches that still have an active row are undoable (retired-only
      // batches no longer change the manifest).
      supplementBatches = listActiveSupplementBatches(db, userId)
      const webChapterRows = db
        .prepare(
          `SELECT book_id, chapter_index, title, url, chapter_key
           FROM web_book_chapters
           WHERE user_id = ?
           ORDER BY book_id ASC, chapter_index ASC`,
        )
        .all(userId) as WebChapterMetadataRow[]
      for (const chapter of webChapterRows) {
        const metadata = webChaptersByBookId.get(chapter.book_id) ?? []
        metadata.push({
          index: chapter.chapter_index,
          title: chapter.title,
          sourceUrl: chapter.url,
          chapterKey: chapter.chapter_key || chapter.url,
        })
        webChaptersByBookId.set(chapter.book_id, metadata)
      }
    }

    return reply.code(200).send(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        charCount: r.char_count,
        fileSize: r.file_size,
        paragraphCount: r.paragraph_count,
        chapters: r.source_type === 'web'
          ? webChaptersByBookId.get(r.id) ?? parseChaptersJson(r.chapters_json)
          : parseChaptersJson(r.chapters_json),
        sourceType: r.source_type,
        sourceUrl: r.source_url,
        providerId: r.provider_id,
        manifestVersion: r.manifest_version,
        ...(() => {
          const work = r.source_type === 'web' || r.source_type === 'txt' ? readWork(db, userId, r.id) : undefined
          return work ? projectWork(db, userId, work, r.id, manifestCache) : {}
        })(),
        ...(supplementBatches.has(r.id)
          ? {
              supplementBatchCount: supplementBatches.get(r.id)!.length,
              latestSupplementBatch: supplementBatches.get(r.id)![0],
            }
          : {}),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        progress: r.position_type === null
          ? null
          : {
              positionType: r.position_type,
              positionValue: r.position_value,
              ...(r.chapter_offset === null ? {} : { chapterOffset: r.chapter_offset, chapterProgress: r.chapter_progress }),
              pageIndex: r.page_index,
              updatedAt: r.progress_updated_at ?? r.updated_at,
            },
      })),
    )
  })

  // GET /api/books/:id/content
  app.get('/api/books/:id/content', { preHandler: authHook }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId

    const row = db
      .prepare(`SELECT id, updated_at, source_type FROM books WHERE id = ? AND user_id = ?`)
      .get(id, userId) as { id: string; updated_at: string; source_type: string } | undefined

    if (!row) {
      return reply.code(404).send({ error: 'Not found' })
    }

    // ETag tied to updated_at — bumped by upload, rename, and the entity-decode
    // backfill — so any text mutation invalidates browser HTTP cache and the
    // frontend's IndexedDB content snapshot (which keys off contentVersion).
    const etag = `"${row.updated_at}"`
    const ifNoneMatch = req.headers['if-none-match']
    if (ifNoneMatch === etag) {
      return reply.code(304).header('etag', etag).send()
    }

    const text = row.source_type === 'web'
      ? await opts.webSourceService?.readBookText(userId, id) ?? ''
      : await readFile(join(uploadsDir, userId, id, 'utf8.txt'), 'utf-8')

    return reply
      .code(200)
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'private, no-cache')
      .header('etag', etag)
      .send(text)
  })

  // PATCH /api/books/:id — rename book
  app.patch('/api/books/:id', { preHandler: authHook }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { title?: unknown }
    const { title } = body
    if (typeof title !== 'string' || title.trim().length === 0) {
      return reply.code(400).send({ error: 'title must be a non-empty string' })
    }
    const userId = req.userId

    const existing = db
      .prepare(`SELECT id, title, source_type, manifest_version FROM books WHERE id = ? AND user_id = ?`)
      .get(id, userId) as { id: string; title: string; source_type: string; manifest_version: number } | undefined

    if (!existing) {
      return reply.code(404).send({ error: 'Not found' })
    }

    const trimmed = title.trim()
    const now = new Date().toISOString()
    let merge: { source: ReturnType<typeof readWork> } | null = null
    // A TXT edition merges like a web one; its manifest never changes, so its version stays put.
    if ((existing.source_type === 'web' || existing.source_type === 'txt') && titleKey(trimmed) !== titleKey(existing.title)) {
      reconcileWorks(db, userId)
      const source = readWork(db, userId, id)
      const target = db.prepare('SELECT * FROM reading_works WHERE user_id=? AND title_key=?')
        .get(userId,titleKey(trimmed)) as Work|undefined
      // A returning anchor is already canonical in its old work; that is not a merge.
      const returning = target?.anchor_book_id === id && target.anchor_manifest_version === existing.manifest_version
      if (target && !returning && target.id !== source?.id) merge = { source }
    }
    db.transaction(() => {
      if (merge) prepareMerge(db, userId, id, merge.source)
      // A web-book rename can leave and rejoin the same work before apply;
      // advancing its version invalidates both primary and donor previews.
      db.prepare(`UPDATE books SET title = ?, updated_at = ?, manifest_version = manifest_version + ?
        WHERE id = ? AND user_id = ?`).run(
        trimmed, now, existing.source_type === 'web' && trimmed !== existing.title ? 1 : 0, id, userId,
      )
      if (existing.source_type === 'web' && trimmed !== existing.title) {
        // The directory did not change: advance the canonical anchor with the
        // token version, and bump work CAS so pre-rename saves cannot overwrite it.
        // An already-stale anchor must not be revived by another title edit.
        db.prepare(`UPDATE reading_works SET anchor_manifest_version=?, revision=revision+1
          WHERE user_id=? AND title_key IN (?,?) AND anchor_book_id=? AND anchor_manifest_version=?
            AND (title_key=? OR NOT EXISTS (SELECT 1 FROM reading_works other
              WHERE other.user_id=? AND other.title_key=?))
            AND EXISTS (SELECT 1 FROM reading_work_members
              WHERE user_id=? AND book_id=?)`)
          .run(existing.manifest_version+1,userId,titleKey(existing.title),titleKey(trimmed),id,existing.manifest_version,
            titleKey(trimmed),userId,titleKey(trimmed),userId,id)
      }
      reconcileWorks(db, userId)
    })()

    return reply.code(200).send({ id, title: trimmed, updatedAt: now })
  })

  // DELETE /api/books/:id — delete book and associated user data
  app.delete('/api/books/:id', { preHandler: authHook }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId

    const existing = db
      .prepare(`SELECT id FROM books WHERE id = ? AND user_id = ?`)
      .get(id, userId) as { id: string } | undefined

    if (!existing) {
      return reply.code(404).send({ error: 'Not found' })
    }

    const deleteBook = db.transaction(() => {
      const work = readWork(db, userId, id)
      if (work) {
        const survivor = db.prepare(`SELECT b.id FROM reading_work_members m JOIN books b
          ON b.id=m.book_id AND b.user_id=m.user_id
          WHERE m.work_id=? AND m.user_id=? AND m.book_id<>?
            AND b.source_type='web'
          ORDER BY b.created_at,b.id LIMIT 1`).get(work.id,userId,id) as {id:string}|undefined
        if (survivor) {
          // Ranking picks again on the next read; the survivor is not a choice the user made.
          if (work.preferred_book_id === id) db.prepare(`UPDATE reading_works SET preferred_book_id=?,preferred_manual=0 WHERE id=? AND user_id=?`)
            .run(survivor.id,work.id,userId)
        } else releaseWork(db,userId,work,id)
      }
      db.prepare(`DELETE FROM reading_progress WHERE user_id = ? AND book_id = ?`).run(userId, id)
      db.prepare(`DELETE FROM reader_settings WHERE user_id = ? AND book_id = ?`).run(userId, id)
      db.prepare(`DELETE FROM web_book_chapters WHERE user_id = ? AND book_id = ?`).run(userId, id)
      db.prepare(`DELETE FROM books WHERE id = ? AND user_id = ?`).run(id, userId)
    })
    deleteBook()

    await rm(join(uploadsDir, userId, id), { recursive: true, force: true })

    return reply.code(200).send({ ok: true })
  })
}
