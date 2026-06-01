# ReaderPage — Phase 1: Dependency + Backend（已完成）

> Historical execution summary. New sessions normally do not need this file.

## 目標

安裝 `@tanstack/react-virtual`，並新增 backend progress/settings API。

## 完成內容

- Installed `@tanstack/react-virtual` for frontend virtual rendering.
- Added `backend/src/routes/sync.ts`。
- Registered sync routes in `backend/src/app.ts`。
- Added `backend/src/tests/sync.test.ts`。

## API

- `GET /api/books/:id/progress`
- `POST /api/books/:id/progress`
- `GET /api/settings`
- `POST /api/settings`

## 實作備註

- 使用既有 SQLite tables：`reader_settings`、`reading_progress`。
- Fastify v5 hook/handler 不需要 callback-style `done`。
- `better-sqlite3` 是 sync API，在 async handler 中直接呼叫。

## 狀態

Completed and merged. Current behavior details should be read from source/tests, not this historical plan.
