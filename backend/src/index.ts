import { buildApp } from './app.js'
import { initDb } from './db.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.RAPH_READER_DATA_DIR ?? join(__dirname, '..', 'data')
const uploadsDir = process.env.RAPH_READER_UPLOADS_DIR ?? join(__dirname, '..', 'uploads')
const dbPath = process.env.RAPH_READER_DB_PATH ?? join(dataDir, 'raph-reader.db')

const { mkdirSync } = await import('node:fs')
mkdirSync(dataDir, { recursive: true })
mkdirSync(dirname(dbPath), { recursive: true })
mkdirSync(uploadsDir, { recursive: true })

const db = initDb(dbPath)

const app = buildApp(db, uploadsDir)
const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? '3005')

await app.listen({ port, host })
console.log(`Backend listening on ${host}:${port}`)
