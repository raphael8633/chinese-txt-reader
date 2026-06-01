import { FastifyPluginAsync } from 'fastify'
import type Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { v4 as uuid } from 'uuid'
import { authHook } from '../auth.js'
import { detectAndConvert } from '../utils/encoding.js'

interface BooksPluginOptions {
  db: Database.Database
  uploadsDir: string
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
  detected_encoding: string | null
  created_at: string
  updated_at: string
  position_type: string | null
  position_value: number | null
  page_index: number | null
  progress_updated_at: string | null
}

interface ChapterMetadata {
  index: number
  title: string
}

const chapterPattern = /^(第[一二三四五六七八九十百千零〇\d]+[章回節卷部篇]|Chapter\s+\d+)/i
const chapterTitlePattern = /^(第[一二三四五六七八九十百千零〇\d]+[章回節卷部篇]|Chapter\s+\d+)\s*(.*)$/i
const dialoguePattern = /^[「『"']/

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .flatMap((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
      const paragraphs: string[] = []
      let pending = ''

      for (const line of lines) {
        if (chapterPattern.test(line) || dialoguePattern.test(line)) {
          if (pending) paragraphs.push(pending)
          paragraphs.push(line)
          pending = ''
          continue
        }
        pending = pending ? `${pending}${line}` : line
      }

      if (pending) paragraphs.push(pending)
      return paragraphs
    })
}

function detectChapters(paragraphs: string[]): ChapterMetadata[] {
  return paragraphs
    .map((paragraph, index) => ({ index, title: formatChapterTitle(paragraph.trim()).slice(0, 40) }))
    .filter((chapter) => chapterPattern.test(chapter.title))
}

function formatChapterTitle(text: string): string {
  const match = text.trim().match(chapterTitlePattern)
  if (!match) return text
  const name = match[2]?.trim()
  return name ? `${match[1]} ${name}` : match[1]
}

function parseChaptersJson(json: string): ChapterMetadata[] {
  try {
    const chapters = JSON.parse(json) as unknown
    if (!Array.isArray(chapters)) return []
    return chapters.flatMap((chapter) => {
      if (
        typeof chapter === 'object'
        && chapter !== null
        && typeof (chapter as ChapterMetadata).index === 'number'
        && typeof (chapter as ChapterMetadata).title === 'string'
      ) {
        return [{
          index: (chapter as ChapterMetadata).index,
          title: (chapter as ChapterMetadata).title,
        }]
      }
      return []
    })
  } catch {
    return []
  }
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

    const utf8Text = detectAndConvert(fileBuffer)
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
    const rows = db
      .prepare(
        `SELECT
           b.id,
           b.title,
           b.file_size,
           b.char_count,
           b.paragraph_count,
           b.chapters_json,
           b.created_at,
           b.updated_at,
           p.position_type,
           p.position_value,
           p.page_index,
           p.updated_at AS progress_updated_at
         FROM books b
         LEFT JOIN reading_progress p
           ON p.user_id = b.user_id
          AND p.book_id = b.id
         WHERE b.user_id = ?
         ORDER BY p.updated_at DESC, b.created_at DESC`,
      )
      .all(userId) as Pick<
        BookRow,
        | 'id'
        | 'title'
        | 'file_size'
        | 'char_count'
        | 'paragraph_count'
        | 'chapters_json'
        | 'created_at'
        | 'updated_at'
        | 'position_type'
        | 'position_value'
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

    return reply.code(200).send(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        charCount: r.char_count,
        fileSize: r.file_size,
        paragraphCount: r.paragraph_count,
        chapters: parseChaptersJson(r.chapters_json),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        progress: r.position_type === null
          ? null
          : {
              positionType: r.position_type,
              positionValue: r.position_value,
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
      .prepare(`SELECT id FROM books WHERE id = ? AND user_id = ?`)
      .get(id, userId) as { id: string } | undefined

    if (!row) {
      return reply.code(404).send({ error: 'Not found' })
    }

    const filePath = join(uploadsDir, userId, id, 'utf8.txt')
    const text = await readFile(filePath, 'utf-8')

    return reply
      .code(200)
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'private, max-age=604800')
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
      .prepare(`SELECT id FROM books WHERE id = ? AND user_id = ?`)
      .get(id, userId) as { id: string } | undefined

    if (!existing) {
      return reply.code(404).send({ error: 'Not found' })
    }

    const trimmed = title.trim()
    const now = new Date().toISOString()
    db.prepare(`UPDATE books SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`).run(
      trimmed,
      now,
      id,
      userId,
    )

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
      db.prepare(`DELETE FROM reading_progress WHERE user_id = ? AND book_id = ?`).run(userId, id)
      db.prepare(`DELETE FROM reader_settings WHERE user_id = ? AND book_id = ?`).run(userId, id)
      db.prepare(`DELETE FROM books WHERE id = ? AND user_id = ?`).run(id, userId)
    })
    deleteBook()

    await rm(join(uploadsDir, userId, id), { recursive: true, force: true })

    return reply.code(200).send({ ok: true })
  })
}
