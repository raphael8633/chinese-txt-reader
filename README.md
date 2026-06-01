# Raph Reader

Long-form Chinese TXT reader built as a web/PWA app. It supports a cloud library, explicit offline copies, local-first reading settings, best-effort progress sync, virtualized rendering, and automatic TXT encoding detection for UTF-8, Big5, and GB18030/GBK.

## Features

- Upload `.txt` books up to 20MB.
- Normalize uploaded text to UTF-8 while preserving the original file.
- Split content into chapters and paragraphs with consistent backend/frontend parsing rules.
- Store progress by `chapter_index` to avoid drift when paragraph parsing changes.
- Stream book content from the API and render long books with virtualization.
- Save reading settings globally, with backend support for per-book overrides.
- Download books into IndexedDB chunk storage for offline reading.
- Installable PWA shell with manual app update prompts.

## Quick Start

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

Open `http://127.0.0.1:5174/reader/`.

## Commands

```bash
npm run build
npm run lint
npm run test
```

## Project Structure

- `backend/`: Fastify + SQLite API.
- `frontend/`: React + Vite + Tailwind + Dexie PWA.
- `docs/current-state.md`: implementation notes and known follow-up work.
- `docs/product-scope.md`: product goals, MVP scope, and roadmap notes.
- `docs/plans/`: archived implementation plans that are useful as design background.

## Auth Model

Raph Reader expects authentication to be handled by an upstream reverse proxy or auth gateway in production. The backend reads a user id from trusted proxy headers and uses it to isolate each user's library.

For local development, the backend falls back to `dev-user` so the app can run without a full auth stack.

When a session expires, API helpers throw `AuthExpiredError`. Pages should show an offline/expired-session state and let the user manually return to the auth gateway. Do not automatically redirect to a followed fetch URL, because that URL may point at an API endpoint rather than the reader app.

## Deployment Notes

This public tree intentionally excludes host-specific operations material and live-test credentials. A typical deployment needs:

- A Node.js process for the backend API.
- A static or preview server for the built frontend.
- A reverse proxy that maps `/reader/api/*` to the backend and `/reader/*` to the frontend.
- An auth gateway that injects a trusted user header before requests reach the backend.
- Persistent storage for SQLite data and uploaded original files outside the repository checkout.
