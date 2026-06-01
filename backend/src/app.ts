import Fastify, { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import type Database from 'better-sqlite3'
import { authHook } from './auth.js'

interface BuildAppOptions {
  fileSizeLimit?: number
}

export function buildApp(
  db?: Database.Database,
  uploadsDir?: string,
  options?: BuildAppOptions,
): FastifyInstance {
  const fileSizeLimit = options?.fileSizeLimit ?? 20 * 1024 * 1024

  const app = Fastify({ logger: false })

  app.register(multipart, {
    limits: { fileSize: fileSizeLimit },
  })

  app.get('/healthz', async () => {
    return { status: 'ok' }
  })

  app.get('/me', { preHandler: authHook }, async (req) => {
    return { userId: req.userId }
  })

  if (db) {
    app.register(async (instance) => {
      const { syncRoutes } = await import('./routes/sync.js')
      await instance.register(syncRoutes, { db })
    })
  }

  if (db && uploadsDir) {
    app.register(
      async (instance) => {
        const { booksRoutes } = await import('./routes/books.js')
        await instance.register(booksRoutes, { db, uploadsDir })
      },
    )
  }

  return app
}
