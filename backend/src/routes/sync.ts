import { FastifyPluginAsync } from 'fastify'
import type Database from 'better-sqlite3'
import { authHook } from '../auth.js'

interface SyncPluginOptions {
  db: Database.Database
}

interface ProgressRow {
  position_type: string
  position_value: number
  page_index: number | null
  updated_at: string
}

interface SettingsRow {
  font_size_px: number
  line_height: number
  letter_spacing_px: number
  text_color: string
  background_color: string
  reading_mode: string
  toolbar_side?: string
  hard_wrap_mode?: string
  chinese_conversion?: string
  padding_top?: number
  padding_bottom?: number
  annotation_margin_top?: number
  annotation_margin_bottom?: number
  margin_left?: number
  margin_right?: number
  paragraph_spacing?: number
  paragraph_indent?: number
  font_weight?: number
  justify_text?: number
  tap_scroll_percent?: number
  tap_scroll_mode?: string
}

const DEFAULT_SETTINGS = {
  fontSizePx: 18,
  lineHeight: 1.8,
  letterSpacingPx: 0,
  textColor: '#333333',
  backgroundColor: '#f5f0e8',
  readingMode: 'scroll',
  toolbarSide: 'right',
  hardWrapMode: 'auto',
  chineseConversion: 'none',
  paddingTop: 9,
  paddingBottom: 8,
  annotationMarginTop: 20,
  annotationMarginBottom: 0,
  marginLeft: 16,
  marginRight: 16,
  paragraphSpacing: 7,
  paragraphIndent: 1,
  fontWeight: 400,
  justifyText: true,
  tapScrollPercent: 90,
  tapScrollMode: 'allDown',
}

