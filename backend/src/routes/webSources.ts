import { FastifyPluginAsync } from 'fastify'
import { authHook } from '../auth.js'
import {
  FetchBudgetExceededError,
  FetchTimeoutError,
  ResponseTooLargeError,
  SsrfBlockedError,
} from '../services/fetch/SafeFetchService.js'
import { WebSourceBlockedError, WebSourceHttpError } from '../services/web-source/fetchGuard.js'
import { WebSourceParseError } from '../services/web-source/types.js'
import {
  EmptyWebSourceUrlError,
  InvalidWebSourceUrlError,
  UnsupportedWebSourceError,
  UnsupportedWebSourceHostError,
  UnsupportedWebSourcePathError,
  WebSourceNotFoundError,
  WebSourcePreviewRequiredError,
  WebSourcePreferredSourceConflictError,
  WebSourceRefreshConflictError,
  WebSourceSupplementBatchNotFoundError,
  WebSourceSupplementPreviewExpiredError,
  WebSourceSupplementSelectionError,
  WebSourceTooLargeError,
  type WebSourceService,
} from '../services/web-source/WebSourceService.js'

// Maps upstream/source failures to a user-actionable reason. Returns null when the
// error is not a recognized web-source failure (caller falls back to its 500).
function diagnoseWebSourceError(error: unknown): { status: number; message: string } | null {
  if (error instanceof UnsupportedWebSourceHostError || error instanceof UnsupportedWebSourcePathError) {
    return { status: 400, message: error.message }
  }
  if (error instanceof InvalidWebSourceUrlError) {
    return { status: 400, message: error.message }
  }
  if (error instanceof FetchBudgetExceededError) {
    // The operation stopped itself before hammering the source; 429 tells the
    // client this is a pacing limit rather than a broken URL.
    return { status: 429, message: error.message }
  }
  if (error instanceof ResponseTooLargeError) {
    return { status: 422, message: '來源頁面超過可處理的大小上限' }
  }
  if (error instanceof SsrfBlockedError) {
    return { status: 400, message: '此網址指向不允許的位址' }
  }
  if (error instanceof WebSourceBlockedError || error instanceof WebSourceHttpError) {
    return { status: 502, message: error.message }
  }
  if (error instanceof WebSourceParseError) {
    return { status: 502, message: '頁面可開啟但解析不到章節，可能來源站版式已變更或這不是章節目錄頁' }
  }
  if (error instanceof FetchTimeoutError) {
    return { status: 504, message: '連線來源站逾時，請稍後再試' }
  }
  return null
}

type WebSourceRoutesOptions = {
  webSourceService:
    Pick<WebSourceService, 'createFromChapterListUrl'>
    & Partial<Pick<
      WebSourceService,
      | 'readChapterWindow' | 'refreshFromSource' | 'search' | 'listProviders' | 'previewChapterListUrl'
      | 'previewSupplements' | 'applySupplements' | 'undoSupplements'
    >>
}

/** Supplement routes never fetch upstream, so only state/ownership errors apply. */
function diagnoseSupplementError(error: unknown): { status: number; message: string } | null {
  if (error instanceof WebSourceNotFoundError) return { status: 404, message: 'Web source book not found' }
  if (error instanceof WebSourceSupplementBatchNotFoundError) return { status: 404, message: error.message }
  if (error instanceof WebSourceSupplementPreviewExpiredError) return { status: 410, message: error.message }
  if (error instanceof WebSourcePreferredSourceConflictError) return { status: 409, message: error.message }
  if (error instanceof WebSourceSupplementSelectionError) return { status: 400, message: error.message }
  if (error instanceof WebSourceRefreshConflictError) {
    return { status: 409, message: 'Web source manifest changed; preview again' }
  }
  if (error instanceof UnsupportedWebSourceError) return { status: 400, message: 'Unsupported web source URL' }
  // A concurrent apply that slipped past the version check can only collide on
  // UNIQUE(book_id, url); to the user that is simply a stale preview.
  if (isUniqueConstraintError(error)) return { status: 409, message: '預覽已過期，請重新預覽' }
  return null
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}

const MAX_SUPPLEMENT_CANDIDATE_IDS = 500
const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/

