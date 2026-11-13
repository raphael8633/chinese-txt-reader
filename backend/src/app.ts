import Fastify, { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import type Database from 'better-sqlite3'
import { authHook } from './auth.js'
import { SafeFetchService } from './services/fetch/SafeFetchService.js'
import { WebSourceService } from './services/web-source/WebSourceService.js'
import { createWebSourceProviders } from './services/web-source/providerRegistry.js'

type WebSourceAppService =
  Pick<WebSourceService, 'createFromChapterListUrl'>
  & Partial<Pick<
    WebSourceService,
    | 'readBookText'
    | 'readChapterWindow'
    | 'refreshFromSource'
    | 'search'
    | 'listProviders'
    | 'previewChapterListUrl'
    | 'previewSupplements'
    | 'applySupplements'
    | 'undoSupplements'
  >>

interface BuildAppOptions {
  fileSizeLimit?: number
  webSourceService?: WebSourceAppService
}

export function buildApp(
  db?: Database.Database,
  uploadsDir?: string,
  options?: BuildAppOptions,
): FastifyInstance {
  const fileSizeLimit = options?.fileSizeLimit ?? 20 * 1024 * 1024

  const app = Fastify({
    logger: process.env.NODE_ENV === 'production' ? { level: 'warn' } : false,
  })

  app.register(multipart, {
    limits: { fileSize: fileSizeLimit },
  })

  app.get('/healthz', async () => {
    return { status: 'ok' }
  })

  app.get('/api/me', { preHandler: authHook }, async (req) => {
    return { userId: req.userId }
  })

  const webSourceService = options?.webSourceService ?? (db ? createWebSourceService(db) : null)

  if (db) {
    app.register(async (instance) => {
      const { syncRoutes } = await import('./routes/sync.js')
      await instance.register(syncRoutes, { db })
      const { sharedProgressRoutes } = await import('./routes/sharedProgress.js')
      await instance.register(sharedProgressRoutes, { db })
    })
  }

  if (db && uploadsDir) {
    app.register(
      async (instance) => {
        const { booksRoutes } = await import('./routes/books.js')
        await instance.register(booksRoutes, {
          db,
          uploadsDir,
          webSourceService: webSourceService?.readBookText
            ? { readBookText: (userId, bookId) => webSourceService.readBookText!(userId, bookId) }
            : undefined,
        })
      },
    )
  }

  if (webSourceService) {
    app.register(async (instance) => {
      const { webSourceRoutes } = await import('./routes/webSources.js')
      await instance.register(webSourceRoutes, { webSourceService })
    })
  }

  return app
}

function createWebSourceService(db: Database.Database): WebSourceService {
  const safeFetch = new SafeFetchService()
  const service = new WebSourceService({
    db,
    fetchConcurrency: Number(process.env.RAPH_READER_WEB_SOURCE_FETCH_CONCURRENCY ?? '4'),
    providers: createWebSourceProviders(safeFetch),
  })
  // Web books created before provider_id existed resolve their provider by URL on
  // every read; fill the column once at startup so the fallback stays cold.
  service.backfillProviderIds((message) => console.info(message))
  return service
}