export const syncRoutes: FastifyPluginAsync<SyncPluginOptions> = async (app, opts) => {
  const { db } = opts

  // GET /api/books/:id/progress
  app.get('/api/books/:id/progress', { preHandler: authHook }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId

    const row = db
      .prepare(
        `SELECT position_type, position_value, page_index, updated_at
         FROM reading_progress WHERE user_id = ? AND book_id = ?`,
      )
      .get(userId, id) as ProgressRow | undefined

    if (!row) {
      return reply.code(200).send(null)
    }

    return reply.code(200).send({
      positionType: row.position_type,
      positionValue: row.position_value,
      pageIndex: row.page_index,
      updatedAt: row.updated_at,
    })
  })

  // POST /api/books/:id/progress
  app.post('/api/books/:id/progress', { preHandler: authHook }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { positionType?: unknown; positionValue?: unknown }

    if (typeof body.positionType !== 'string') {
      return reply.code(400).send({ error: 'positionType must be a string' })
    }
    if (typeof body.positionValue !== 'number') {
      return reply.code(400).send({ error: 'positionValue must be a number' })
    }

    const userId = req.userId
    const now = new Date().toISOString()

    db.prepare(
      `INSERT INTO reading_progress (user_id, book_id, position_type, position_value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, book_id) DO UPDATE SET
         position_type = excluded.position_type,
         position_value = excluded.position_value,
         updated_at = excluded.updated_at`,
    ).run(userId, id, body.positionType, body.positionValue, now)

    return reply.code(200).send({ ok: true })
  })

  // GET /api/settings
  app.get('/api/settings', { preHandler: authHook }, async (req, reply) => {
    const userId = req.userId
    const query = req.query as { bookId?: string }
    const bookId = query.bookId

    const SELECT_COLS = `font_size_px, line_height, letter_spacing_px, text_color, background_color, reading_mode,
      toolbar_side, hard_wrap_mode, chinese_conversion,
      padding_top, padding_bottom, annotation_margin_top, annotation_margin_bottom,
      margin_left, margin_right, paragraph_spacing, paragraph_indent, font_weight, justify_text,
      tap_scroll_percent, tap_scroll_mode`

    function rowToSettings(row: SettingsRow) {
      return {
        fontSizePx: row.font_size_px,
        lineHeight: row.line_height,
        letterSpacingPx: row.letter_spacing_px,
        textColor: row.text_color,
        backgroundColor: row.background_color,
        readingMode: row.reading_mode,
        toolbarSide: row.toolbar_side === 'left' ? 'left' : 'right',
        hardWrapMode: row.hard_wrap_mode === 'merge' || row.hard_wrap_mode === 'preserve' ? row.hard_wrap_mode : 'auto',
        chineseConversion: row.chinese_conversion === 'traditional' || row.chinese_conversion === 'simplified' ? row.chinese_conversion : 'none',
        paddingTop: row.padding_top ?? DEFAULT_SETTINGS.paddingTop,
        paddingBottom: row.padding_bottom ?? DEFAULT_SETTINGS.paddingBottom,
        annotationMarginTop: row.annotation_margin_top ?? DEFAULT_SETTINGS.annotationMarginTop,
        annotationMarginBottom: row.annotation_margin_bottom ?? DEFAULT_SETTINGS.annotationMarginBottom,
        marginLeft: row.margin_left ?? DEFAULT_SETTINGS.marginLeft,
        marginRight: row.margin_right ?? DEFAULT_SETTINGS.marginRight,
        paragraphSpacing: row.paragraph_spacing ?? DEFAULT_SETTINGS.paragraphSpacing,
        paragraphIndent: row.paragraph_indent ?? DEFAULT_SETTINGS.paragraphIndent,
        fontWeight: row.font_weight ?? DEFAULT_SETTINGS.fontWeight,
        justifyText: row.justify_text !== undefined ? Boolean(row.justify_text) : DEFAULT_SETTINGS.justifyText,
        tapScrollPercent: row.tap_scroll_percent ?? DEFAULT_SETTINGS.tapScrollPercent,
        tapScrollMode: row.tap_scroll_mode === 'horizontal' || row.tap_scroll_mode === 'vertical' ? row.tap_scroll_mode : 'allDown',
      }
    }

    if (bookId) {
      // Try book-specific first
      const bookRow = db
        .prepare(
          `SELECT ${SELECT_COLS}
           FROM reader_settings WHERE user_id = ? AND book_id = ?`,
        )
        .get(userId, bookId) as SettingsRow | undefined

      if (bookRow) {
        return reply.code(200).send(rowToSettings(bookRow))
      }

      // Fall back to global
      const globalRow = db
        .prepare(
          `SELECT ${SELECT_COLS}
           FROM reader_settings WHERE user_id = ? AND book_id = '__global__'`,
        )
        .get(userId) as SettingsRow | undefined

      if (globalRow) {
        return reply.code(200).send(rowToSettings(globalRow))
      }

      return reply.code(200).send(DEFAULT_SETTINGS)
    }

    // No bookId — return global
    const globalRow = db
      .prepare(
        `SELECT ${SELECT_COLS}
         FROM reader_settings WHERE user_id = ? AND book_id = '__global__'`,
      )
      .get(userId) as SettingsRow | undefined

    if (globalRow) {
      return reply.code(200).send(rowToSettings(globalRow))
    }

    return reply.code(200).send(DEFAULT_SETTINGS)
  })

  // POST /api/settings
  app.post('/api/settings', { preHandler: authHook }, async (req, reply) => {
    const body = req.body as {
      bookId?: unknown
      fontSizePx?: unknown
      lineHeight?: unknown
      letterSpacingPx?: unknown
      textColor?: unknown
      backgroundColor?: unknown
      readingMode?: unknown
      toolbarSide?: unknown
      hardWrapMode?: unknown
      chineseConversion?: unknown
      paddingTop?: unknown
      paddingBottom?: unknown
      annotationMarginTop?: unknown
      annotationMarginBottom?: unknown
      marginLeft?: unknown
      marginRight?: unknown
      paragraphSpacing?: unknown
      paragraphIndent?: unknown
      fontWeight?: unknown
      justifyText?: unknown
      tapScrollPercent?: unknown
      tapScrollMode?: unknown
    }

    if (typeof body.fontSizePx !== 'number') {
      return reply.code(400).send({ error: 'fontSizePx must be a number' })
    }
    if (typeof body.lineHeight !== 'number') {
      return reply.code(400).send({ error: 'lineHeight must be a number' })
    }
    if (typeof body.letterSpacingPx !== 'number') {
      return reply.code(400).send({ error: 'letterSpacingPx must be a number' })
    }
    if (typeof body.textColor !== 'string') {
      return reply.code(400).send({ error: 'textColor must be a string' })
    }
    if (typeof body.backgroundColor !== 'string') {
      return reply.code(400).send({ error: 'backgroundColor must be a string' })
    }
    if (typeof body.readingMode !== 'string') {
      return reply.code(400).send({ error: 'readingMode must be a string' })
    }
    if (body.toolbarSide !== undefined && body.toolbarSide !== 'left' && body.toolbarSide !== 'right') {
      return reply.code(400).send({ error: 'toolbarSide must be left or right' })
    }
    if (
      body.hardWrapMode !== undefined
      && body.hardWrapMode !== 'auto'
      && body.hardWrapMode !== 'merge'
      && body.hardWrapMode !== 'preserve'
    ) {
      return reply.code(400).send({ error: 'hardWrapMode must be auto, merge, or preserve' })
    }
    if (
      body.chineseConversion !== undefined
      && body.chineseConversion !== 'none'
      && body.chineseConversion !== 'traditional'
      && body.chineseConversion !== 'simplified'
    ) {
      return reply.code(400).send({ error: 'chineseConversion must be none, traditional, or simplified' })
    }
    if (body.fontWeight !== undefined) {
      const fw = body.fontWeight
      if (typeof fw !== 'number' || fw < 100 || fw > 900 || fw % 100 !== 0) {
        return reply.code(400).send({ error: 'fontWeight must be a number between 100 and 900 in steps of 100' })
      }
    }
    if (body.justifyText !== undefined && typeof body.justifyText !== 'boolean') {
      return reply.code(400).send({ error: 'justifyText must be a boolean' })
    }
    if (
      body.tapScrollMode !== undefined
      && body.tapScrollMode !== 'allDown'
      && body.tapScrollMode !== 'horizontal'
      && body.tapScrollMode !== 'vertical'
    ) {
      return reply.code(400).send({ error: 'tapScrollMode must be allDown, horizontal, or vertical' })
    }
    const numericFields = ['paddingTop', 'paddingBottom', 'annotationMarginTop', 'annotationMarginBottom', 'marginLeft', 'marginRight', 'paragraphSpacing', 'paragraphIndent', 'tapScrollPercent'] as const
    for (const field of numericFields) {
      if (body[field] !== undefined) {
        const v = Number(body[field])
        if (isNaN(v) || !isFinite(v)) {
          return reply.code(400).send({ error: `${field} must be a finite number` })
        }
      }
    }

    // bookId: null/undefined means global (stored as '__global__' to avoid SQLite NULL-UNIQUE quirk)
    const bookId = body.bookId === null || body.bookId === undefined ? '__global__' : String(body.bookId)
    const userId = req.userId

    const toolbarSide = body.toolbarSide === 'left' ? 'left' : 'right'
    const hardWrapMode = body.hardWrapMode === 'merge' || body.hardWrapMode === 'preserve' ? body.hardWrapMode : 'auto'
    const chineseConversion = body.chineseConversion === 'traditional' || body.chineseConversion === 'simplified' ? body.chineseConversion : 'none'
    const paddingTop = body.paddingTop !== undefined ? Number(body.paddingTop) : DEFAULT_SETTINGS.paddingTop
    const paddingBottom = body.paddingBottom !== undefined ? Number(body.paddingBottom) : DEFAULT_SETTINGS.paddingBottom
    const annotationMarginTop = body.annotationMarginTop !== undefined ? Number(body.annotationMarginTop) : DEFAULT_SETTINGS.annotationMarginTop
    const annotationMarginBottom = body.annotationMarginBottom !== undefined ? Number(body.annotationMarginBottom) : DEFAULT_SETTINGS.annotationMarginBottom
    const marginLeft = body.marginLeft !== undefined ? Number(body.marginLeft) : DEFAULT_SETTINGS.marginLeft
    const marginRight = body.marginRight !== undefined ? Number(body.marginRight) : DEFAULT_SETTINGS.marginRight
    const paragraphSpacing = body.paragraphSpacing !== undefined ? Number(body.paragraphSpacing) : DEFAULT_SETTINGS.paragraphSpacing
    const paragraphIndent = body.paragraphIndent !== undefined ? Number(body.paragraphIndent) : DEFAULT_SETTINGS.paragraphIndent
    const fontWeight = body.fontWeight !== undefined ? Number(body.fontWeight) : DEFAULT_SETTINGS.fontWeight
    const justifyText = body.justifyText !== undefined ? (body.justifyText ? 1 : 0) : 1
    const tapScrollPercent = body.tapScrollPercent !== undefined ? Number(body.tapScrollPercent) : DEFAULT_SETTINGS.tapScrollPercent
    const tapScrollMode = body.tapScrollMode === 'horizontal' || body.tapScrollMode === 'vertical' ? body.tapScrollMode : 'allDown'

    db.prepare(
      `INSERT INTO reader_settings (
        user_id, book_id, font_size_px, line_height, letter_spacing_px, text_color, background_color, reading_mode,
        toolbar_side, hard_wrap_mode, chinese_conversion,
        padding_top, padding_bottom, annotation_margin_top, annotation_margin_bottom,
        margin_left, margin_right, paragraph_spacing, paragraph_indent, font_weight, justify_text,
        tap_scroll_percent, tap_scroll_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, book_id) DO UPDATE SET
         font_size_px = excluded.font_size_px,
         line_height = excluded.line_height,
         letter_spacing_px = excluded.letter_spacing_px,
         text_color = excluded.text_color,
         background_color = excluded.background_color,
         reading_mode = excluded.reading_mode,
         toolbar_side = excluded.toolbar_side,
         hard_wrap_mode = excluded.hard_wrap_mode,
         chinese_conversion = excluded.chinese_conversion,
         padding_top = excluded.padding_top,
         padding_bottom = excluded.padding_bottom,
         annotation_margin_top = excluded.annotation_margin_top,
         annotation_margin_bottom = excluded.annotation_margin_bottom,
         margin_left = excluded.margin_left,
         margin_right = excluded.margin_right,
         paragraph_spacing = excluded.paragraph_spacing,
         paragraph_indent = excluded.paragraph_indent,
         font_weight = excluded.font_weight,
         justify_text = excluded.justify_text,
         tap_scroll_percent = excluded.tap_scroll_percent,
         tap_scroll_mode = excluded.tap_scroll_mode`,
    ).run(
      userId, bookId,
      body.fontSizePx, body.lineHeight, body.letterSpacingPx, body.textColor, body.backgroundColor, body.readingMode,
      toolbarSide, hardWrapMode, chineseConversion,
      paddingTop, paddingBottom, annotationMarginTop, annotationMarginBottom,
      marginLeft, marginRight, paragraphSpacing, paragraphIndent, fontWeight, justifyText,
      tapScrollPercent, tapScrollMode,
    )

    return reply.code(200).send({ ok: true })
  })
}