export const webSourceRoutes: FastifyPluginAsync<WebSourceRoutesOptions> = async (app, opts) => {
  app.post('/api/web-sources/search', { preHandler: authHook }, async (req, reply) => {
    if (!opts.webSourceService.search) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const title = readTitle(req.body)
    if (!title) return reply.code(400).send({ error: 'Title is required' })

    try {
      return reply.code(200).send(await opts.webSourceService.search(req.userId, title))
    } catch (error) {
      req.log.error({ error }, 'Web source search failed')
      return reply.code(500).send({ error: 'Web source search failed' })
    }
  })

  app.get('/api/web-sources/providers', { preHandler: authHook }, async (req, reply) => {
    if (!opts.webSourceService.listProviders) {
      return reply.code(404).send({ error: 'Not found' })
    }
    return reply.code(200).send(opts.webSourceService.listProviders())
  })

  app.post('/api/web-sources/preview', { preHandler: authHook }, async (req, reply) => {
    if (!opts.webSourceService.previewChapterListUrl) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const url = readUrl(req.body)
    if (!url) return reply.code(400).send({ error: 'URL is required' })

    try {
      const preview = await opts.webSourceService.previewChapterListUrl(req.userId, url)
      return reply.code(200).send(preview)
    } catch (error) {
      if (error instanceof EmptyWebSourceUrlError) {
        return reply.code(400).send({ error: 'URL is required' })
      }
      const diagnosis = diagnoseWebSourceError(error)
      if (diagnosis) {
        return reply.code(diagnosis.status).send({ error: diagnosis.message })
      }
      if (error instanceof UnsupportedWebSourceError) {
        return reply.code(400).send({ error: 'Unsupported web source URL' })
      }
      if (error instanceof WebSourceTooLargeError) {
        return reply.code(400).send({ error: error.message })
      }
      req.log.error({ error }, 'Web source preview failed')
      return reply.code(500).send({ error: 'Web source preview failed' })
    }
  })

  app.post('/api/web-sources', { preHandler: authHook }, async (req, reply) => {
    const url = readUrl(req.body)
    if (!url) return reply.code(400).send({ error: 'URL is required' })
    const previewToken = readPreviewToken(req.body)

    try {
      const book = previewToken
        ? await opts.webSourceService.createFromChapterListUrl(req.userId, url, previewToken)
        : await opts.webSourceService.createFromChapterListUrl(req.userId, url)
      return reply.code(201).send(book)
    } catch (error) {
      if (error instanceof EmptyWebSourceUrlError) {
        return reply.code(400).send({ error: 'URL is required' })
      }
      if (error instanceof WebSourcePreviewRequiredError) {
        return reply.code(428).send({ error: 'preview_required', message: error.message })
      }
      const diagnosis = diagnoseWebSourceError(error)
      if (diagnosis) {
        return reply.code(diagnosis.status).send({ error: diagnosis.message })
      }
      if (error instanceof UnsupportedWebSourceError) {
        return reply.code(400).send({ error: 'Unsupported web source URL' })
      }
      if (error instanceof WebSourceTooLargeError) {
        return reply.code(400).send({ error: error.message })
      }
      req.log.error({ error }, 'Web source creation failed')
      return reply.code(500).send({ error: 'Web source creation failed' })
    }
  })

  app.post('/api/web-sources/:bookId/refresh', { preHandler: authHook }, async (req, reply) => {
    if (!opts.webSourceService.refreshFromSource) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const { bookId } = req.params as { bookId: string }
    try {
      return reply.code(200).send(
        await opts.webSourceService.refreshFromSource(req.userId, bookId),
      )
    } catch (error) {
      if (error instanceof WebSourceNotFoundError) {
        return reply.code(404).send({ error: 'Web source book not found' })
      }
      const diagnosis = diagnoseWebSourceError(error)
      if (diagnosis) {
        return reply.code(diagnosis.status).send({ error: diagnosis.message })
      }
      if (error instanceof UnsupportedWebSourceError) {
        return reply.code(400).send({ error: 'Unsupported web source URL' })
      }
      if (error instanceof WebSourceRefreshConflictError) {
        return reply.code(409).send({ error: 'Web source manifest changed; try again' })
      }
      if (error instanceof WebSourceTooLargeError) {
        return reply.code(400).send({ error: error.message })
      }
      req.log.error({ error }, 'Web source refresh failed')
      return reply.code(500).send({ error: 'Web source refresh failed' })
    }
  })

  app.post('/api/web-sources/:bookId/supplements/preview', { preHandler: authHook }, async (req, reply) => {
    if (!opts.webSourceService.previewSupplements) return reply.code(404).send({ error: 'Not found' })
    const { bookId } = req.params as { bookId: string }
    try {
      return reply.code(200).send(await opts.webSourceService.previewSupplements(req.userId, bookId))
    } catch (error) {
      const diagnosis = diagnoseSupplementError(error)
      if (diagnosis) return reply.code(diagnosis.status).send({ error: diagnosis.message })
      req.log.error({ error }, 'Web source supplement preview failed')
      return reply.code(500).send({ error: 'Web source supplement preview failed' })
    }
  })

  app.post('/api/web-sources/:bookId/supplements/apply', { preHandler: authHook }, async (req, reply) => {
    if (!opts.webSourceService.applySupplements) return reply.code(404).send({ error: 'Not found' })
    const { bookId } = req.params as { bookId: string }
    const previewToken = readPreviewToken(req.body)
    const candidateIds = readStringArray(req.body, 'candidateIds', MAX_SUPPLEMENT_CANDIDATE_IDS)
    const manualPlacements = readManualPlacements(req.body)
    if (!previewToken || !candidateIds || !manualPlacements || (candidateIds.length === 0 && manualPlacements.length === 0)) {
      return reply.code(400).send({ error: 'previewToken and a chapter selection are required' })
    }
    try {
      return reply.code(200).send(
        await opts.webSourceService.applySupplements(req.userId, bookId, {
          previewToken, candidateIds, ...(manualPlacements.length ? { manualPlacements } : {}),
        }),
      )
    } catch (error) {
      const diagnosis = diagnoseSupplementError(error)
      if (diagnosis) return reply.code(diagnosis.status).send({ error: diagnosis.message })
      req.log.error({ error }, 'Web source supplement apply failed')
      return reply.code(500).send({ error: 'Web source supplement apply failed' })
    }
  })

  app.post('/api/web-sources/:bookId/supplements/undo', { preHandler: authHook }, async (req, reply) => {
    if (!opts.webSourceService.undoSupplements) return reply.code(404).send({ error: 'Not found' })
    const { bookId } = req.params as { bookId: string }
    const batchId = readOptionalBatchId(req.body)
    // A malformed batchId must never fall back to "undo the latest batch".
    if (batchId === null) return reply.code(400).send({ error: 'Invalid batchId' })
    try {
      return reply.code(200).send(await opts.webSourceService.undoSupplements(req.userId, bookId, batchId))
    } catch (error) {
      const diagnosis = diagnoseSupplementError(error)
      if (diagnosis) return reply.code(diagnosis.status).send({ error: diagnosis.message })
      req.log.error({ error }, 'Web source supplement undo failed')
      return reply.code(500).send({ error: 'Web source supplement undo failed' })
    }
  })

  app.get('/api/web-sources/:bookId/chapters', { preHandler: authHook }, async (req, reply) => {
    if (!opts.webSourceService.readChapterWindow) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const { bookId } = req.params as { bookId: string }
    const query = req.query as { center?: string; before?: string; after?: string; refresh?: string }
    const center = readNonNegativeInteger(query.center, 0)
    const before = readNonNegativeInteger(query.before, 3)
    const after = readNonNegativeInteger(query.after, 3)

    try {
      const chapterWindow = await opts.webSourceService.readChapterWindow(req.userId, bookId, {
        center,
        before,
        after,
        ...(query.refresh === '1' ? { refresh: true } : {}),
      })
      return reply.code(200).send(chapterWindow)
    } catch (error) {
      const diagnosis = diagnoseWebSourceError(error)
      if (diagnosis) {
        req.log.warn({
          err: error,
          bookId,
          ...(error instanceof WebSourceHttpError
            ? { upstreamStatus: error.statusCode, retryAfterMs: error.retryAfterMs }
            : {}),
        }, 'Web source chapter window upstream failure')
        return reply.code(diagnosis.status).send({ error: diagnosis.message })
      }
      if (error instanceof UnsupportedWebSourceError) {
        return reply.code(400).send({ error: 'Unsupported web source URL' })
      }
      req.log.error({ error }, 'Web source chapter window failed')
      return reply.code(500).send({ error: 'Web source chapter window failed' })
    }
  })
}

function readUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('url' in body)) return null
  const value = (body as { url: unknown }).url
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readPreviewToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('previewToken' in body)) return null
  const value = (body as { previewToken: unknown }).previewToken
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Distinct non-empty strings in first-seen order; null when malformed or over `max`. */
function readStringArray(body: unknown, field: string, max: number): string[] | null {
  if (typeof body !== 'object' || body === null || !(field in body)) return null
  const value = (body as Record<string, unknown>)[field]
  if (!Array.isArray(value) || value.length > max) return null
  if (!value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 200)) return null
  return [...new Set(value as string[])]
}

function readManualPlacements(body: unknown): Array<{ id: string; insertAfterIndex: number }> | null {
  if (typeof body !== 'object' || body === null || !('manualPlacements' in body)) return []
  const value = (body as { manualPlacements: unknown }).manualPlacements
  if (!Array.isArray(value) || value.length > MAX_SUPPLEMENT_CANDIDATE_IDS) return null
  if (!value.every(item => item && typeof item === 'object'
    && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 200
    && Number.isInteger(item.insertAfterIndex) && item.insertAfterIndex >= -1)) return null
  return value as Array<{ id: string; insertAfterIndex: number }>
}

/** undefined = absent (undo latest); null = present but malformed. */
function readOptionalBatchId(body: unknown): string | undefined | null {
  if (typeof body !== 'object' || body === null || !('batchId' in body)) return undefined
  const value = (body as Record<string, unknown>).batchId
  if (value === undefined) return undefined
  return typeof value === 'string' && BATCH_ID_PATTERN.test(value) ? value : null
}

function readTitle(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('title' in body)) return null
  const value = (body as { title: unknown }).title
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}
